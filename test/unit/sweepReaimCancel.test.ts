import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { Priority } from '../../src/workPool';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';
import { LOAD_DEBOUNCE_MS } from '../../src/webview/tupleLoadPlan';
import { panelState, thumbnailServiceStub } from './providerRig';

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
  resolvers: Array<() => void>;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-cancel-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', 5);
  const posts: any[] = [];
  const asked: number[] = [];
  const resolvers: Array<() => void> = [];
  const rig: Rig = { provider: undefined, state: undefined, posts, asked, resolvers };
  rigs.push(rig);

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = thumbnailServiceStub(resolvers, uri => asked.push(Number(/frame(\d+)/.exec(uri.path)![1])));

  rig.provider = provider;
  rig.state = panelState({ modalities: MODALITIES, tuples: TUPLES, openAt: OPEN_AT, poolKeyPrefix: 'cancel', posts });
  return rig;
}

// Navigation as the panel really receives it: the message handler, then the dwell the sweep's centre
// waits out before it re-aims (docs/loading-architecture.md: sweep-centre-dwells).
async function navigate(rig: Rig, tupleIndex: number): Promise<void> {
  await rig.provider.handlePanelMessage(rig.state, { type: 'setCurrentTuple', tupleIndex });
  await new Promise(r => setTimeout(r, LOAD_DEBOUNCE_MS + 20));
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
    // The cross interleaves the two arms: the opened row's other modality, then the rows either side of it.
    expect(rig.asked).toEqual([OPEN_AT, OPEN_AT, OPEN_AT + 1, OPEN_AT - 1]);
    expect((rig.provider as any).pool.pending).toBe(SWEEP_CHUNK - BULK_SLOTS);

    // The real message path, dwell included, with all 32 slots outstanding.
    await navigate(rig, JUMP_TO);
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

    await navigate(rig, JUMP_TO);
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
    // this, the 28 dispatches already queued behind the running batch were still read for a window
    // that is gone (docs/testing.md Findings: 448 of 480 on the pure runner).
    expect(rig.asked.length - readsAtDispose).toBe(0);
    expect(rig.asked.length).toBe(BULK_SLOTS);
    expect((rig.provider as any).pool.pending).toBe(0);
    expect((rig.provider as any).pool.running).toBe(0);
  });
});
