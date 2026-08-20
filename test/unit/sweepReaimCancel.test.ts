import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { Priority } from '../../src/workPool';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';

// The host half of cancel-on-re-aim, on the REAL provider and the REAL shared pool, at the shape the
// field log recorded: width 5 leaves the bulk class 4 running slots (`run=[0,0,0,0,0,4,0,0]`), so the
// other 28 of the chunk sit queued (`queued=[0,0,0,0,0,28,0,6]`). At ~1.6 s per thumbnail those 28
// were ~13 s of lag after a jump; the queue must go with the centre, and nothing else on the panel's
// key may go with it. The pool is a module singleton, so this file — not sweepProviderCentre.test.ts,
// which needs a wide pool — is where a narrow one can be configured.
// (docs/loading-architecture.md: sweep-cancels-on-reaim, sweep-covers-every-slot-once)

const MODALITIES = ['gt', 'ours'];
const TUPLES = 30;
const OPEN_AT = 20;
const JUMP_TO = 3;
/** Bulk slots the pool grants at width 5: speculation collectively leaves one slot free. */
const BULK_SLOTS = 4;

const tmpRoots: string[] = [];
const rigs: Rig[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
afterEach(async () => {
  for (const rig of rigs) {
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

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Rig {
  provider: any;
  state: any;
  posts: any[];
  /** Rows the pool STARTED a thumbnail read for, in start order — a cancelled slot never appears. */
  asked: number[];
  /** The same reads as `modality-row`, so "no slot was read twice" is checkable. */
  askedKeys: string[];
  resolvers: Array<() => void>;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-cancel-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', 5);
  const posts: any[] = [];
  const asked: number[] = [];
  const askedKeys: string[] = [];
  const resolvers: Array<() => void> = [];
  const rig: Rig = { provider: undefined, state: undefined, posts, asked, askedKeys, resolvers };
  rigs.push(rig);

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(Number(/frame(\d+)/.exec(uri.path)![1]));
        askedKeys.push(uri.path);
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
    images: MODALITIES.map(m => ({ uri: Uri.file(`/imgs/${m}/${name(t)}.png`), name: `${name(t)}.png`, modality: m }))
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
    currentTupleIndex: OPEN_AT,
    disposed: false,
    visible: true,
    poolKey: `cancel-${Math.random().toString(36).slice(2)}`,
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

/** Releases every read the pool currently has running: exactly one batch of work. */
async function releaseBatch(rig: Rig): Promise<void> {
  for (const r of rig.resolvers.splice(0)) r();
  await settle(4);
}

describe('a re-aimed provider sweep drops the work it has already queued', () => {
  it('serves the row the user jumped to after one running batch, not after the whole queued chunk', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // 32 dispatched; only the pool's 4 bulk slots are reading, the rest are queued behind them.
    expect(rig.asked).toEqual([OPEN_AT, OPEN_AT, OPEN_AT + 1, OPEN_AT + 1]);
    expect((rig.provider as any).pool.pending).toBe(SWEEP_CHUNK - BULK_SLOTS);

    // What the setCurrentTuple handler does to the panel state, with all 32 slots outstanding.
    rig.state.currentTupleIndex = JUMP_TO;
    let guard = 0;
    while (!rig.asked.slice(BULK_SLOTS).includes(JUMP_TO) && guard++ < 20) await releaseBatch(rig);
    // Old-centre tiles the user still waits through: at most the batch that was already running.
    const waited = rig.asked.slice(BULK_SLOTS).indexOf(JUMP_TO);
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(waited).toBeLessThanOrEqual(BULK_SLOTS);

    guard = 0;
    while (rig.resolvers.length && guard++ < 500) await releaseBatch(rig);
    await settle(20);

    // Cancelled work is re-dispatched, never lost and never done twice.
    const thumbs = rig.posts.filter(p => p.type === 'thumbnail');
    const slots = thumbs.map(p => `${p.tupleIndex}-${p.modalityIndex}`);
    expect(slots.length).toBe(TUPLES * MODALITIES.length);
    expect(new Set(slots).size).toBe(TUPLES * MODALITIES.length);
    expect(rig.asked.length).toBe(TUPLES * MODALITIES.length);
    const progress = rig.posts.filter(p => p.type === 'thumbnailProgress');
    expect(progress[progress.length - 1]).toMatchObject({ current: 60, total: 60 });
    // The wire claim is still released exactly once, though a re-aim cancelled work mid-flight
    // (docs/loading-architecture.md: speculation-yields-the-wire).
    expect(rig.state.transport.sweepActive).toBe(false);
  });

  it('drops only the sweep\'s own queue — the panel\'s other pooled work on poolKey survives', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();

    // A poll task on the panel key, queued behind the saturated bulk class: the existence sweep's shape.
    let pollRan = false;
    let pollError: unknown;
    let releasePoll!: () => void;
    const poll = (rig.provider as any).pool
      .submit(() => new Promise<void>(resolve => { pollRan = true; releasePoll = resolve; }), {
        priority: Priority.POLL,
        key: rig.state.poolKey
      })
      .catch((e: unknown) => { pollError = e; });
    await settle();
    expect(pollRan).toBe(false);

    rig.state.currentTupleIndex = JUMP_TO;
    await releaseBatch(rig);
    await settle();

    // The re-aim cancelled 20+ queued thumbnail reads and left the poll task alone.
    expect(pollError).toBeUndefined();
    expect(pollRan).toBe(true);
    releasePoll();
    await poll;
    expect(pollError).toBeUndefined();

    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) await releaseBatch(rig);
    await settle(20);
    const slots = rig.posts.filter(p => p.type === 'thumbnail').map(p => `${p.tupleIndex}-${p.modalityIndex}`);
    expect(new Set(slots).size).toBe(TUPLES * MODALITIES.length);
  });

  it('stops reading the grid the moment the panel is disposed, instead of sweeping it for a dead window', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    expect(rig.asked.length).toBe(BULK_SLOTS);

    // The user closes the comparison with 4 reads running and 28 queued behind them.
    rig.provider.disposePanel(rig.state, []);
    const readsAtDispose = rig.asked.length;
    await settle(10);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) await releaseBatch(rig);
    await settle(20);

    // Not one more read: the remaining 56 slots stay in the cursor, unread and unrequested. Before
    // this, every one of them was read — ~5 minutes of NFS traffic behind a window that is gone.
    expect(rig.asked.length - readsAtDispose).toBe(0);
    expect(rig.asked.length).toBe(BULK_SLOTS);
    expect((rig.provider as any).pool.pending).toBe(0);
    expect((rig.provider as any).pool.running).toBe(0);
  });

  it('settles a disposed panel\'s cancellations instead of returning them to the cursor forever', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();

    // Dispose cancels the same queued tasks a re-aim would; those slots must NOT come back, or the
    // sweep re-dispatches work whose panel is gone and never terminates.
    rig.provider.disposePanel(rig.state, []);
    await settle(10);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) await releaseBatch(rig);
    await settle(20);

    expect(rig.resolvers.length).toBe(0);
    expect((rig.provider as any).pool.pending).toBe(0);
    // Each slot was read at most once, and the 28 the dispose cancelled were never re-read.
    expect(rig.askedKeys.length).toBe(new Set(rig.askedKeys).size);
    expect(rig.askedKeys.length).toBeLessThanOrEqual(TUPLES * MODALITIES.length - (SWEEP_CHUNK - BULK_SLOTS));
  });
});
