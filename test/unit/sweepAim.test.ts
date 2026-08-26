import { describe, it, expect } from 'vitest';
import { SWEEP_CHUNK, SWEEP_REQUEUE, planThumbnails, runThumbnailSweep, ThumbnailBytes } from '../../src/thumbnailPlan';
import { Priority, TaskCancelled, WorkPool } from '../../src/workPool';
import { ExtensionMessage } from '../../src/types';

// Where the pump reads the centre. A centre computed on read (viewport offset -> row) returns a
// different value every call, and the pump must survive that: one pass aims at one centre, and the
// requeues a drop itself causes must not each buy another drop, or the drop's own fallout sustains
// a microtask cascade that never yields (only the pool's running batch ever starts, and no timer
// ever fires again). Both hosts pass a plain field today, so this is a guard on the seam, not on
// today's behaviour — which is why the band case pins the read count directly.
// (docs/loading-architecture.md: sweep-aims-once-per-pass, sweep-cancels-on-reaim,
//  sweep-covers-every-slot-once)

const TUPLES = 60;
const MODS = 4;
/** Drops a healthy run cannot approach: one per delivered settle is ~TUPLES*MODS, this is 20x that. */
const DROP_BREAKER = 5000;

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
  /** Rows in the order the runner DISPATCHED them — recorded before the pool sees them. */
  dispatched: number[];
  drops: number;
  delivered: Map<string, number>;
}

function poolRig(): Rig {
  const pool = new WorkPool(5);
  const key = 'aim-rig';
  const rig: Rig = {
    dispatched: [],
    drops: 0,
    delivered: new Map(),
    post: (m: ExtensionMessage) => {
      if (m.type !== 'thumbnail') return;
      const k = `${m.tupleIndex}-${m.modalityIndex}`;
      rig.delivered.set(k, (rig.delivered.get(k) ?? 0) + 1);
    },
    io: {
      makeThumbnail: item => {
        rig.dispatched.push(item.tupleIndex);
        return pool
          .submit(
            // Reads finish on a MACROTASK, exactly as real IO does: a cascade that never yields never gets here.
            () => new Promise<ThumbnailBytes>(resolve => { setTimeout(() => resolve(jpeg(4)), 0); }),
            { priority: Priority.THUMBNAIL_BULK, key }
          )
          .catch(error => {
            if (error instanceof TaskCancelled) return SWEEP_REQUEUE;
            throw error;
          });
      },
      dropQueued: () => {
        // A circuit breaker, not a rule: a livelocked pump would otherwise hang the whole runner.
        if (++rig.drops > DROP_BREAKER) throw new Error(`dropQueued called ${rig.drops} times: the pump is re-aiming on its own fallout`);
        pool.cancel(key);
      },
    },
  };
  return rig;
}

describe('sweep runner: one pump pass aims at one centre', () => {
  it('dispatches its first chunk as one centre-out band, reading the centre once', async () => {
    const { rows, modalities } = grid(TUPLES, MODS);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    let calls = 0;
    // A viewport-shaped centre: a fresh value on every read, starting at row 30.
    const centre = () => ({ tuple: 30 + calls++ });

    const sweep = runThumbnailSweep(plan, rig.io, rig.post, { centre });

    // One aim, not 32 of them: the cross from (30, m0) — row 30's three other columns interleaved
    // with rows 31, 29, 32 — then the column arm alone out to the default radius of 12 rows (42 and
    // 18), and finally the row-major remainder, which refills row 31 and reaches row 29.
    const band = [
      30, 30, 31, 30, 29, 30, 32, 28, 33, 27, 34, 26, 35, 25, 36, 24, 37, 23, 38, 22, 39, 21, 40, 20, 41, 19, 42, 18,
      31, 31, 31, 29,
    ];
    expect(rig.dispatched.length).toBe(SWEEP_CHUNK);
    expect(rig.dispatched).toEqual(band);
    expect(calls).toBe(1);
    expect(rig.drops).toBe(0);

    await flush();
    await sweep;
  });

  it('finishes a grid under a centre that moves on every read, instead of livelocking', async () => {
    const { rows, modalities } = grid(TUPLES, MODS);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    let calls = 0;
    const centre = () => ({ tuple: (calls++) % TUPLES });

    // A macrotask that only fires if the pump ever yields the event loop back.
    let tickFired = false;
    const ticker = setTimeout(() => { tickFired = true; }, 5);

    await runThumbnailSweep(plan, rig.io, rig.post, { centre });
    clearTimeout(ticker);

    expect(tickFired).toBe(true);
    expect(rig.delivered.size).toBe(plan.items.length);
    expect([...rig.delivered.values()].every(n => n === 1)).toBe(true);
    expect(rig.drops).toBeLessThanOrEqual(DROP_BREAKER);
  });
});
