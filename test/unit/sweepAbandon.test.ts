import { describe, it, expect } from 'vitest';
import { SWEEP_CHUNK, SWEEP_REQUEUE, planThumbnails, runThumbnailSweep, ThumbnailBytes } from '../../src/thumbnailPlan';
import { Priority, TaskCancelled, WorkPool } from '../../src/workPool';
import { ExtensionMessage } from '../../src/types';

// A panel the user closed (provider: `state.disposed`; standalone: `s.closed`) must stop being read
// for. What is counted here is REAL reads that START after the close, on the real WorkPool at the
// field shape (width 5 => 4 bulk slots, the rest of the chunk queued) — not the runner's state.
// The two host reactions to a close are kept apart on purpose: the dead-panel path ABANDONS what
// the cursor still holds (consume-once: never handed out again), while the re-aim path RETURNS its
// dropped slots (putBack) and hands them out again. Same `pool.cancel`, opposite obligations.
// (docs/loading-architecture.md: sweep-stops-when-host-abandons, sweep-cancels-on-reaim,
//  sweep-covers-every-slot-once)

const TUPLES = 120;
const MODS = 4;
/** Bulk slots the pool grants at width 5 — speculation collectively leaves one slot free. */
const BULK_SLOTS = 4;

function grid(tuples: number, mods: number) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.map(m => ({ modality: m, name: `${t}_${m}.png` })),
  }));
  return { rows, modalities };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const jpeg = (length: number): ThumbnailBytes => ({ bytes: new Uint8Array(length), mime: 'image/jpeg' });

interface Rig {
  io: { makeThumbnail: (item: { tupleIndex: number; modalityIndex: number }) => Promise<ThumbnailBytes | null | typeof SWEEP_REQUEUE>; dropQueued: () => void };
  post: (m: ExtensionMessage) => void;
  /** Slot keys the pool actually STARTED a read for, in start order — a cancelled slot never appears. */
  started: string[];
  /** Slots delivered to the webview, with their delivery count. */
  delivered: Map<string, number>;
  progress: number[];
  /** Host state: set before the host cancels, exactly as both products do. */
  closed: boolean;
  releaseBatch: () => Promise<number>;
  drain: (rounds?: number) => Promise<void>;
}

/** `hostSettles`: what the host maps a TaskCancelled to once closed — null (both products) or SWEEP_REQUEUE (the pre-fix mapping). */
function poolRig(hostSettles: 'null' | 'requeue' = 'null'): Rig {
  const pool = new WorkPool(5);
  const key = 'abandon-rig';
  const release: Array<() => void> = [];
  const rig: Rig = {
    started: [],
    delivered: new Map(),
    progress: [],
    closed: false,
    releaseBatch: async () => {
      const batch = release.splice(0);
      for (const r of batch) r();
      await flush();
      return batch.length;
    },
    drain: async (rounds = 5000) => {
      let guard = 0;
      while (guard++ < rounds && (await rig.releaseBatch()) > 0) { /* keep releasing whole batches */ }
    },
    post: (m: ExtensionMessage) => {
      if (m.type === 'thumbnail') {
        const k = `${m.tupleIndex}-${m.modalityIndex}`;
        rig.delivered.set(k, (rig.delivered.get(k) ?? 0) + 1);
      } else if (m.type === 'thumbnailProgress') rig.progress.push(m.current);
    },
    io: {
      makeThumbnail: item =>
        pool
          .submit(
            () =>
              new Promise<ThumbnailBytes>(resolve => {
                rig.started.push(`${item.tupleIndex}-${item.modalityIndex}`);
                release.push(() => resolve(jpeg(4)));
              }),
            { priority: Priority.THUMBNAIL_BULK, key }
          )
          .catch(error => {
            // Both hosts: a cancellation they caused settles the slot silently, any other returns it.
            if (error instanceof TaskCancelled) return rig.closed && hostSettles === 'null' ? null : SWEEP_REQUEUE;
            throw error;
          }),
      dropQueued: () => pool.cancel(key),
    },
  };
  return rig;
}

/** What both hosts do on close/dispose: mark the state first, then cancel the sweep's queue. */
function closeHost(rig: Rig, cancelQueue = true): void {
  rig.closed = true;
  if (cancelQueue) rig.io.dropQueued();
}

/** Rejects rather than hanging the runner if the sweep never resolves. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sweep did not settle in ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

describe('sweep runner: a host that abandoned the sweep stops being read for', () => {
  it('reads nothing new after the close, where it used to read the rest of the grid', async () => {
    const { rows, modalities } = grid(TUPLES, MODS);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    const sweep = runThumbnailSweep(plan, rig.io, rig.post, { centre: () => 60, abandoned: () => rig.closed });
    await flush();
    expect(plan.items.length).toBe(TUPLES * MODS);
    expect(rig.started.length).toBe(BULK_SLOTS);

    // The user closes the panel with the chunk outstanding: 4 reading, 28 queued behind them.
    closeHost(rig);
    const startedAtClose = rig.started.length;
    await rig.drain();
    await withDeadline(sweep, 5000);

    // Everything the pool had not started is left in the cursor, unread.
    const readsAfterClose = rig.started.length - startedAtClose;
    expect(readsAfterClose).toBe(0);
    expect(rig.started.length).toBeLessThan(plan.items.length);
    // No slot was read twice: the abandoned slots were never returned to the cursor.
    expect(new Set(rig.started).size).toBe(rig.started.length);
  });

  it('a host that does not cancel its own queue still stops within one chunk', async () => {
    const { rows, modalities } = grid(TUPLES, MODS);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    const sweep = runThumbnailSweep(plan, rig.io, rig.post, { centre: () => 60, abandoned: () => rig.closed });
    await flush();

    // No dropQueued: the already-submitted chunk drains, and nothing beyond it is dispatched.
    closeHost(rig, false);
    const startedAtClose = rig.started.length;
    await rig.drain();
    await withDeadline(sweep, 5000);

    const readsAfterClose = rig.started.length - startedAtClose;
    expect(readsAfterClose).toBeGreaterThan(0);
    expect(readsAfterClose).toBeLessThanOrEqual(SWEEP_CHUNK);
    expect(rig.started.length).toBeLessThanOrEqual(SWEEP_CHUNK);
  });

  it('resolves without dispatching anything when the host was already gone at sweep start', async () => {
    const { rows, modalities } = grid(10, 2);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    rig.closed = true;
    await withDeadline(runThumbnailSweep(plan, rig.io, rig.post, { centre: () => 0, abandoned: () => rig.closed }), 5000);
    expect(rig.started).toEqual([]);
    expect(rig.delivered.size).toBe(0);
  });

  it('abandons what the cursor still holds, where a re-aim returns what it dropped', async () => {
    const { rows, modalities } = grid(TUPLES, MODS);

    // Re-aim: the same pool.cancel, but the host is live — every dropped slot comes back and is read.
    const live = poolRig();
    let centre = 60;
    const liveSweep = runThumbnailSweep(planThumbnails(rows, modalities), live.io, live.post, { centre: () => centre, abandoned: () => live.closed });
    await flush();
    centre = 5;
    await live.drain();
    await withDeadline(liveSweep, 10000);
    expect(live.delivered.size).toBe(TUPLES * MODS);
    expect([...live.delivered.values()].every(n => n === 1)).toBe(true);
    // Every slot was read for the live panel, which is the contrast the dead one has to break.
    expect(live.started.length).toBe(TUPLES * MODS);

    // Close: the same cancel, and the dropped slots are gone for good.
    const dead = poolRig();
    const deadSweep = runThumbnailSweep(planThumbnails(rows, modalities), dead.io, dead.post, { centre: () => 60, abandoned: () => dead.closed });
    await flush();
    closeHost(dead);
    await dead.drain();
    await withDeadline(deadSweep, 10000);
    expect(dead.delivered.size).toBeLessThan(TUPLES * MODS);
    expect(dead.started.length).toBeLessThanOrEqual(SWEEP_CHUNK);
  });
});
