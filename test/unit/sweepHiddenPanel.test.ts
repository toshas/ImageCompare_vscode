import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { planThumbnails, runThumbnailSweep, SWEEP_CHUNK, SWEEP_REQUEUE, ThumbnailBytes } from '../../src/thumbnailPlan';
import { Priority, TaskCancelled, WorkPool } from '../../src/workPool';
import { ExtensionMessage } from '../../src/types';

// A tab the user switched away from used to keep sweeping at full rate, competing for the same 4 bulk
// slots as the tab in focus. Pausing is a DEFERRAL, never a cancellation: every slot the paused sweep
// still owes is delivered once the panel comes back, and the two ways a paused sweep could hang — a
// pause before its first dispatch, and a dispose while paused — are pinned here, because a sweep that
// never resolves holds the wire claim for the life of the extension host.
// (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels, sweep-covers-every-slot-once)

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** Bulk slots the pool grants at width 5: speculation collectively leaves one slot free. */
const BULK_SLOTS = 4;

function grid(tuples: number, mods: number) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.map(m => ({ modality: m, name: `${t}_${m}.png` })),
  }));
  return { rows, modalities };
}

const jpeg = (): ThumbnailBytes => ({ bytes: new Uint8Array(4), mime: 'image/jpeg' });

interface SweepRig {
  io: { makeThumbnail: (item: { tupleIndex: number; modalityIndex: number }) => Promise<ThumbnailBytes | null | typeof SWEEP_REQUEUE>; dropQueued: () => void };
  post: (m: ExtensionMessage) => void;
  delivered: string[];
  hidden: boolean;
  closed: boolean;
  repump?: () => void;
}

/** One panel's sweep IO over a shared pool, wired exactly as the provider wires it. */
function sweepRig(pool: WorkPool, name: string, started: string[], release: Array<() => void>): SweepRig {
  const rig: SweepRig = {
    delivered: [],
    hidden: false,
    closed: false,
    post: (m: ExtensionMessage) => {
      if (m.type === 'thumbnail') rig.delivered.push(`${m.tupleIndex}-${m.modalityIndex}`);
    },
    io: {
      makeThumbnail: item =>
        pool
          .submit(
            () =>
              new Promise<ThumbnailBytes>(resolve => {
                started.push(name);
                release.push(() => resolve(jpeg()));
              }),
            { priority: Priority.THUMBNAIL_BULK, key: `${name}-sweep`, group: name }
          )
          .catch(error => {
            if (error instanceof TaskCancelled) return rig.closed ? null : SWEEP_REQUEUE;
            throw error;
          }),
      dropQueued: () => pool.cancel(`${name}-sweep`),
    },
  };
  return rig;
}

function startSweep(rig: SweepRig, rows: ReturnType<typeof grid>['rows'], modalities: string[]): Promise<void> {
  return runThumbnailSweep(planThumbnails(rows, modalities), rig.io, rig.post, {
    centre: () => 0,
    abandoned: () => rig.closed,
    paused: () => rig.hidden,
    onRepump: repump => { rig.repump = repump; },
  });
}

/** Release every read the pool has running, until nothing new is dispatched — one batch per round. */
async function drain(release: Array<() => void>, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(2);
    if (release.length === 0) {
      await settle(4);
      if (release.length === 0) return;
    }
    for (const r of release.splice(0)) r();
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sweep did not settle in ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

describe('sweep runner: a hidden panel yields the pool to the tab in focus', () => {
  it('stops taking bulk slots within one running batch, and the visible tab gets them all', async () => {
    const pool = new WorkPool(5);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(40, 4);

    const hiddenTab = sweepRig(pool, 'hidden', started, release);
    const sweepHidden = startSweep(hiddenTab, rows, modalities);
    await settle();
    expect(started.length).toBe(BULK_SLOTS);

    // The user opens a second comparison: the first tab is now hidden and the second is in focus.
    hiddenTab.hidden = true;
    const focused = sweepRig(pool, 'focused', started, release);
    const sweepFocused = startSweep(focused, rows, modalities);
    await settle(2);
    const hiddenAt = started.length;

    for (let i = 0; i < 10; i++) {
      for (const r of release.splice(0)) r();
      await settle(2);
    }
    const after = started.slice(hiddenAt);
    expect(after.length).toBeGreaterThan(20);
    // The pool starts what it had already queued for the hidden tab before the pause reaches the
    // pump, so the bound is one running batch; a single FIFO gave it half of every batch after that.
    expect(after.filter(n => n === 'hidden').length, `hidden tab kept reading: ${after.length} reads`).toBeLessThanOrEqual(BULK_SLOTS);
    expect(after.filter(n => n === 'focused').length).toBeGreaterThan(after.length - BULK_SLOTS - 1);

    // Nothing was lost: the hidden tab's grid is still owed, and the visible one is progressing.
    expect(focused.delivered.length).toBeGreaterThan(0);
    expect(hiddenTab.delivered.length).toBeLessThan(40 * 4);

    hiddenTab.closed = true;
    focused.closed = true;
    hiddenTab.io.dropQueued();
    focused.io.dropQueued();
    hiddenTab.repump?.();
    await drain(release);
    await withDeadline(Promise.all([sweepHidden, sweepFocused]), 5000);
  });

  it('delivers every owed slot exactly once when the panel comes back', async () => {
    const pool = new WorkPool(5);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(20, 3);
    const rig = sweepRig(pool, 'tab', started, release);
    const sweep = startSweep(rig, rows, modalities);
    await settle();

    rig.hidden = true;
    rig.repump!();
    await drain(release);
    const readsWhilePaused = started.length;
    expect(readsWhilePaused).toBeLessThan(60);
    for (let i = 0; i < 5; i++) {
      for (const r of release.splice(0)) r();
      await settle(2);
    }
    expect(started.length, 'a paused sweep dispatched more work').toBe(readsWhilePaused);
    expect(rig.delivered.length).toBeLessThan(60);

    rig.hidden = false;
    rig.repump!();
    await drain(release);
    await withDeadline(sweep, 5000);
    expect(rig.delivered.length).toBe(60);
    expect(new Set(rig.delivered).size).toBe(60);
  });

  it('a sweep paused before its first dispatch waits for the resume instead of finishing empty', async () => {
    const pool = new WorkPool(5);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(6, 2);
    const rig = sweepRig(pool, 'tab', started, release);
    rig.hidden = true;
    let resolved = false;
    const sweep = startSweep(rig, rows, modalities).then(() => { resolved = true; });
    await settle(6);
    expect(started.length, 'a paused sweep dispatched at start').toBe(0);
    expect(resolved, 'a paused sweep resolved with the grid uncovered').toBe(false);

    rig.hidden = false;
    rig.repump!();
    await drain(release);
    await withDeadline(sweep, 5000);
    expect(rig.delivered.length).toBe(12);
  });

  it('a dispose while paused still ends the sweep, instead of hanging with its claim held', async () => {
    const pool = new WorkPool(5);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(20, 3);
    const rig = sweepRig(pool, 'tab', started, release);
    const sweep = startSweep(rig, rows, modalities);
    await settle();
    rig.hidden = true;
    rig.repump!();
    await drain(release);
    expect(release.length, 'the paused sweep still has work in flight').toBe(0);

    // Panel disposed with the sweep quiescent: nothing will settle, so the host's resume is the only exit.
    rig.closed = true;
    rig.io.dropQueued();
    rig.repump!();
    await withDeadline(sweep, 2000);
  });
});

// ── The provider half: the panel's own visibility drives it ──

const tmpRoots: string[] = [];
const rigs: ProviderRig[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
afterEach(async () => {
  for (const rig of rigs) {
    rig.state.disposed = true;
    (rig.provider as any).pool.cancel(`${rig.state.poolKey}-sweep`);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
  }
  rigs.length = 0;
  await settle(5);
  __resetConfig();
  __setRemoteName(undefined);
});

const MODALITIES = ['gt', 'ours'];
const TUPLES = 30;

interface ProviderRig {
  provider: any;
  state: any;
  posts: any[];
  asked: string[];
  resolvers: Array<() => void>;
}

function makeProviderRig(): ProviderRig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-hidden-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', 5);
  const posts: any[] = [];
  const asked: string[] = [];
  const resolvers: Array<() => void> = [];
  const rig: ProviderRig = { provider: undefined, state: undefined, posts, asked, resolvers };
  rigs.push(rig);

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(uri.path);
        resolvers.push(() => resolve(Buffer.alloc(4)));
      }),
    loadFullImage: async () => ({ bytes: new Uint8Array(10), mime: 'image/png', width: 4, height: 4 }),
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    }),
    thumbPackLoadStat: () => ({ count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 })
  };

  const name = (t: number) => `frame${String(t).padStart(2, '0')}`;
  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: name(t),
    images: MODALITIES.map(m => ({ uri: Uri.file(`/${root.replace(/\W/g, '')}/${m}/${name(t)}.png`), name: `${name(t)}.png`, modality: m }))
  }));

  rig.provider = provider;
  rig.state = {
    panel: { webview: { postMessage: (msg: any) => { posts.push(msg); return Promise.resolve(true); } } },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(MODALITIES.map(m => [m, Uri.file(`/imgs/${m}`)])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    poolKey: `hidden-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    watchedDirs: new Set<string>(),
    fileWatchers: [],
    nodeWatchers: [],
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(8, 'ssh-remote'))
  };
  return rig;
}

async function releaseBatch(rig: ProviderRig): Promise<void> {
  for (const r of rig.resolvers.splice(0)) r();
  await settle(4);
}

/** Release batch after batch until the panel dispatches nothing new — the sweep's own pace. */
async function drainPanel(rig: ProviderRig, rounds = 500): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(4);
    if (rig.resolvers.length === 0) {
      await settle(6);
      if (rig.resolvers.length === 0) return;
    }
    for (const r of rig.resolvers.splice(0)) r();
  }
}

describe('provider: switching away from a comparison pauses its sweep, switching back resumes it', () => {
  it('reads nothing more while hidden and finishes every slot exactly once when shown again', async () => {
    const rig = makeProviderRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    expect(rig.asked.length).toBe(BULK_SLOTS);

    rig.provider.setPanelVisible(rig.state, false);
    await drainPanel(rig);
    const readsWhileHidden = rig.asked.length;
    expect(readsWhileHidden).toBeLessThan(TUPLES * MODALITIES.length);
    for (let i = 0; i < 5; i++) await releaseBatch(rig);
    expect(rig.asked.length, 'a hidden panel kept reading thumbnails').toBe(readsWhileHidden);
    expect((rig.provider as any).pool.pending).toBe(0);

    // Back in focus: the rest of the grid is delivered, each slot exactly once.
    rig.provider.setPanelVisible(rig.state, true);
    await drainPanel(rig);
    await settle(20);
    const slots = rig.posts.filter(p => p.type === 'thumbnail').map(p => `${p.tupleIndex}-${p.modalityIndex}`);
    expect(slots.length).toBe(TUPLES * MODALITIES.length);
    expect(new Set(slots).size).toBe(TUPLES * MODALITIES.length);
    const progress = rig.posts.filter(p => p.type === 'thumbnailProgress');
    expect(progress[progress.length - 1]).toMatchObject({ current: 60, total: 60 });
    expect(rig.state.transport.sweepActive).toBe(false);
  });

  it('gives the wire claim back when a hidden panel is disposed, instead of holding it forever', async () => {
    const rig = makeProviderRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    rig.provider.setPanelVisible(rig.state, false);
    await drainPanel(rig);
    expect(rig.resolvers.length, 'the paused sweep still has reads in flight').toBe(0);
    expect(rig.state.transport.sweepActive).toBe(true);

    // Nothing is outstanding, so no settle can end this sweep: dispose has to.
    rig.provider.disposePanel(rig.state, []);
    await settle(10);
    expect(rig.state.transport.sweepActive, 'a disposed hidden panel left the wire claimed').toBe(false);
  });

  it('gives a second comparison tab a slot in the first batch, not after the first tab\'s queued chunk', async () => {
    const first = makeProviderRig();
    first.provider.generateAllThumbnails(first.state);
    await settle();
    expect(first.asked.length).toBe(BULK_SLOTS);

    // A second comparison opens while the first is sweeping; both panels share the one process pool.
    const second = makeProviderRig();
    second.provider.generateAllThumbnails(second.state);
    await settle();
    expect(second.asked.length, 'the pool was already saturated by the first tab').toBe(0);

    const releaseAll = async (): Promise<void> => {
      for (const r of [...first.resolvers.splice(0), ...second.resolvers.splice(0)]) r();
      await settle(4);
    };
    let rounds = 0;
    while (second.asked.length === 0 && rounds++ < 40) await releaseAll();
    // One FIFO made this 8 rounds: the second tab queued behind the first tab's 28 dispatches.
    expect(rounds, `second tab waited ${rounds} batches`).toBeLessThanOrEqual(1);

    for (let i = 0; i < 8; i++) await releaseAll();
    const share = second.asked.length / (first.asked.length + second.asked.length);
    expect(share, `second tab got ${(share * 100).toFixed(0)}% of the reads`).toBeGreaterThan(0.35);
  });

  it('the sweep\'s chunk is the whole cost of hiding: at most one running batch keeps going', async () => {
    const rig = makeProviderRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    expect((rig.provider as any).pool.pending).toBe(SWEEP_CHUNK - BULK_SLOTS);

    // The queued dispatches go back to the cursor rather than draining at the old rate.
    rig.provider.setPanelVisible(rig.state, false);
    await settle(4);
    expect((rig.provider as any).pool.pending).toBe(0);
    expect(rig.resolvers.length).toBe(BULK_SLOTS);
  });
});
