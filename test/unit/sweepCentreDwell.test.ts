import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';
import { LOAD_DEBOUNCE_MS } from '../../src/webview/tupleLoadPlan';

// The field case, on the REAL provider and the REAL sweep runner: the user holds Down over a 315x10
// grid and every keystroke posts `setCurrentTuple`. That one message feeds two consumers with
// opposite latency needs — `cancelImageLoads` must fire on the raw signal, the sweep's centre must
// not, or the sweep re-aims on every completed thumbnail and lands tiles in a trail behind the
// cursor. The burst here is what the key repeat produces; the sweep must re-aim exactly once, after
// it ends. Fake timers, so "faster than the dwell" is a fact of the test rather than a race with the
// host's load. (docs/loading-architecture.md: sweep-centre-dwells, sweep-aims-once-per-pass)

const MODALITIES = ['gt', 'ours'];
const TUPLES = 60;
const OPEN_AT = 0;
// Rows a held key walks through, all far enough from OPEN_AT that the centre-out walk cannot reach
// them during the burst. Long enough, too, that the burst outlasts one dwell: a leading-edge dwell
// would re-aim in the middle of it, a trailing-edge one not at all.
const BURST = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49];
/** Fake-time gap between keystrokes: a key repeat, comfortably inside the dwell. */
const KEY_GAP_MS = 20;
/** Wide enough that every dispatched slot starts immediately, so what getThumbnail sees IS the dispatch order. */
const POOL_WIDTH = 64;

const tmpRoots: string[] = [];
const rigs: Rig[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
// The work pool is process-wide: a rig that left reads hung would starve the next test of slots.
afterEach(async () => {
  for (const rig of rigs) {
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    rig.restorePool();
  }
  rigs.length = 0;
  await settle(5);
  vi.useRealTimers();
  __resetConfig();
  __setRemoteName(undefined);
});

/** One round of fake time: 1 ms is past every 0 ms timer and flushes the microtasks between them. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
}

interface Rig {
  provider: any;
  state: any;
  posts: any[];
  /** Rows getThumbnail has been called for, in call order. */
  asked: number[];
  resolvers: Array<() => void>;
  /** Every pool key cancelled, in order — the sweep's key appears once per re-aim. */
  cancelled: string[];
  sweepCancels(): number;
  restorePool(): void;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-dwell-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const posts: any[] = [];
  const asked: number[] = [];
  const resolvers: Array<() => void> = [];
  const cancelled: string[] = [];

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(Number(/frame(\d+)/.exec(uri.path)![1]));
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

  // The pool is a module singleton, so the spy is installed per rig and removed in afterEach.
  const pool = (provider as any).pool;
  const realCancel = pool.cancel.bind(pool);
  pool.cancel = (key: string) => {
    cancelled.push(key);
    return realCancel(key);
  };

  const name = (t: number) => `frame${String(t).padStart(2, '0')}`;
  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: name(t),
    images: MODALITIES.map(m => ({ uri: Uri.file(`/imgs/${m}/${name(t)}.png`), name: `${name(t)}.png`, modality: m }))
  }));

  const poolKey = `dwell-${Math.random().toString(36).slice(2)}`;
  const rig: Rig = {
    provider,
    state: undefined,
    posts,
    asked,
    resolvers,
    cancelled,
    sweepCancels: () => cancelled.filter(k => k === `${poolKey}-sweep`).length,
    restorePool: () => { pool.cancel = realCancel; }
  };
  rigs.push(rig);

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
    poolKey,
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

/** One keystroke: the real message handler, then two thumbnails completing — the pumps a re-aim would ride. */
async function keystroke(rig: Rig, tupleIndex: number): Promise<void> {
  await rig.provider.handlePanelMessage(rig.state, { type: 'setCurrentTuple', tupleIndex });
  for (const r of rig.resolvers.splice(0, 2)) r();
  await settle(4);
  await vi.advanceTimersByTimeAsync(KEY_GAP_MS);
}

describe('the open-time sweep re-aims on a settled centre, not on every keystroke', () => {
  it('a held key\'s burst of setCurrentTuple re-aims the sweep exactly once, after the burst ends', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    expect(rig.asked.length).toBe(SWEEP_CHUNK);
    const dispatchedAtOpen = rig.asked.length;
    expect(rig.sweepCancels()).toBe(0);

    for (const row of BURST) await keystroke(rig, row);

    // The whole burst fits inside one dwell, so the sweep is still walking out from where it opened:
    // not one tile at the rows the key flew past, and not one drop of its queue.
    const duringBurst = rig.asked.slice(dispatchedAtOpen);
    expect(duringBurst.length).toBeGreaterThan(0);
    expect(Math.max(...duringBurst)).toBeLessThan(BURST[0]);
    expect(rig.sweepCancels()).toBe(0);

    // The key comes up: one dwell later the sweep aims at where the user actually stopped.
    await vi.advanceTimersByTimeAsync(LOAD_DEBOUNCE_MS + 5);
    const dispatchedBeforeReaim = rig.asked.length;
    for (const r of rig.resolvers.splice(0, 4)) r();
    await settle();
    expect(rig.asked.slice(dispatchedBeforeReaim, dispatchedBeforeReaim + 4)).toEqual([49, 49, 50, 50]);
    expect(rig.sweepCancels()).toBe(1);

    // The dwell reorders the sweep and nothing else: every slot still lands exactly once.
    let guard = 0;
    while (rig.resolvers.length && guard++ < 2000) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    await settle(20);
    const slots = rig.posts.filter(p => p.type === 'thumbnail').map(p => `${p.tupleIndex}-${p.modalityIndex}`);
    expect(slots.length).toBe(TUPLES * MODALITIES.length);
    expect(new Set(slots).size).toBe(TUPLES * MODALITIES.length);
    const progress = rig.posts.filter(p => p.type === 'thumbnailProgress');
    expect(progress[progress.length - 1]).toMatchObject({ current: TUPLES * MODALITIES.length, total: TUPLES * MODALITIES.length });
    expect(rig.state.transport.sweepActive).toBe(false);
  });

  it('still cancels the tuple being left on every keystroke, without waiting for the dwell', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();

    const key = (row: number) => `${rig.state.poolKey}-image-${row}`;
    // A full-image load in flight for the row the panel opened on, keyed the way sendImage keys them.
    rig.state.imageLoadKeys.add(key(OPEN_AT));

    let left = OPEN_AT;
    for (const row of BURST) {
      // The row the key is about to reach already has a speculative load of its own in flight.
      rig.state.imageLoadKeys.add(key(row));
      const before = rig.cancelled.length;
      await rig.provider.handlePanelMessage(rig.state, { type: 'setCurrentTuple', tupleIndex: row });
      // Not one tick of fake time has passed: the load for the row just left is already cancelled.
      const now = rig.cancelled.slice(before);
      expect(now).toContain(key(left));
      expect(now).not.toContain(key(row));
      expect([...rig.state.imageLoadKeys]).toEqual([key(row)]);
      left = row;
      await vi.advanceTimersByTimeAsync(KEY_GAP_MS);
    }
    // The row the user is on is the only one still loading, and the sweep never re-aimed for any of it.
    expect([...rig.state.imageLoadKeys]).toEqual([`${rig.state.poolKey}-image-${BURST[BURST.length - 1]}`]);
    expect(rig.sweepCancels()).toBe(0);
  });

  it('a hidden panel dwells without re-aiming, and aims at the settled row when it is shown', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();

    // The user switches to another tab and keeps navigating with this one hidden.
    rig.provider.setPanelVisible(rig.state, false);
    await settle();
    const askedWhenHidden = rig.asked.length;
    for (const row of BURST) await keystroke(rig, row);
    await vi.advanceTimersByTimeAsync(LOAD_DEBOUNCE_MS + 5);
    await settle();

    // The dwell fired against a paused sweep: it moved a field and dispatched nothing.
    expect(rig.asked.length).toBe(askedWhenHidden);

    rig.provider.setPanelVisible(rig.state, true);
    await settle();
    // Resumed at where the user actually is, not at the row it was walking out from when it paused.
    expect(rig.asked.slice(askedWhenHidden, askedWhenHidden + 4)).toEqual([49, 49, 50, 50]);
  });

  it('leaves no dwell pending when the panel is disposed mid-burst', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    for (const row of BURST) await keystroke(rig, row);

    // Closed with the dwell armed: nothing may fire against a dead panel, and nothing may keep the host awake.
    rig.provider.disposePanel(rig.state, []);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    await settle(10);
    const askedAtDispose = rig.asked.length;
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(LOAD_DEBOUNCE_MS * 10);
    await settle(10);
    expect(rig.asked.length).toBe(askedAtDispose);
  });
});
