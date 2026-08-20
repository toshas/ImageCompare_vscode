import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';

// The host half of the centre-out sweep, on the REAL provider: it supplies `state.currentTupleIndex`
// as the sweep's centre and must read it LIVE, since `setCurrentTuple` mutates that field while the
// sweep is draining. A snapshot taken at sweep start would pass every ordering assertion at open and
// silently never re-aim. (docs/loading-architecture.md: thumbnails-centre-out, sweep-dispatch-bounded)

const MODALITIES = ['gt', 'ours'];
const TUPLES = 30;
const OPEN_AT = 20;
const JUMP_TO = 3;
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
  /** Rows getThumbnail has been called for, in call order. */
  asked: number[];
  resolvers: Array<() => void>;
  maxConcurrent: number;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-centre-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const posts: any[] = [];
  const asked: number[] = [];
  const resolvers: Array<() => void> = [];
  const rig: Rig = { provider: undefined, state: undefined, posts, asked, resolvers, maxConcurrent: 0 };
  rigs.push(rig);
  let live = 0;

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(Number(/frame(\d+)/.exec(uri.path)![1]));
        live++;
        rig.maxConcurrent = Math.max(rig.maxConcurrent, live);
        resolvers.push(() => { live--; resolve(Buffer.alloc(4)); });
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
    poolKey: `centre-${Math.random().toString(36).slice(2)}`,
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

describe('open-time sweep aims at the provider\'s live current tuple', () => {
  it('starts at the row the panel opened on and walks outward, forward first on a tie', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // Rows 20 (both modalities), then 21, then 19 — not row 0, which scanline order would have taken.
    expect(rig.asked.slice(0, 6)).toEqual([20, 20, 21, 21, 19, 19]);
  });

  it('keeps at most SWEEP_CHUNK slots in flight, not the whole grid', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // 60 slots planned; the pool is wide enough for all of them, so the bound seen here is the sweep's own.
    expect(rig.state.scanResult.tuples.length * MODALITIES.length).toBe(60);
    expect(rig.asked.length).toBe(SWEEP_CHUNK);
    expect(rig.maxConcurrent).toBe(SWEEP_CHUNK);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    // Every wave stayed inside the bound: 60 slots swept, never more than 32 outstanding.
    expect(rig.asked.length).toBe(60);
    expect(rig.maxConcurrent).toBe(SWEEP_CHUNK);
  });

  it('re-aims mid-sweep when setCurrentTuple moves the panel, and still covers every slot exactly once', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    const dispatchedBefore = rig.asked.length;
    expect(dispatchedBefore).toBe(SWEEP_CHUNK);

    // What the setCurrentTuple handler does to the panel state; the sweep must read it on its next dispatch.
    rig.state.currentTupleIndex = JUMP_TO;
    for (const r of rig.resolvers.splice(0, 4)) r();
    await settle();
    expect(rig.asked.slice(dispatchedBefore, dispatchedBefore + 4)).toEqual([3, 3, 4, 4]);

    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    await settle(20);

    const thumbs = rig.posts.filter(p => p.type === 'thumbnail');
    const slots = thumbs.map(p => `${p.tupleIndex}-${p.modalityIndex}`);
    expect(slots.length).toBe(60);
    expect(new Set(slots).size).toBe(60);
    const progress = rig.posts.filter(p => p.type === 'thumbnailProgress');
    expect(progress[progress.length - 1]).toMatchObject({ current: 60, total: 60 });
    // The wire claim is released exactly once the re-centred sweep drains (docs/loading-architecture.md: speculation-yields-the-wire).
    expect(rig.state.transport.sweepActive).toBe(false);
  });
});
