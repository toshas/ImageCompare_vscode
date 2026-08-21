import { describe, it, expect } from 'vitest';
import { SWEEP_CHUNK, SWEEP_REQUEUE, SweepCursor, planThumbnails, runThumbnailSweep, ThumbnailBytes } from '../../src/thumbnailPlan';
import { Priority, TaskCancelled, WorkPool } from '../../src/workPool';
import { ExtensionMessage } from '../../src/types';

// The sweep's order and coverage on the real thumbnailPlan code: dispatch order is written out as
// external literals, and the coverage case counts what the runner actually asked for and posted.
// (docs/loading-architecture.md: thumbnails-centre-out, sweep-covers-every-slot-once, sweep-dispatch-bounded)

const img = (modality: string, name: string) => ({ modality, name });

/** A dense grid of `tuples` rows x `mods` columns; every slot populated unless `holes` says otherwise. */
function grid(tuples: number, mods: number, holes: ReadonlySet<string> = new Set()) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.filter(m => !holes.has(`${t}-${m}`)).map(m => img(m, `${t}_${m}.png`)),
  }));
  return { rows, modalities };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const jpeg = (length: number): ThumbnailBytes => ({ bytes: new Uint8Array(length), mime: 'image/jpeg' });

describe('sweep cursor: centre-out order (real thumbnailPlan code)', () => {
  it('walks outward from the centre row, forward first on a tie, modality-minor within a row', () => {
    const { rows, modalities } = grid(5, 2);
    const cursor = new SweepCursor(planThumbnails(rows, modalities).items);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const item = cursor.next(2);
      order.push(`${item!.tupleIndex}-${item!.modalityIndex}`);
    }
    // Rows 2, then 3 (forward wins the distance-1 tie), 1, 4, 0 — each row's two columns in order.
    expect(order).toEqual([
      '2-0', '2-1',
      '3-0', '3-1',
      '1-0', '1-1',
      '4-0', '4-1',
      '0-0', '0-1',
    ]);
    expect(cursor.remaining).toBe(0);
    expect(cursor.next(2)).toBeUndefined();
  });

  it('a centre of 0 is plain scanline order — what a host that supplies no centre gets', () => {
    const { rows, modalities } = grid(4, 1);
    const cursor = new SweepCursor(planThumbnails(rows, modalities).items);
    const order: number[] = [];
    for (let i = 0; i < 4; i++) order.push(cursor.next(0)!.tupleIndex);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('a centre moved mid-walk re-aims the remainder instead of finishing the old order', () => {
    const { rows, modalities } = grid(20, 1);
    const cursor = new SweepCursor(planThumbnails(rows, modalities).items);
    const before = [cursor.next(0)!.tupleIndex, cursor.next(0)!.tupleIndex, cursor.next(0)!.tupleIndex];
    expect(before).toEqual([0, 1, 2]);
    // The user jumps to row 15: the next slots are 15's neighbourhood, not row 3.
    const after = [15, 16, 14, 17, 13].map(() => cursor.next(15)!.tupleIndex);
    expect(after).toEqual([15, 16, 14, 17, 13]);
    // Back to the top: the rows already taken are skipped, so the walk resumes at 3.
    expect([cursor.next(0)!.tupleIndex, cursor.next(0)!.tupleIndex]).toEqual([3, 4]);
  });

  it('a centre past the ends is clamped to the grid, not dropped', () => {
    const { rows, modalities } = grid(3, 1);
    const cursor = new SweepCursor(planThumbnails(rows, modalities).items);
    expect(cursor.next(99)!.tupleIndex).toBe(2);
    expect(cursor.next(-99)!.tupleIndex).toBe(0);
    expect(cursor.next(-99)!.tupleIndex).toBe(1);
  });

  it('rows with no planned items are skipped, not counted as distance stops', () => {
    // Row 1 is entirely missing from the plan (no images at all), so the walk jumps 2 -> 3 -> 0.
    const holes = new Set(['1-m0']);
    const { rows, modalities } = grid(4, 1, holes);
    const plan = planThumbnails(rows, modalities);
    expect(plan.missing).toEqual([{ tupleIndex: 1, modalityIndex: 0 }]);
    const cursor = new SweepCursor(plan.items);
    expect([cursor.next(2)!.tupleIndex, cursor.next(2)!.tupleIndex, cursor.next(2)!.tupleIndex]).toEqual([2, 3, 0]);
  });

  it('a returned slot is handed out again exactly once, from rows both walks have already passed', () => {
    const { rows, modalities } = grid(6, 2);
    const plan = planThumbnails(rows, modalities);
    const cursor = new SweepCursor(plan.items);
    const key = (i: { tupleIndex: number; modalityIndex: number }) => `${i.tupleIndex}-${i.modalityIndex}`;

    // A return into a row that still has siblings keeps the row modality-minor: 3-0 leads 3-1 again.
    const first = cursor.next(3)!;
    expect(key(first)).toBe('3-0');
    cursor.putBack(first);
    expect(cursor.remaining).toBe(12);
    expect(key(cursor.next(3)!)).toBe('3-0');

    const taken = [key(first)];
    for (let i = 1; i < 8; i++) taken.push(key(cursor.next(3)!));
    expect(taken).toEqual(['3-0', '3-1', '4-0', '4-1', '2-0', '2-1', '5-0', '5-1']);
    // Both walks are now past rows 4 and 2: nothing would ever revisit them.
    const above = plan.items.find(i => key(i) === '4-1')!;
    const below = plan.items.find(i => key(i) === '2-1')!;
    cursor.putBack(above);
    cursor.putBack(below);
    expect(cursor.remaining).toBe(6);

    const seen: string[] = [];
    let guard = 0;
    while (cursor.remaining > 0 && guard++ < 100) seen.push(key(cursor.next(3)!));
    expect(seen.length).toBe(6);
    expect(seen.sort()).toEqual(['0-0', '0-1', '1-0', '1-1', '2-1', '4-1']);
    expect(cursor.next(3)).toBeUndefined();
  });

  it('every slot is handed out exactly once however often the centre jumps', () => {
    const { rows, modalities } = grid(40, 6, new Set(['7-m2', '19-m0', '31-m5']));
    const plan = planThumbnails(rows, modalities);
    const cursor = new SweepCursor(plan.items);
    // A deterministic walk of jumps, including repeats, both ends and a stretch with no movement.
    const centres = [0, 39, 12, 12, 12, 5, 38, 20, 0, 25, 25, 39, 1, 17, 17, 17, 3];
    const seen: string[] = [];
    for (let i = 0; cursor.remaining > 0; i++) {
      const item = cursor.next(centres[i % centres.length]);
      seen.push(`${item!.tupleIndex}-${item!.modalityIndex}`);
    }
    expect(seen.length).toBe(40 * 6 - 3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(plan.items.map(i => `${i.tupleIndex}-${i.modalityIndex}`)));
  });
});

describe('sweep runner: bounded dispatch and coverage under a moving centre (real thumbnailPlan code)', () => {
  it('keeps at most `chunk` slots outstanding and refills as they settle', async () => {
    const { rows, modalities } = grid(30, 4);
    const plan = planThumbnails(rows, modalities);
    const pending: Array<() => void> = [];
    let outstanding = 0;
    let peak = 0;
    const sweep = runThumbnailSweep(plan, {
      makeThumbnail: () => new Promise<ThumbnailBytes>(resolve => {
        outstanding++;
        peak = Math.max(peak, outstanding);
        pending.push(() => { outstanding--; resolve(jpeg(7)); });
      }),
    }, () => undefined, { chunk: 8, centre: () => 0 });

    expect(peak).toBe(8);
    // Settle them all; the refill keeps the bound on every wave, never the whole 120-slot grid.
    let guard = 0;
    while (pending.length && guard++ < 1000) {
      pending.shift()!();
      await flush();
    }
    await sweep;
    expect(peak).toBe(8);
  });

  it('the default dispatch bound is SWEEP_CHUNK', async () => {
    const { rows, modalities } = grid(60, 4);
    const plan = planThumbnails(rows, modalities);
    const pending: Array<() => void> = [];
    let outstanding = 0;
    let peak = 0;
    const sweep = runThumbnailSweep(plan, {
      makeThumbnail: () => new Promise<ThumbnailBytes>(resolve => {
        outstanding++;
        peak = Math.max(peak, outstanding);
        pending.push(() => { outstanding--; resolve(jpeg(3)); });
      }),
    }, () => undefined);
    expect(peak).toBe(SWEEP_CHUNK);
    expect(SWEEP_CHUNK).toBe(32);
    let guard = 0;
    while (pending.length && guard++ < 5000) {
      pending.shift()!();
      await flush();
    }
    await sweep;
    expect(peak).toBe(SWEEP_CHUNK);
  });

  it('the current row and its neighbours are dispatched first, and a jump re-aims the rest', async () => {
    const { rows, modalities } = grid(50, 2);
    const plan = planThumbnails(rows, modalities);
    let centre = 40;
    const asked: number[] = [];
    const pending: Array<() => void> = [];
    const sweep = runThumbnailSweep(plan, {
      makeThumbnail: item => new Promise<ThumbnailBytes>(resolve => {
        asked.push(item.tupleIndex);
        pending.push(() => resolve(jpeg(5)));
      }),
    }, () => undefined, { chunk: 2, centre: () => centre });

    // Settling one slot refills exactly one dispatch, so the aim is re-read between rows.
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        pending.shift()!();
        await flush();
      }
    };

    expect(asked).toEqual([40, 40]);
    await step(2);
    expect(asked.slice(2)).toEqual([41, 41]);
    await step(2);
    expect(asked.slice(4)).toEqual([39, 39]);
    // The user jumps to row 5: the next dispatches leave row 42 alone and re-aim there.
    centre = 5;
    await step(6);
    expect(asked.slice(6)).toEqual([5, 5, 6, 6, 4, 4]);
    let guard = 0;
    while (pending.length && guard++ < 5000) await step(1);
    await sweep;
  });

  it('every planned slot is delivered exactly once, and the tail is swept, after repeated jumps', async () => {
    const { rows, modalities } = grid(40, 6, new Set(['7-m2', '19-m0', '31-m5']));
    const plan = planThumbnails(rows, modalities);
    const centres = [0, 39, 12, 12, 5, 38, 20, 0, 25, 39, 1, 17, 3];
    let dispatches = 0;
    let centre = centres[0];
    const delivered = new Map<string, number>();
    const errors: string[] = [];
    const progress: number[] = [];
    const post = (m: ExtensionMessage): void => {
      if (m.type === 'thumbnail') delivered.set(`${m.tupleIndex}-${m.modalityIndex}`, (delivered.get(`${m.tupleIndex}-${m.modalityIndex}`) ?? 0) + 1);
      else if (m.type === 'thumbnailError') errors.push(`${m.tupleIndex}-${m.modalityIndex}`);
      else if (m.type === 'thumbnailProgress') progress.push(m.current);
    };
    await runThumbnailSweep(plan, {
      makeThumbnail: () => {
        // The centre moves on every dispatch — the worst case for a cursor that re-aims.
        centre = centres[++dispatches % centres.length];
        return Promise.resolve(jpeg(9));
      },
    }, post, { chunk: 4, centre: () => centre });

    const expected = new Set(plan.items.map(i => `${i.tupleIndex}-${i.modalityIndex}`));
    expect(delivered.size).toBe(expected.size);
    expect([...delivered.values()].every(n => n === 1)).toBe(true);
    expect(new Set(delivered.keys())).toEqual(expected);
    // The 3 planned-missing slots are still reported, once each, and the bar reaches exactly total.
    expect(errors.sort()).toEqual(['19-0', '31-5', '7-2']);
    expect(plan.total).toBe(40 * 6);
    expect(progress.length).toBe(plan.items.length);
    expect(progress[progress.length - 1]).toBe(plan.total);
    expect(progress).toEqual(progress.slice().sort((a, b) => a - b));
  });
});

// The re-aim is only worth anything if the work already handed to the pool goes with it. These run on
// the REAL WorkPool at the field log's shape (width 5 => run=[...,4,...] bulk slots, the rest queued),
// so what they count is what the field log counted.
// (docs/loading-architecture.md: sweep-cancels-on-reaim, sweep-covers-every-slot-once)

/** Bulk slots the pool grants at width 5 — speculation collectively leaves one slot free. */
const BULK_SLOTS = 4;

interface PoolRig {
  io: {
    makeThumbnail: (item: { tupleIndex: number; modalityIndex: number }) => Promise<ThumbnailBytes | null | typeof SWEEP_REQUEUE>;
    dropQueued: () => void;
  };
  post: (m: ExtensionMessage) => void;
  /** Tuple rows in the order the POOL started them — dispatch order filtered through the running slots. */
  started: number[];
  /** Releases every task the pool is currently running — one batch — and reports how many that was. */
  releaseBatch: () => Promise<number>;
  outstandingTasks: number;
  cancelled: number;
  delivered: Map<string, number>;
  errors: string[];
  progress: number[];
}

function poolRig(): PoolRig {
  const pool = new WorkPool(5);
  const key = 'sweep-rig';
  const release: Array<() => void> = [];
  const rig: PoolRig = {
    started: [],
    cancelled: 0,
    outstandingTasks: 0,
    delivered: new Map(),
    errors: [],
    progress: [],
    releaseBatch: async () => {
      const batch = release.splice(0);
      for (const r of batch) r();
      await flush();
      return batch.length;
    },
    post: (m: ExtensionMessage) => {
      if (m.type === 'thumbnail') rig.delivered.set(`${m.tupleIndex}-${m.modalityIndex}`, (rig.delivered.get(`${m.tupleIndex}-${m.modalityIndex}`) ?? 0) + 1);
      else if (m.type === 'thumbnailError') rig.errors.push(`${m.tupleIndex}-${m.modalityIndex}`);
      else if (m.type === 'thumbnailProgress') rig.progress.push(m.current);
    },
    io: {
      makeThumbnail: item =>
        pool
          .submit(
            () =>
              new Promise<ThumbnailBytes>(resolve => {
                rig.started.push(item.tupleIndex);
                release.push(() => resolve(jpeg(4)));
              }),
            { priority: Priority.THUMBNAIL_BULK, key }
          )
          .catch(error => {
            // What both hosts do with a queued task the sweep itself dropped.
            if (error instanceof TaskCancelled) {
              rig.cancelled++;
              return SWEEP_REQUEUE;
            }
            throw error;
          }),
      dropQueued: () => pool.cancel(key),
    },
  };
  return rig;
}

describe('sweep runner: a re-aim drops the queued dispatches (real thumbnailPlan + real WorkPool)', () => {
  it('serves the new centre after one running batch, not after the whole outstanding chunk', async () => {
    const { rows, modalities } = grid(120, 4);
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    let centre = 60;
    const sweep = runThumbnailSweep(plan, rig.io, rig.post, { centre: () => centre });
    await flush();

    // SWEEP_CHUNK dispatched, 4 of them running: the other 28 are the queue the field log showed.
    expect(rig.started).toEqual([60, 60, 60, 60]);
    expect(plan.items.length).toBe(480);

    // The user jumps to row 10 with all 32 outstanding — the moment the defect was reported at.
    centre = 10;
    let guard = 0;
    while (!rig.started.slice(BULK_SLOTS).includes(10) && guard++ < 40) await rig.releaseBatch();
    // Tiles the user watches arrive at the OLD centre before the new row starts: at most the batch
    // that was already running and cannot be cancelled.
    const waited = rig.started.slice(BULK_SLOTS).indexOf(10);
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(waited).toBeLessThanOrEqual(BULK_SLOTS);
    // Non-vacuous: the queue really was dropped, not merely drained fast.
    expect(rig.cancelled).toBeGreaterThanOrEqual(SWEEP_CHUNK - 2 * BULK_SLOTS);

    guard = 0;
    while (guard++ < 5000 && (await rig.releaseBatch()) > 0) { /* drain */ }
    await sweep;
    // Cancelling re-ordered the work and lost none of it.
    expect(rig.delivered.size).toBe(plan.items.length);
    expect([...rig.delivered.values()].every(n => n === 1)).toBe(true);
    expect(rig.progress[rig.progress.length - 1]).toBe(plan.total);
  });

  it('every slot is delivered exactly once when the centre moves on every batch while 32 are outstanding', async () => {
    const { rows, modalities } = grid(60, 4, new Set(['3-m1', '29-m0', '58-m3']));
    const plan = planThumbnails(rows, modalities);
    const rig = poolRig();
    const centres = [30, 5, 59, 17, 0, 42, 12, 55, 23, 8, 36, 1, 59, 0];
    let centre = centres[0];
    const sweep = runThumbnailSweep(plan, rig.io, rig.post, { centre: () => centre });
    await flush();

    let guard = 0;
    for (;;) {
      // A jump between every batch, with 32 dispatches outstanding each time.
      centre = centres[++guard % centres.length];
      if (guard > 5000 || (await rig.releaseBatch()) === 0) break;
    }
    await sweep;

    const expected = new Set(plan.items.map(i => `${i.tupleIndex}-${i.modalityIndex}`));
    expect(rig.delivered.size).toBe(expected.size);
    expect([...rig.delivered.values()].every(n => n === 1)).toBe(true);
    expect(new Set(rig.delivered.keys())).toEqual(expected);
    // The planned-missing slots are still reported exactly once, and the bar ends exactly at total.
    expect(rig.errors.sort()).toEqual(['29-0', '3-1', '58-3']);
    expect(rig.progress.length).toBe(plan.items.length);
    expect(rig.progress[rig.progress.length - 1]).toBe(plan.total);
    expect(rig.progress).toEqual(rig.progress.slice().sort((a, b) => a - b));
    // A cancelled slot was re-dispatched many times over; none of it counted twice.
    expect(rig.cancelled).toBeGreaterThan(SWEEP_CHUNK);
    expect(rig.started.length).toBe(plan.items.length);
  });
});

// Seeded fuzz, not random fuzz: the schedules below are generated by an LCG with a fixed seed, so a
// failure reproduces exactly and nobody has to decide whether it was "just flaky". The fixed
// schedules above pin the ORDER; these pin the two properties that must survive any schedule at all
// — every planned slot is handed out exactly once, and the sweep still ends.
// (docs/loading-architecture.md: sweep-covers-every-slot-once, thumbnails-centre-out)

/** 32-bit LCG; same seed, same run, on every machine and every day. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Centres a host could really produce, including the ones no fixed schedule bothers with. */
function hostileCentre(rand: () => number, tuples: number): number {
  const roll = rand();
  if (roll < 0.08) return Number.NaN;
  if (roll < 0.12) return Number.POSITIVE_INFINITY;
  if (roll < 0.16) return Number.NEGATIVE_INFINITY;
  if (roll < 0.22) return -Math.floor(rand() * 500) - 1;
  if (roll < 0.28) return tuples + Math.floor(rand() * 500);
  if (roll < 0.36) return rand() * tuples;
  return Math.floor(rand() * tuples);
}

const slotKey = (i: { tupleIndex: number; modalityIndex: number }): string => `${i.tupleIndex}-${i.modalityIndex}`;

describe('sweep cursor: seeded fuzz over hostile centres (real thumbnailPlan code)', () => {
  it('hands out every planned slot exactly once across 350 seeded schedules', () => {
    const rand = lcg(20260821);
    let sawNonEmpty = 0;
    for (let round = 0; round < 350; round++) {
      const tuples = 1 + Math.floor(rand() * 40);
      const mods = 1 + Math.floor(rand() * 5);
      const holes = new Set<string>();
      for (let t = 0; t < tuples; t++) {
        for (let m = 0; m < mods; m++) if (rand() < 0.15) holes.add(`${t}-m${m}`);
      }
      const { rows, modalities } = grid(tuples, mods, holes);
      const plan = planThumbnails(rows, modalities);
      const cursor = new SweepCursor(plan.items);

      const seen: string[] = [];
      // One extra turn of the loop than there are slots: a cursor that never ends is a hang, not a pass.
      for (let guard = 0; guard <= plan.items.length; guard++) {
        const item = cursor.next(hostileCentre(rand, tuples));
        if (!item) break;
        seen.push(slotKey(item));
      }

      expect(seen.length, `round ${round}`).toBe(plan.items.length);
      expect(new Set(seen).size, `round ${round}: no slot twice`).toBe(seen.length);
      expect(new Set(seen), `round ${round}: none missed`).toEqual(new Set(plan.items.map(slotKey)));
      expect(cursor.remaining, `round ${round}`).toBe(0);
      expect(cursor.next(0), `round ${round}: exhausted stays exhausted`).toBeUndefined();
      if (plan.items.length > 0) sawNonEmpty++;
    }
    // Non-vacuous: the rounds really did have slots to hand out.
    expect(sawNonEmpty).toBeGreaterThan(300);
  });
});

describe('sweep runner: seeded fuzz over moving centres and failing reads (real thumbnailPlan code)', () => {
  it('settles every slot exactly once and ends, across 24 seeded runs with rejections and drops', async () => {
    const rand = lcg(430711);
    // Non-vacuity census: the assertions below are about behaviour under rejections, silent drops
    // and missing slots, so a change to the sizes or the probabilities that stopped generating them
    // would leave this fuzz green and empty. Guarded generously below the measured run (639
    // dispatches, 101 Error rejections, 27 non-Error rejections, 63 silent nulls, 82 missing slots),
    // so re-seeding is allowed to move the numbers but not to degenerate them.
    const census = { dispatched: 0, errorRejections: 0, oddRejections: 0, silentDrops: 0, missingSlots: 0 };
    for (let round = 0; round < 24; round++) {
      const tuples = 1 + Math.floor(rand() * 25);
      const mods = 1 + Math.floor(rand() * 4);
      const holes = new Set<string>();
      for (let t = 0; t < tuples; t++) {
        for (let m = 0; m < mods; m++) if (rand() < 0.1) holes.add(`${t}-m${m}`);
      }
      const { rows, modalities } = grid(tuples, mods, holes);
      const plan = planThumbnails(rows, modalities);
      const missing = new Set(plan.missing.map(slotKey));
      const itemKeys = new Set(plan.items.map(slotKey));

      const settled: string[] = [];
      const missingReported: string[] = [];
      const progress: number[] = [];
      const post = (m: ExtensionMessage): void => {
        if (m.type === 'thumbnail') settled.push(`${m.tupleIndex}-${m.modalityIndex}`);
        else if (m.type === 'thumbnailError') {
          const k = `${m.tupleIndex}-${m.modalityIndex}`;
          (missing.has(k) ? missingReported : settled).push(k);
        } else if (m.type === 'thumbnailProgress') progress.push(m.current);
      };

      let centre = hostileCentre(rand, tuples);
      const silent: string[] = [];
      await runThumbnailSweep(plan, {
        makeThumbnail: (item) => {
          // The centre moves on every dispatch, so the pump re-aims into work it has already handed out.
          centre = hostileCentre(rand, tuples);
          census.dispatched++;
          const roll = rand();
          if (roll < 0.15) { census.errorRejections++; return Promise.reject(new Error(`decode failed ${slotKey(item)}`)); }
          if (roll < 0.2) { census.oddRejections++; return Promise.reject('nope'); }
          if (roll < 0.28) {
            // A host that dropped this slot silently: no post, but the slot is still settled.
            census.silentDrops++;
            silent.push(slotKey(item));
            return Promise.resolve(null);
          }
          return Promise.resolve(jpeg(1 + Math.floor(rand() * 9)));
        },
      }, post, { chunk: 1 + Math.floor(rand() * 8), centre: () => centre });

      const accounted = [...settled, ...silent];
      expect(accounted.length, `round ${round}: one settle per planned slot`).toBe(plan.items.length);
      expect(new Set(accounted), `round ${round}: exactly the planned slots`).toEqual(itemKeys);
      expect(new Set(accounted).size, `round ${round}: none settled twice`).toBe(accounted.length);
      expect(missingReported.sort(), `round ${round}: missing slots reported once each`).toEqual([...missing].sort());
      expect(progress.length, `round ${round}: one tick per item`).toBe(plan.items.length || 1);
      expect(progress[progress.length - 1], `round ${round}: the bar reaches total`).toBe(plan.total);
      expect(progress, `round ${round}: the bar never goes backwards`).toEqual(progress.slice().sort((a, b) => a - b));
      census.missingSlots += missing.size;
    }

    expect(census.dispatched, 'the fuzz really dispatched work').toBeGreaterThan(400);
    expect(census.errorRejections, 'Error rejections were really generated').toBeGreaterThan(50);
    expect(census.oddRejections, 'non-Error rejections were really generated').toBeGreaterThan(12);
    expect(census.silentDrops, 'silent null settles were really generated').toBeGreaterThan(30);
    expect(census.missingSlots, 'missing slots were really planned').toBeGreaterThan(40);
  });
});
