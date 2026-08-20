import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig, __setRemoteName } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { Priority } from '../../src/workPool';

// Lifetime half of the transport policy, on the REAL provider: the sweep flag parks every
// speculative push, so any path that raises it and never lowers it switches prefetch off for the
// life of the panel, silently. The park and the burst hold are also slot-keyed like `loadedImages`,
// so a splice that re-indexes one and not the others posts a payload into another file's slot.
// (docs/loading-architecture.md: speculation-yields-the-wire, held-payloads-always-flush;
//  docs/file-watching.md: reindex-in-lockstep)

const MODALITIES = ['gt', 'ours', 'baseline'];
const TUPLES = 8;
const CENTER = 4;
/** Matches TRANSPORT_SWEEP_IDLE_TIMEOUT_MS / TRANSPORT_ACK_TIMEOUT_MS; pinned here so a silent shortening shows up. */
const WATCHDOG_MS = 30000;
/** The work-pool width these sweeps run at, pinned through `imageCompare.maxConcurrentReads`. */
const POOL_WIDTH = 16;

const tmpRoots: string[] = [];
const rigs: Rig[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
// The work pool is process-wide: a test that leaves reads hung would starve the next one of slots.
afterEach(async () => {
  vi.useRealTimers();
  for (const rig of rigs) {
    let resolve;
    while ((resolve = rig.thumbResolvers.shift())) resolve(Buffer.alloc(4));
  }
  rigs.length = 0;
  await settle(5);
  __resetConfig();
  __setRemoteName(undefined);
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface RigOptions {
  /** Tuple 0 has no `baseline` file, so the sweep's prologue posts a plan-missing error before it returns a promise. */
  missingSlot?: boolean;
  /** Read on every post: a throwing `postMessage` is what escapes the prologue synchronously. */
  postThrows?: () => boolean;
  /** Thumbnails never settle: the sweep's `Promise.all` never resolves. */
  hangThumbnails?: boolean;
  /** `postMessage` never resolves, so nothing is ever acknowledged and in-flight bytes only grow. */
  holdAcks?: boolean;
  /** Budget in MB; the default is the shipped 8. */
  budgetMB?: number;
  /** Rows in the grid; over 11 the sweep's plan outgrows one SWEEP_CHUNK, which is what an early stop can be seen against. */
  tuples?: number;
}

interface Rig {
  provider: any;
  state: any;
  posts: any[];
  thumbResolvers: Array<(v: Buffer) => void>;
  imagePosts: () => any[];
}

function image(tupleIndex: number, modalityIndex: number, tag = 1, bytes = 1000): any {
  return { type: 'image', tupleIndex, modalityIndex, bytes: new Uint8Array(bytes).fill(tag), mime: 'image/png', width: 4, height: 4 };
}

function makeRig(opts: RigOptions = {}): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-lifetime-'));
  tmpRoots.push(root);
  const posts: any[] = [];
  const thumbResolvers: Array<(v: Buffer) => void> = [];

  // How many sweep reads hang at once is the process-wide pool's width, a host property
  // (`os.availableParallelism()`) unless pinned; these assertions want a wide pool, so they say so
  // rather than inheriting the runner's core count (docs/loading-architecture.md: pool-width-hides-latency).
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = {
    getThumbnail: () =>
      opts.hangThumbnails
        ? new Promise<Buffer>(resolve => { thumbResolvers.push(resolve); })
        : Promise.resolve(Buffer.alloc(4)),
    loadFullImage: async () => ({ bytes: new Uint8Array(1000), mime: 'image/png', width: 4, height: 4 }),
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    }),
    thumbPackLoadStat: () => ({ count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 })
  };

  const tuples = Array.from({ length: opts.tuples ?? TUPLES }, (_, t) => ({
    name: `frame${String(t).padStart(2, '0')}`,
    images: MODALITIES
      .filter(m => !(opts.missingSlot && t === 0 && m === 'baseline'))
      .map(m => ({ uri: Uri.file(`/imgs/${m}/frame${String(t).padStart(2, '0')}.png`), name: `frame${String(t).padStart(2, '0')}.png`, modality: m }))
  }));

  const state: any = {
    panel: {
      webview: {
        postMessage: (msg: any) => {
          if (opts.postThrows?.()) throw new Error('Webview is disposed');
          posts.push(msg);
          return opts.holdAcks ? new Promise<boolean>(() => undefined) : Promise.resolve(true);
        }
      }
    },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(MODALITIES.map(m => [m, Uri.file(`/imgs/${m}`)])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: CENTER,
    disposed: false,
    visible: true,
    poolKey: `lifetime-${Math.random().toString(36).slice(2)}`,
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
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(opts.budgetMB ?? 8, 'ssh-remote'))
  };

  const rig: Rig = { provider, state, posts, thumbResolvers, imagePosts: () => posts.filter(p => p.type === 'image') };
  rigs.push(rig);
  return rig;
}

/** Park one speculative push per slot, the way a prefetch wave does while the sweep owns the wire. */
function park(rig: Rig, slots: Array<[number, number]>, bytes = 1000): void {
  rig.state.transport.setSweepActive(true);
  for (const [t, m] of slots) rig.provider.postImage(rig.state, image(t, m, 1, bytes), true);
}

/** Hold one user-facing off-screen push per slot, the way a scrub burst does. */
function hold(rig: Rig, slots: Array<[number, number]>): void {
  rig.state.lastTupleSwitchAt = Date.now();
  for (const [t, m] of slots) rig.provider.postImage(rig.state, image(t, m));
}

/** Release the park onto the wire and report what landed, in order: the park is FIFO, and the payload's own indices are what the webview paints. */
function drained(rig: Rig): string[] {
  rig.state.transport.setSweepActive(false);
  rig.state.lastTupleSwitchAt = 0; // not scrubbing, so a released push posts instead of joining the hold
  rig.provider.drainDeferredImagePosts(rig.state);
  return rig.imagePosts().map((p: any) => `${p.tupleIndex}-${p.modalityIndex}:${p.bytes[0]}`);
}

function heldKeys(rig: Rig): string[] {
  return [...rig.state.heldImagePosts.entries()].map(([k, v]: [string, any]) => `${k}@${v.tupleIndex}`);
}

describe('the sweep never keeps the wire past its own life', () => {
  it('releases the wire when a synchronous throw escapes the sweep prologue', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    let throwing = true;
    const rig = makeRig({ missingSlot: true, postThrows: () => throwing });

    let threw = false;
    try {
      rig.provider.generateAllThumbnails(rig.state);
    } catch {
      threw = true;
    }
    throwing = false;

    // The throw is the caller's business; the wire claim is not — it must be released either way.
    expect(threw).toBe(true);
    expect(rig.state.transport.sweepActive).toBe(false);

    // And speculation is live again: this push goes on the wire instead of parking.
    rig.provider.postImage(rig.state, image(CENTER + 1, 0), true);
    await settle(3);
    expect(rig.state.transport.deferredCount).toBe(0);
    expect(rig.imagePosts().length).toBe(1);
  });

  it('releases the wire when the sweep stops making progress, and delivers what was parked', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig({ hangThumbnails: true });

    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // One slot settles, then the sweep hangs on the rest — a stuck read, not an empty grid.
    rig.thumbResolvers.shift()?.(Buffer.alloc(4));
    await settle();
    rig.provider.postImage(rig.state, image(CENTER + 1, 0), true);
    await settle();
    expect(rig.state.transport.sweepActive).toBe(true);
    expect(rig.state.transport.deferredCount).toBe(1);
    expect(rig.imagePosts().length).toBe(0);

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1000);
    await settle();

    expect(rig.state.transport.sweepActive).toBe(false);
    expect(rig.state.transport.deferredCount).toBe(0);
    expect(rig.imagePosts().length).toBe(1);
  });

  it('ends once when a dispose abandons it: one rollup, the claim released, nothing left parked', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    // The `[IC-SWEEP] done` rollup is what marks the sweep promise as having settled; a sweep that
    // never resolves logs none, and one that ends twice logs two.
    __setConfig('debug', true);
    __resetChannels();
    disposeDebugLog();
    initDebugLog();
    try {
      // 20 rows x 3 modalities = 60 slots, comfortably more than one SWEEP_CHUNK.
      const rig = makeRig({ hangThumbnails: true, tuples: 20 });
      rig.provider.generateAllThumbnails(rig.state);
      await settle();
      park(rig, [[CENTER + 1, 0]]);
      expect(rig.state.transport.sweepActive).toBe(true);
      expect(rig.state.transport.deferredCount).toBe(1);
      const startedAtDispose = rig.thumbResolvers.length;

      rig.provider.disposePanel(rig.state, []);
      await settle();
      // Only the reads already running are left to finish; nothing is dispatched behind them.
      let guard = 0;
      let released = 0;
      while (rig.thumbResolvers.length && guard++ < 200) {
        let resolve;
        while ((resolve = rig.thumbResolvers.shift())) { resolve(Buffer.alloc(4)); released++; }
        await settle(4);
      }

      expect(released).toBe(startedAtDispose);
      expect(rig.thumbResolvers.length).toBe(0);
      expect(__channelLines('ImageCompare').filter(l => l.includes('[IC-SWEEP] done'))).toHaveLength(1);
      expect(rig.state.transport.sweepActive).toBe(false);
      expect(rig.state.transport.deferredCount).toBe(0);
      expect(rig.state.heldImagePosts.size).toBe(0);
    } finally {
      disposeDebugLog();
      __resetChannels();
    }
  });

  it('does not cut short a sweep that is still settling slots', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig({ hangThumbnails: true });

    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    park(rig, [[CENTER + 1, 0]]);

    // Well past the watchdog in total, but never idle for its length: the sweep keeps the wire.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 5000);
      rig.thumbResolvers.shift()?.(Buffer.alloc(4));
      await settle();
    }
    expect(rig.state.transport.sweepActive).toBe(true);
    expect(rig.imagePosts().length).toBe(0);
  });
});

describe('parked and held image posts move with the splice that shifts their slots', () => {
  it('a new tuple inserted ahead of them shifts both, key and payload', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();
    park(rig, [[3, 1], [5, 2], [2, 0]]);
    hold(rig, [[6, 0]]);

    // "aaa" sorts before every frameNN, so the insert lands at 0 and every existing row moves up one.
    await rig.provider.handleNewFile(rig.state, Uri.file('/imgs/gt/aaa.png'), 'aaa.png');

    expect(rig.state.scanResult.tuples[0].name).toBe('aaa');
    expect(heldKeys(rig)).toEqual(['7-0@7']);
    // A user-facing push for the parked slot's NEW key supersedes it: the key moved, not just the payload.
    rig.state.lastTupleSwitchAt = 0; // the scrub is over, so this one goes on the wire rather than into the hold
    rig.provider.postImage(rig.state, image(4, 1, 9));
    expect(drained(rig)).toEqual(['4-1:9', '6-2:1', '3-0:1']);
  });

  it('a removed tuple drops its own posts and shifts the ones behind it down', () => {
    __setRemoteName('ssh-remote');
    const rig = makeRig();
    park(rig, [[3, 1], [5, 2]]);
    hold(rig, [[3, 0], [6, 0]]);

    rig.provider.removeTuple(rig.state, 3);

    expect(heldKeys(rig)).toEqual(['5-0@5']);
    expect(drained(rig)).toEqual(['4-2:1']);
  });

  it('a modality splice drops them, exactly as it clears loadedImages', async () => {
    __setRemoteName('ssh-remote');
    const rig = makeRig();
    park(rig, [[3, 1], [5, 2]]);
    hold(rig, [[6, 0]]);

    await rig.provider.addNewModality(rig.state, 'extra');

    expect(rig.state.scanResult.modalities).toContain('extra');
    expect(rig.state.transport.deferredCount).toBe(0);
    expect(rig.state.heldImagePosts.size).toBe(0);

    park(rig, [[3, 1]]);
    hold(rig, [[6, 0]]);
    rig.provider.removeModality(rig.state, 0);
    expect(rig.state.transport.deferredCount).toBe(0);
    expect(rig.state.heldImagePosts.size).toBe(0);
  });
});

// The documented exception to the byte bound: what the park hands to the scrub-burst hold leaves by
// a timer that consults no budget. Pinned so the invariant's text stays a description of the code.
describe('the scrub-burst hold is the one structure whose exits check no budget', () => {
  it('a park released mid-scrub trickles out one payload per tick, past the byte bound', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig({ budgetMB: 1, holdAcks: true });
    park(rig, [[3, 0], [5, 0], [6, 0]], 600_000);

    // The sweep ends while the user is scrubbing: every released push is off-screen, so it is held.
    rig.state.lastTupleSwitchAt = Date.now();
    rig.state.transport.setSweepActive(false);
    rig.provider.drainDeferredImagePosts(rig.state);
    expect(rig.imagePosts().length).toBe(0);
    expect(rig.state.heldImagePosts.size).toBe(3);

    await vi.advanceTimersByTimeAsync(200);
    expect(rig.imagePosts().length).toBe(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(rig.imagePosts().length).toBe(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(rig.imagePosts().length).toBe(3);

    // 1.8MB on an un-acknowledged 1MB wire: the flush never asked, which is what the invariant says.
    expect(rig.state.transport.inFlightBytes).toBeGreaterThan(rig.state.transport.limit);
  });
});

describe('a closed panel keeps no transport timer alive', () => {
  it('dispose clears the outstanding ack watchdogs', async () => {
    __setRemoteName('ssh-remote');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig();
    // A post whose ack never lands is exactly what the watchdog exists for.
    rig.state.panel.webview.postMessage = (msg: any) => { rig.posts.push(msg); return new Promise<boolean>(() => undefined); };

    rig.provider.postImageNow(rig.state, image(CENTER, 0));
    rig.provider.postImageNow(rig.state, image(CENTER, 1));
    await settle(3);
    const armed = vi.getTimerCount();
    expect(armed).toBeGreaterThanOrEqual(2);

    rig.provider.disposePanel(rig.state, []);
    expect(rig.state.disposed).toBe(true);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 2);
  });
});

// A slot-level invalidation — the file deleted, restored, renamed onto, rewritten, or its bytes
// re-requested — leaves the cached bytes behind, and until this fix it left the *wire* copies too:
// a payload already parked (or held) for that slot still posted and painted a ghost, an image under
// a slot that no longer has one. The park widened that window from the burst hold's ~180ms to a
// whole sweep, which on a real grid runs for minutes. Both directions are pinned here: over-eager
// eviction is the opposite failure, a live slot losing the payload it was about to be shown.
// (docs/loading-architecture.md: slot-invalidation-clears-the-wire)
describe('a slot invalidation takes that slot\'s wire copies with it', () => {
  const DELETED = '/imgs/ours/frame03.png'; // tuple 3, modality index 1; tuple 3's `gt` slot is the live neighbour

  it('drops the parked payload the moment the delete is seen', () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();
    park(rig, [[3, 1], [3, 0]]);

    rig.provider.handleFileDeleted(rig.state, Uri.file(DELETED));

    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('drops a payload parked inside the rename window when the delete commits', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig();

    rig.provider.handleFileDeleted(rig.state, Uri.file(DELETED));
    // A load that resolved inside the 500ms window re-populates the slot, exactly what the commit's
    // own cache clear exists for — the park is the same trap one layer out.
    park(rig, [[3, 1], [3, 0]]);
    await vi.advanceTimersByTimeAsync(600);

    expect(rig.state.scanResult.tuples[3].images.map((i: any) => i.modality)).toEqual(['gt', 'baseline']);
    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('drops the stale payload when the file comes back under its own name', () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();

    rig.provider.handleFileDeleted(rig.state, Uri.file(DELETED));
    park(rig, [[3, 1], [3, 0]]);
    rig.provider.handleFileCreated(rig.state, Uri.file(DELETED));

    // The bytes on disk are new; the parked ones are the pre-delete contents.
    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('drops the stale payload when a rename lands on the slot', () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();

    rig.provider.handleFileDeleted(rig.state, Uri.file(DELETED));
    park(rig, [[3, 1], [3, 0]]);
    // Same directory, one pending delete: the create is claimed as that file's new name.
    rig.provider.handleFileCreated(rig.state, Uri.file('/imgs/ours/frame03_v2.png'));

    expect(rig.state.scanResult.tuples[3].images.find((i: any) => i.modality === 'ours').name).toBe('frame03_v2.png');
    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('drops the stale payload when the file is rewritten in place', () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();
    park(rig, [[3, 1], [3, 0]]);

    rig.provider.handleFileChanged(rig.state, Uri.file(DELETED));

    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('drops the stale payload a forceReload retry is asking past', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();
    park(rig, [[3, 1], [3, 0]]);

    // The webview re-asks for bytes it could not decode; the parked copy is those same bytes.
    await rig.provider.sendImage(rig.state, 3, 1, Priority.VISIBLE, true);
    await settle(3);

    // The re-read fails (no such file), so nothing but the fix can clear the park.
    expect(rig.posts.filter((p: any) => p.type === 'imageError').length).toBe(1);
    expect(drained(rig)).toEqual(['3-0:1']);
  });

  it('never lets a held burst payload for a deleted slot reach the wire', async () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rig = makeRig();
    hold(rig, [[3, 1], [3, 0]]);
    expect(rig.state.heldImagePosts.size).toBe(2);

    rig.provider.handleFileDeleted(rig.state, Uri.file(DELETED));
    await vi.advanceTimersByTimeAsync(1000);

    expect(rig.imagePosts().map((p: any) => `${p.tupleIndex}-${p.modalityIndex}`)).toEqual(['3-0']);
  });

  it('leaves the park alone when the byte cache merely evicts a live distant slot', () => {
    __setRemoteName('ssh-remote');
    __setConfig('prefetchCount', 3);
    const rig = makeRig();
    park(rig, [[1, 0], [3, 1]]);
    rig.state.loadedImages.set('1-0', { bytes: new Uint8Array(4), mime: 'image/png', width: 4, height: 4 });
    rig.state.loadedImages.set('3-1', { bytes: new Uint8Array(4), mime: 'image/png', width: 4, height: 4 });

    // Memory pressure, not invalidation: those files are fine, and nothing re-requests a slot on
    // eviction alone — drop the payload here and the user waits on a transfer that was already paid for.
    rig.provider.evictDistantTuples(rig.state, CENTER, 0);

    expect([...rig.state.loadedImages.keys()]).toEqual([]);
    expect(drained(rig)).toEqual(['1-0:1', '3-1:1']);
  });
});
