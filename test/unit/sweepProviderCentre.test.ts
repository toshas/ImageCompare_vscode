import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';
import { LOAD_DEBOUNCE_MS } from '../../src/webview/tupleLoadPlan';

// The host half of the centre-out sweep, on the REAL provider: it supplies `the shared aim policy` as the
// sweep's centre and must read it LIVE, since a settled `setCurrentTuple` mutates that field while the
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

// Navigation as the panel really receives it: the message handler, then the dwell the sweep's centre
// waits out before it re-aims (docs/loading-architecture.md: sweep-centre-dwells).
async function navigate(rig: Rig, tupleIndex: number): Promise<void> {
  await rig.provider.handlePanelMessage(rig.state, { type: 'setCurrentTuple', tupleIndex });
  await new Promise(r => setTimeout(r, LOAD_DEBOUNCE_MS + 20));
}

interface Rig {
  provider: any;
  state: any;
  posts: any[];
  /** Rows getThumbnail has been called for, in call order. */
  asked: number[];
  /** The same calls as `modality-row`, so the COLUMN the sweep aims at is visible too. */
  askedSlots: string[];
  resolvers: Array<() => void>;
  maxConcurrent: number;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-centre-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const posts: any[] = [];
  const asked: number[] = [];
  const askedSlots: string[] = [];
  const resolvers: Array<() => void> = [];
  const rig: Rig = { provider: undefined, state: undefined, posts, asked, askedSlots, resolvers, maxConcurrent: 0 };
  rigs.push(rig);
  let live = 0;

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(Number(/frame(\d+)/.exec(uri.path)![1]));
        askedSlots.push(`${/imgs\/([^/]+)\//.exec(uri.path)![1]}-${/frame(\d+)/.exec(uri.path)![1]}`);
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
    sweepAim: newSweepAimPolicy(),
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
    // The tile the panel opened on and its row's other modality, then the rows either side of it in
    // that same column — not row 0, which scanline order would have taken.
    expect(rig.asked.slice(0, 6)).toEqual([20, 20, 21, 19, 22, 18]);
  });

  it('aims at the column the webview reports, translated out of display space', async () => {
    const rig = makeRig();
    // The strip as the user rearranged it: ['ours', 'gt'], with the user on display position 0 —
    // which is ORIGINAL modality 1. A host that passed the display index on would aim at 'gt'.
    await rig.provider.handlePanelMessage(rig.state, {
      type: 'tupleFullyLoaded',
      tupleIndex: OPEN_AT,
      modalityOrder: [1, 0],
      currentDisplayIndex: 0,
      hiddenModalities: []
    });
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // The focused tile, its row's other column, then that same column in the rows either side.
    expect(rig.askedSlots.slice(0, 4)).toEqual([`ours-${OPEN_AT}`, `gt-${OPEN_AT}`, `ours-${OPEN_AT + 1}`, `ours-${OPEN_AT - 1}`]);
  });

  it('stops the cross at the screenful the webview reported, then fills row-major', async () => {
    const rig = makeRig();
    // A carousel one row tall: the cross may reach exactly one row either side of the focused tile.
    await rig.provider.handlePanelMessage(rig.state, {
      type: 'tupleFullyLoaded',
      tupleIndex: OPEN_AT,
      modalityOrder: [0, 1],
      currentDisplayIndex: 0,
      hiddenModalities: [],
      visibleRows: 1
    });
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // Cross: the tile, its row's other modality, rows 21 and 19 in that column — and stop. Then
    // row-major centre-out: the rest of 21, the rest of 19, then rows 22 and 18 whole.
    expect(rig.asked.slice(0, 10)).toEqual([20, 20, 21, 19, 21, 19, 22, 22, 18, 18]);
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

    // The real message path, dwell included; the sweep must read the new centre on its next dispatch.
    await navigate(rig, JUMP_TO);
    for (const r of rig.resolvers.splice(0, 4)) r();
    await settle();
    // The cross from (3, gt): the tile itself, its row's other modality, then rows 4 and 2 in that
    // column — row 3 was outside the radius of the aim the panel opened on, so it is untouched.
    expect(rig.asked.slice(dispatchedBefore, dispatchedBefore + 4)).toEqual([3, 3, 4, 2]);

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
