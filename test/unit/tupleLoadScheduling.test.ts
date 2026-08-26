import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setConfig, workspace } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
import { Priority } from '../../src/workPool';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';

// The starvation the field log showed, measured on the REAL provider through its real message loop:
// 746 tuples x 10 modalities, six minutes of `run=[0,15,0,0,0,1,0] queued=[0,124,0,0,0,5842,1]` —
// fifteen of sixteen slots held by SIBLING full-image loads of tuples the user had already left,
// one for the whole carousel sweep. Prefetch waves were keyed and cancelled; the current-tuple
// loads never were, so every tuple ever visited kept its nine siblings queued for the panel's life.
// These tests replay the webview's traffic and read the pool's own queue, so a regression shows up
// as the number it was reported as.
// (docs/loading-architecture.md: stale-tuple-loads-cancelled, sibling-tail-never-competes)

const MODALITIES = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
const TUPLES = 8;
/** Narrow, but wide enough that speculation has two slots to share — the regime where a fair-share
 *  pick would hand the tail one of the sweep's (docs/loading-architecture.md: background-trickle). */
const POOL_WIDTH = 4;

const tmpRoots: string[] = [];
const gates: Array<() => void> = [];
const realReadFile = workspace.fs.readFile;

afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Rig {
  provider: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  reads: string[];
}

/** Every slot of the pool held by a task that never finishes, so what a policy *enqueues* is visible. */
function blockPool(rig: Rig): void {
  const gate = new Promise<void>(resolve => gates.push(resolve));
  for (let i = 0; i < POOL_WIDTH; i++) {
    void rig.provider.pool
      .submit(() => gate, { priority: Priority.VISIBLE, key: 'blocker' })
      .catch(() => undefined);
  }
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-tupleload-'));
  tmpRoots.push(root);
  const reads: string[] = [];
  // Real files, read through the real serve path; the spy is the count of reads the policy caused.
  for (const m of MODALITIES) {
    fs.mkdirSync(path.join(root, m), { recursive: true });
    for (let t = 0; t < TUPLES; t++) fs.writeFileSync(path.join(root, m, `frame${t}.png`), Buffer.alloc(8));
  }
  workspace.fs.readFile = async (uri: Uri) => {
    reads.push(uri.fsPath);
    return realReadFile(uri);
  };

  // The pool is process-wide and sized once; pin it so "queued" is a property of the policy.
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);

  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: `frame${t}`,
    images: MODALITIES.map(m => ({ uri: Uri.file(path.join(root, m, `frame${t}.png`)), name: `frame${t}.png`, modality: m }))
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = {
    panel: { webview: { postMessage: () => Promise.resolve(true) } },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(MODALITIES.map(m => [m, Uri.file(path.join(root, m))])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: 0,
    sweepAim: newSweepAimPolicy(),
    disposed: false,
    visible: true,
    poolKey: `tupleload-${Math.random().toString(36).slice(2)}`,
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
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(undefined, undefined))
  };

  return { provider, state, reads };
}

/** The pool's own queue depth per priority class, straight out of `WorkPool.stats()`. */
function queued(rig: Rig): number[] {
  const m = /queued=\[([^\]]+)\]/.exec(rig.provider.pool.stats());
  return m![1].split(',').map(Number);
}

function running(rig: Rig): number[] {
  const m = /run=\[([^\]]+)\]/.exec(rig.provider.pool.stats());
  return m![1].split(',').map(Number);
}

/** One tuple arrival as the webview posts it: the tuple hint, then one request per modality. */
function visitTuple(rig: Rig, tupleIndex: number, ranks: Array<'visible' | 'sibling' | 'tail'>): void {
  void rig.provider.handlePanelMessage(rig.state, { type: 'setCurrentTuple', tupleIndex });
  ranks.forEach((rank, modalityIndex) => {
    void rig.provider.handlePanelMessage(rig.state, {
      type: 'requestImage',
      tupleIndex,
      modalityIndex,
      sibling: rank !== 'visible',
      tail: rank === 'tail'
    });
  });
}

/** The pre-change traffic: every visited tuple asks for all ten modalities at once. */
const WHOLE_TUPLE: Array<'visible' | 'sibling' | 'tail'> =
  MODALITIES.map((_, i) => (i === 0 ? 'visible' : 'sibling'));

beforeEach(() => {
  __resetConfig();
  __setConfig('maxConcurrentReads', POOL_WIDTH);
});

afterEach(async () => {
  let release;
  while ((release = gates.shift())) release();
  await settle(30);
  workspace.fs.readFile = realReadFile;
  __resetConfig();
});

describe('navigating away cancels the tuple you left', () => {
  it('keeps at most the current tuple queued while browsing six tuples', async () => {
    const rig = makeRig();
    blockPool(rig);
    for (let t = 0; t < 6; t++) visitTuple(rig, t, WHOLE_TUPLE);
    await settle();

    const q = queued(rig);
    // Pre-change this was 6 x 10 loads, ~56 of them queued for tuples nobody was looking at.
    expect(q[Priority.SIBLING]).toBeLessThanOrEqual(MODALITIES.length - 1);
    // The visible image of a tuple the user has left is just as dead.
    expect(q[Priority.VISIBLE]).toBeLessThanOrEqual(1);
    expect(q.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MODALITIES.length);
  });

  it('never reads a file for a tuple the user left before its load started', async () => {
    const rig = makeRig();
    blockPool(rig);
    for (let t = 0; t < 6; t++) visitTuple(rig, t, WHOLE_TUPLE);
    await settle();
    // Release the pool: only what survived cancellation can now reach the filesystem.
    let release;
    while ((release = gates.shift())) release();
    await settle(30);

    expect(rig.reads.length).toBeLessThanOrEqual(MODALITIES.length);
    expect(rig.reads.every(p => p.endsWith('frame5.png'))).toBe(true);
  });

  it('leaves the arrived tuple alone (cancellation is by tuple, not a blanket drain)', async () => {
    const rig = makeRig();
    blockPool(rig);
    visitTuple(rig, 0, WHOLE_TUPLE);
    visitTuple(rig, 1, WHOLE_TUPLE);
    await settle();
    const q = queued(rig);
    // Tuple 1's own requests are untouched: one visible plus nine siblings.
    expect(q[Priority.VISIBLE]).toBe(1);
    expect(q[Priority.SIBLING]).toBe(MODALITIES.length - 1);
  });

  it('cancels the panel\'s tuple loads on dispose, not just its poolKey work', async () => {
    const rig = makeRig();
    blockPool(rig);
    visitTuple(rig, 3, WHOLE_TUPLE);
    await settle();
    expect(queued(rig).reduce((a, b) => a + b, 0)).toBe(MODALITIES.length);

    rig.provider.disposePanel(rig.state, []);
    await settle();
    expect(queued(rig).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('the sibling tail is scheduled below the carousel sweep', () => {
  it('queues tail requests in their own class, never as siblings', async () => {
    const rig = makeRig();
    blockPool(rig);
    visitTuple(rig, 0, ['visible', 'sibling', 'sibling', 'tail', 'tail', 'tail', 'tail', 'tail', 'tail', 'tail']);
    await settle();

    const q = queued(rig);
    expect(q[Priority.SIBLING_TAIL]).toBe(7);
    expect(q[Priority.SIBLING]).toBe(2);
  });

  it('yields every slot to the thumbnail sweep while it has work', async () => {
    const rig = makeRig();
    // A sweep already draining, exactly like an open-time carousel fill; its reads hang like a cold mount's.
    const sweepStarted: number[] = [];
    const sweepGate = new Promise<void>(resolve => gates.push(resolve));
    for (let i = 0; i < 8; i++) {
      void rig.provider.pool
        .submit(async () => { sweepStarted.push(i); await sweepGate; }, { priority: Priority.THUMBNAIL_BULK, key: rig.state.poolKey })
        .catch(() => undefined);
    }
    visitTuple(rig, 0, MODALITIES.map((_, i) => (i === 0 ? 'visible' : 'tail')));
    await settle(20);

    // The tail may not hold a slot the sweep could use. A fair-share pick would have split the three
    // speculative slots between the two classes; the sweep must get all of them while it has queue.
    expect(running(rig)[Priority.SIBLING_TAIL]).toBe(0);
    expect(sweepStarted.length).toBe(POOL_WIDTH - 1);
  });
});
