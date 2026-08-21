import { describe, it, expect } from 'vitest';
import { SweepAim, SweepCursor, planThumbnails, runThumbnailSweep, SWEEP_REQUEUE, ThumbnailBytes } from '../../src/thumbnailPlan';
import { ExtensionMessage } from '../../src/types';

// The sweep's SECOND axis, on the real thumbnailPlan code. Every expected sequence here is written
// out by hand from the rule in the docs — the focused tile, then its cross interleaved at equal
// rate (row arm first, forward first on a tie within an arm) with the COLUMN arm bounded at one
// screenful, then everything remaining row-major centre-out — and not re-derived from the cursor,
// because a sequence read back off the implementation would pass with any tie-break inverted.
// (docs/loading-architecture.md: sweep-cross-then-row-major, thumbnails-centre-out,
//  sweep-covers-every-slot-once; docs/session-files.md: hidden-is-presentation-only)

/** A dense grid of `tuples` rows x `mods` columns; every slot populated unless `holes` says otherwise. */
function grid(tuples: number, mods: number, holes: ReadonlySet<string> = new Set()) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.filter(m => !holes.has(`${t}-${m}`)).map(m => ({ modality: m, name: `${t}_${m}.png` })),
  }));
  return { rows, modalities };
}

const key = (i: { tupleIndex: number; modalityIndex: number }): string => `${i.tupleIndex}-${i.modalityIndex}`;

/** Every slot the cursor hands out under one fixed aim, in order. */
function drain(tuples: number, mods: number, aim: SweepAim, holes?: ReadonlySet<string>): string[] {
  const { rows, modalities } = grid(tuples, mods, holes);
  const cursor = new SweepCursor(planThumbnails(rows, modalities).items);
  const order: string[] = [];
  for (let guard = 0; guard < tuples * mods + 1; guard++) {
    const item = cursor.next(aim);
    if (!item) break;
    order.push(key(item));
  }
  return order;
}

const jpeg = (length: number): ThumbnailBytes => ({ bytes: new Uint8Array(length), mime: 'image/jpeg' });

describe('sweep cursor: the cross first, then row-major (real thumbnailPlan code)', () => {
  it('fills the focused row and column interleaved, then the rest row-major centre-out', () => {
    // 5x3 aimed at (row 2, column m1). Column ranks from m1: m2 (forward wins the distance-1 tie),
    // then m0. Cross: focus, row arm m2, column arm 3, row arm m0, column arm 1, then 4 and 0 with
    // the row arm spent. Then row-major centre-out over what is left, each row in the same column
    // rank order: row 3 (m2, m0), row 1, row 4, row 0.
    expect(drain(5, 3, { tuple: 2, modality: 1 })).toEqual([
      '2-1',
      '2-2', '3-1', '2-0', '1-1', '4-1', '0-1',
      '3-2', '3-0', '1-2', '1-0', '4-2', '4-0', '0-2', '0-0',
    ]);
  });

  it('stops the column arm at the radius and finishes row-major, nearest row first', () => {
    // 7x3 aimed at (row 3, m0) with a radius of ONE row: the cross is focus, m1, row 4, m2, row 2 —
    // and then it is spent. Row-major centre-out takes over with the rest of row 4, the rest of row
    // 2, then rows 5, 1, 6, 0 whole. An unbounded arm would put 5-0 and 1-0 before 4-1; a taxicab
    // remainder would put 2-1 (distance 2) before 4-2 (distance 3).
    expect(drain(7, 3, { tuple: 3, modality: 0, radius: 1 })).toEqual([
      '3-0', '3-1', '4-0', '3-2', '2-0',
      '4-1', '4-2', '2-1', '2-2',
      '5-0', '5-1', '5-2', '1-0', '1-1', '1-2',
      '6-0', '6-1', '6-2', '0-0', '0-1', '0-2',
    ]);
  });

  it('a radius past the ends of the grid is simply the whole column', () => {
    // 3x2 aimed at (1, m0) with a radius of 99: the column arm has two rows and stops there.
    expect(drain(3, 2, { tuple: 1, modality: 0, radius: 99 })).toEqual([
      '1-0', '1-1', '2-0', '0-0', '2-1', '0-1',
    ]);
  });

  it('a radius of zero is still one row of cross, never none', () => {
    // A host reporting 0 visible rows (a collapsed carousel) must not turn the cross off entirely:
    // the column arm keeps its first step, so the row below still leads the row-major remainder.
    expect(drain(4, 2, { tuple: 1, modality: 0, radius: 0 })).toEqual([
      '1-0', '1-1', '2-0', '0-0', '2-1', '0-1', '3-0', '3-1',
    ]);
  });

  it('alternates the two arms one slot each, instead of draining the row it is on', () => {
    // 5x5 aimed at (2, m2): with five columns a row-major sweep would take all five of row 2 before
    // row 3 was touched. The cross alternates: m3, row 3, m1, row 1, m4, row 4, m0, row 0.
    expect(drain(5, 5, { tuple: 2, modality: 2 }).slice(0, 9)).toEqual([
      '2-2', '2-3', '3-2', '2-1', '1-2', '2-4', '4-2', '2-0', '0-2',
    ]);
  });

  it('an arm that runs out lets the other continue, without losing its turn order', () => {
    // 2x4 aimed at (0, m0): the column arm has exactly one slot (row 1), the row arm three.
    expect(drain(2, 4, { tuple: 0, modality: 0 })).toEqual([
      '0-0', '0-1', '1-0', '0-2', '0-3',
      '1-1', '1-2', '1-3',
    ]);
  });

  it('skips empty cells without spending an arm turn on them', () => {
    // 3x3 aimed at (1, m0) with the row arm's nearest slot missing: m1 is skipped, so the row arm's
    // turn delivers m2 — the alternation counts slots that exist, not grid positions. The cross is
    // then spent, and the row-major remainder opens with what is left of row 2.
    const holes = new Set(['1-m1']);
    expect(drain(3, 3, { tuple: 1, modality: 0 }, holes).slice(0, 5)).toEqual([
      '1-0', '1-2', '2-0', '0-0', '2-1',
    ]);
  });

  it('a single-column grid is exactly the old row order', () => {
    expect(drain(5, 1, { tuple: 2 })).toEqual(['2-0', '3-0', '1-0', '4-0', '0-0']);
  });

  it('with no column supplied it aims at the strip\'s first column', () => {
    expect(drain(3, 2, { tuple: 1 })).toEqual(['1-0', '1-1', '2-0', '0-0', '2-1', '0-1']);
  });
});

describe('sweep cursor: column distance is display distance (real thumbnailPlan code)', () => {
  it('ranks columns by the strip as shown, translating the aim out of original space', () => {
    // The user reordered the strip to [m3, m2, m1, m0] and is on m2 — display position 1. Nearest
    // display neighbours are m1 (position 2, forward) then m3 (position 0), and m0 is furthest,
    // which is the opposite of what raw original-index distance would say.
    const order = drain(4, 4, { tuple: 1, modality: 2, modalityOrder: [3, 2, 1, 0] });
    expect(order.slice(0, 6)).toEqual(['1-2', '1-1', '2-2', '1-3', '0-2', '1-0']);
    expect(order.length).toBe(16);
    expect(new Set(order).size).toBe(16);
  });

  it('hidden columns are swept last, never dropped', () => {
    // m1 is hidden: it is still on screen in the carousel, so it is still swept — but after every
    // visible column, which makes the column ranks m0, m2, m3, m1.
    const order = drain(3, 4, { tuple: 1, modality: 0, hidden: [1] });
    expect(order.slice(0, 7)).toEqual(['1-0', '1-2', '2-0', '1-3', '0-0', '1-1', '2-2']);
    expect(order.length).toBe(12);
    expect(new Set(order).size).toBe(12);
    expect(order).toContain('0-1');
    expect(order).toContain('2-1');
  });

  it('the focused column is swept first even when the user has hidden it', () => {
    // Hiding the column you are looking at is reachable by click and by digit jump, so it keeps its
    // place at the head of the order; the other hidden column still goes last.
    expect(drain(2, 3, { tuple: 0, modality: 1, hidden: [1, 2] })).toEqual([
      '0-1', '0-0', '1-1', '0-2', '1-0', '1-2',
    ]);
  });
});

describe('sweep cursor: returning a slot rewinds both axes (real thumbnailPlan code)', () => {
  it('hands back a slot the walk has passed on the column axis, at the head of what is left', () => {
    const { rows, modalities } = grid(3, 3);
    const plan = planThumbnails(rows, modalities);
    const cursor = new SweepCursor(plan.items);
    const aim = { tuple: 1, modality: 0 };
    const slot = (k: string) => plan.items.find(i => key(i) === k)!;

    // The cross from (1, m0): the tile, m1, row 2, m2, row 0 — and then it is spent.
    const taken: string[] = [];
    for (let i = 0; i < 5; i++) taken.push(key(cursor.next(aim)!));
    expect(taken).toEqual(['1-0', '1-1', '2-0', '1-2', '0-0']);

    // 1-2 is behind the walk on the COLUMN axis alone: same row as the aim, two columns out.
    cursor.putBack(slot('1-2'));
    expect(cursor.remaining).toBe(5);
    // It comes back at the head of what is left, because it is the nearest remaining slot.
    expect(key(cursor.next(aim)!)).toBe('1-2');

    // Two more from the row-major remainder, which puts the walk past the aimed row entirely.
    expect([key(cursor.next(aim)!), key(cursor.next(aim)!)]).toEqual(['2-1', '2-2']);

    // Now the walk is at row 0 and the returned slot is a row BEHIND it, in the aimed row itself:
    // a rewind that only moves on the row axis would leave this one to the end of the sweep.
    cursor.putBack(slot('1-1'));
    expect(cursor.remaining).toBe(3);
    expect(key(cursor.next(aim)!)).toBe('1-1');

    const rest: string[] = [];
    for (let guard = 0; guard < 10 && cursor.remaining > 0; guard++) rest.push(key(cursor.next(aim)!));
    expect(rest).toEqual(['0-1', '0-2']);
    expect(cursor.next(aim)).toBeUndefined();
  });

  it('returns a slot at the radius boundary the remainder has already passed, and hands it back through the cross', () => {
    const { rows, modalities } = grid(7, 3);
    const plan = planThumbnails(rows, modalities);
    const cursor = new SweepCursor(plan.items);
    const aim = { tuple: 3, modality: 0, radius: 1 };

    // The bounded cross, then the remainder's rows 4, 2 and 5 — the walk is now well past row 4.
    const taken: string[] = [];
    for (let i = 0; i < 12; i++) taken.push(key(cursor.next(aim)!));
    expect(taken).toEqual([
      '3-0', '3-1', '4-0', '3-2', '2-0',
      '4-1', '4-2', '2-1', '2-2',
      '5-0', '5-1', '5-2',
    ]);

    // 4-0 is the cross's own boundary cell: the furthest row its column arm was allowed to reach.
    // A rewind that only fires for slots OUTSIDE the cross would leave this one to the sweep's tail.
    cursor.putBack(plan.items.find(i => key(i) === '4-0')!);
    expect(cursor.remaining).toBe(10);
    expect(key(cursor.next(aim)!)).toBe('4-0');

    // And the rest still arrives row-major centre-out, each slot exactly once.
    const rest: string[] = [];
    for (let guard = 0; guard < 20 && cursor.remaining > 0; guard++) rest.push(key(cursor.next(aim)!));
    expect(rest).toEqual(['1-0', '1-1', '1-2', '6-0', '6-1', '6-2', '0-0', '0-1', '0-2']);
    expect(cursor.next(aim)).toBeUndefined();
  });

  it('a slot returned after the aim moved is re-placed by the NEW aim, not the old one', () => {
    const { rows, modalities } = grid(3, 3);
    const plan = planThumbnails(rows, modalities);
    const cursor = new SweepCursor(plan.items);
    const first = { tuple: 0, modality: 0 };
    expect(key(cursor.next(first)!)).toBe('0-0');
    const returned = plan.items.find(i => key(i) === '0-0')!;
    cursor.putBack(returned);
    // The user is now at (2, m2); the returned corner is the furthest tile there, not the nearest.
    const second = { tuple: 2, modality: 2 };
    expect(key(cursor.next(second)!)).toBe('2-2');
    const order = ['2-2'];
    for (let guard = 0; guard < 10 && cursor.remaining > 0; guard++) order.push(key(cursor.next(second)!));
    expect(order).toEqual(['2-2', '2-1', '1-2', '2-0', '0-2', '1-1', '1-0', '0-1', '0-0']);
  });
});

// Seeded fuzz, not random fuzz: an LCG with a fixed seed, so a failure reproduces exactly. What it
// pins is the property no schedule may break — every planned slot handed out exactly once — while
// the aim moves on BOTH axes and slots are returned mid-walk, which is the case `putBack`'s
// two-axis rewind exists for. (docs/loading-architecture.md: sweep-covers-every-slot-once)

/** 32-bit LCG; same seed, same run, on every machine and every day. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fuzzAim(rand: () => number, tuples: number, mods: number): SweepAim {
  const aim: SweepAim = { tuple: Math.floor(rand() * tuples) };
  const roll = rand();
  if (roll < 0.15) aim.modality = Number.NaN;
  else if (roll < 0.3) aim.modality = mods + Math.floor(rand() * 3);
  else if (roll < 0.85) aim.modality = Math.floor(rand() * mods);
  if (rand() < 0.35) {
    const order = Array.from({ length: mods }, (_, m) => m);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    aim.modalityOrder = order;
  }
  if (rand() < 0.4) aim.hidden = Array.from({ length: mods }, (_, m) => m).filter(() => rand() < 0.5);
  // The radius is the phase boundary: 0, 1, mid-grid, past the end and NaN each move it somewhere else.
  const r = rand();
  if (r < 0.15) aim.radius = 0;
  else if (r < 0.3) aim.radius = 1;
  else if (r < 0.5) aim.radius = 1 + Math.floor(rand() * tuples);
  else if (r < 0.6) aim.radius = tuples + Math.floor(rand() * 50);
  else if (r < 0.7) aim.radius = Number.NaN;
  return aim;
}

describe('sweep cursor: seeded fuzz over 2-D aims with slots returned mid-walk', () => {
  it('hands out every planned slot exactly once across 300 seeded schedules', () => {
    const rand = lcg(20260821);
    const census = { returns: 0, returnsMidHold: 0, columnsMoved: 0, radiiMoved: 0, longestHold: 0, rounds: 0 };
    for (let round = 0; round < 300; round++) {
      const tuples = 1 + Math.floor(rand() * 25);
      const mods = 1 + Math.floor(rand() * 8);
      const holes = new Set<string>();
      for (let t = 0; t < tuples; t++) {
        for (let m = 0; m < mods; m++) if (rand() < 0.12) holes.add(`${t}-m${m}`);
      }
      const { rows, modalities } = grid(tuples, mods, holes);
      const plan = planThumbnails(rows, modalities);
      const cursor = new SweepCursor(plan.items);

      const seen: string[] = [];
      // The aim is HELD for a run of calls, the way a real host holds one between dwells: a return
      // that lands mid-run is the case the rewind exists for, and an aim re-rolled per call would
      // discard the walk anyway and never exercise it.
      let aim = fuzzAim(rand, tuples, mods);
      let held = 0;
      let hold = 1 + Math.floor(rand() * 6);
      // Generous: every slot may be handed out, returned, and handed out again.
      for (let guard = 0; guard <= plan.items.length * 3 + 4; guard++) {
        if (held >= hold) {
          const moved = fuzzAim(rand, tuples, mods);
          if (moved.modality !== aim.modality) census.columnsMoved++;
          if (moved.radius !== aim.radius) census.radiiMoved++;
          aim = moved;
          held = 0;
          hold = 1 + Math.floor(rand() * 6);
        }
        held++;
        census.longestHold = Math.max(census.longestHold, held);
        const item = cursor.next(aim);
        if (!item) break;
        // A dropped dispatch: back to the cursor, never counted, and owed again.
        if (rand() < 0.25 && seen.length > 0) {
          cursor.putBack(item);
          census.returns++;
          if (held > 1) census.returnsMidHold++;
          continue;
        }
        seen.push(key(item));
      }

      expect(seen.length, `round ${round}`).toBe(plan.items.length);
      expect(new Set(seen).size, `round ${round}: no slot twice`).toBe(seen.length);
      expect(new Set(seen), `round ${round}: none missed`).toEqual(new Set(plan.items.map(key)));
      expect(cursor.remaining, `round ${round}`).toBe(0);
      expect(cursor.next({ tuple: 0 }), `round ${round}: exhausted stays exhausted`).toBeUndefined();
      census.rounds++;
    }
    // Non-vacuous: the schedules really returned slots and really moved the column.
    expect(census.rounds).toBe(300);
    expect(census.returns).toBeGreaterThan(500);
    // Most returns really landed under an aim the schedule was already holding — the walk was live,
    // not about to be discarded by a fresh aim, so the rewind is what had to bring them back.
    expect(census.returnsMidHold).toBeGreaterThan(300);
    expect(census.longestHold).toBeGreaterThanOrEqual(6);
    expect(census.columnsMoved).toBeGreaterThan(200);
    // The phase boundary really moved under the returns, which is where a bounded arm can drop a slot.
    expect(census.radiiMoved).toBeGreaterThan(200);
  });
});

describe('sweep runner: an aim rebuilt per read is not a re-aim (real thumbnailPlan code)', () => {
  it('drops nothing while the host reports the same tile from a fresh object', async () => {
    const { rows, modalities } = grid(20, 3);
    const plan = planThumbnails(rows, modalities);
    const strip = [0, 1, 2];
    let drops = 0;
    const delivered = new Set<string>();
    const post = (m: ExtensionMessage): void => {
      if (m.type === 'thumbnail') delivered.add(`${m.tupleIndex}-${m.modalityIndex}`);
    };
    await runThumbnailSweep(plan, {
      makeThumbnail: () => Promise.resolve(jpeg(3)),
      dropQueued: () => { drops++; },
    }, post, {
      chunk: 4,
      // The provider builds this object on every read; equal aims must compare equal by value.
      centre: () => ({ tuple: 7, modality: 1, modalityOrder: strip.slice(), hidden: [] }),
    });
    expect(delivered.size).toBe(plan.items.length);
    expect(drops).toBe(0);
  });

  it('a non-finite radius reads as no report, so a host that sends one never re-aims on it', async () => {
    const { rows, modalities } = grid(9, 2);
    const plan = planThumbnails(rows, modalities);
    let drops = 0;
    const delivered = new Set<string>();
    const post = (m: ExtensionMessage): void => {
      if (m.type === 'thumbnail') delivered.add(`${m.tupleIndex}-${m.modalityIndex}`);
    };
    await runThumbnailSweep(plan, {
      makeThumbnail: () => Promise.resolve(jpeg(3)),
      dropQueued: () => { drops++; },
    }, post, {
      chunk: 4,
      // NaN is not equal to itself: unnormalized, this aim differs from the one before it on every
      // single read, and every settle would drop the queue it had just filled.
      centre: () => ({ tuple: 4, modality: 0, radius: Number.NaN }),
    });
    expect(delivered.size).toBe(plan.items.length);
    expect(drops).toBe(0);
  });

  it('drops the queue when only the COLUMN moves, and still delivers every slot once', async () => {
    const { rows, modalities } = grid(12, 4);
    const plan = planThumbnails(rows, modalities);
    let column = 0;
    let drops = 0;
    let dispatched = 0;
    const delivered = new Map<string, number>();
    const post = (m: ExtensionMessage): void => {
      if (m.type !== 'thumbnail') return;
      const k = `${m.tupleIndex}-${m.modalityIndex}`;
      delivered.set(k, (delivered.get(k) ?? 0) + 1);
    };
    const queued: Array<{ item: { tupleIndex: number; modalityIndex: number }; settle: (v: ThumbnailBytes | typeof SWEEP_REQUEUE) => void }> = [];
    const sweep = runThumbnailSweep(plan, {
      makeThumbnail: item => new Promise<ThumbnailBytes | typeof SWEEP_REQUEUE>(resolve => {
        dispatched++;
        queued.push({ item, settle: resolve });
      }),
      // The host's drop: everything not yet settled comes back, as a cancelled pool task would.
      dropQueued: () => {
        drops++;
        for (const q of queued.splice(0)) q.settle(SWEEP_REQUEUE);
      },
    }, post, { chunk: 4, centre: () => ({ tuple: 5, modality: column }) });

    // The row never moves; only the column the user is on does.
    for (let step = 0; step < 40 && queued.length > 0; step++) {
      column = (column + 1) % 4;
      const next = queued.shift()!;
      next.settle(jpeg(2));
      await new Promise<void>(r => setTimeout(r, 0));
    }
    let guard = 0;
    while (queued.length > 0 && guard++ < 500) {
      queued.shift()!.settle(jpeg(2));
      await new Promise<void>(r => setTimeout(r, 0));
    }
    await sweep;

    expect(drops).toBeGreaterThan(0);
    expect(delivered.size).toBe(plan.items.length);
    expect([...delivered.values()].every(n => n === 1)).toBe(true);
    // Requeued work is re-dispatched, so more dispatches than slots — but never a second delivery.
    expect(dispatched).toBeGreaterThanOrEqual(plan.items.length);
  });
});
