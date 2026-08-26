import { describe, it, expect } from 'vitest';
import { Priority, TaskCancelled, WorkPool } from '../../src/workPool';
import { planThumbnails, runThumbnailSweep, SWEEP_CHUNK, SWEEP_REQUEUE, ThumbnailBytes } from '../../src/thumbnailPlan';
import { ExtensionMessage } from '../../src/types';

// Two comparison tabs share one process-wide pool, and until the group rotation landed they shared
// one FIFO per priority: the tab that opened first had already handed the pool a whole chunk, so the
// second tab's first tile waited for that backlog to drain. Field report: "when one imagecompare tab
// is doing its loading, and I switch to or open another ic tab, the indexing does not begin until the
// old tab is switched to and let finish, or closed."
// Everything here runs on the REAL WorkPool and the REAL sweep runner; the numbers in
// docs/loading-architecture.md ("Two panels sweeping at once") are the same measurement at the
// field grid (746x10) rather than the small grid used here.
// (docs/loading-architecture.md: bulk-sweeps-share-the-pool)

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** Pool width 5 — the field shape: speculation collectively leaves one slot free, so 4 bulk slots. */
const WIDTH = 5;
const BULK_SLOTS = 4;

describe('work pool: round-robin between groups inside one priority', () => {
  it('alternates between two groups where a single FIFO drained the first group whole', async () => {
    const pool = new WorkPool(1);
    const order: string[] = [];
    const first = { release: (): void => {} };
    const blocked = new Promise<void>(r => { first.release = r; });
    pool.submit(() => blocked, { priority: Priority.VISIBLE });
    await settle();

    // Everything below is queued behind the one occupied slot, so admission order is observable.
    for (let i = 0; i < 4; i++) {
      pool.submit(async () => { order.push(`a${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'panel-a' });
    }
    for (let i = 0; i < 4; i++) {
      pool.submit(async () => { order.push(`b${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'panel-b' });
    }
    first.release();
    await settle(12);

    expect(order, `groups must interleave, got ${JSON.stringify(order)}`)
      .toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('keeps plain FIFO within a group, and for ungrouped work (the sweep\'s centre-out order)', async () => {
    const pool = new WorkPool(1);
    const order: string[] = [];
    let release!: () => void;
    pool.submit(() => new Promise<void>(r => { release = r; }), { priority: Priority.VISIBLE });
    await settle();

    for (let i = 0; i < 3; i++) {
      pool.submit(async () => { order.push(`g${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'one' });
    }
    for (let i = 0; i < 3; i++) {
      pool.submit(async () => { order.push(`u${i}`); }, { priority: Priority.THUMBNAIL_BULK });
    }
    release();
    await settle(12);

    // One group and one ungrouped bucket: within each, submit order is untouched.
    expect(order.filter(o => o.startsWith('g'))).toEqual(['g0', 'g1', 'g2']);
    expect(order.filter(o => o.startsWith('u'))).toEqual(['u0', 'u1', 'u2']);
  });

  it('a group that joins late enters the rotation without disturbing the others', async () => {
    const pool = new WorkPool(1);
    const order: string[] = [];
    let release!: () => void;
    pool.submit(() => new Promise<void>(r => { release = r; }), { priority: Priority.THUMBNAIL_BULK });
    await settle();
    for (let i = 0; i < 4; i++) {
      pool.submit(async () => { order.push(`a${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'a' });
    }
    pool.submit(async () => { order.push('b0'); }, { priority: Priority.THUMBNAIL_BULK, group: 'b' });
    release();
    await settle(12);

    // b joined with four of a's already queued: it is served second, not fifth.
    expect(order, `late group starved: ${JSON.stringify(order)}`).toEqual(['a0', 'b0', 'a1', 'a2', 'a3']);
  });

  it('cancelling one group leaves the other group\'s order and the rotation intact', async () => {
    const pool = new WorkPool(1);
    const order: string[] = [];
    let release!: () => void;
    pool.submit(() => new Promise<void>(r => { release = r; }), { priority: Priority.VISIBLE });
    await settle();
    const rejections: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      pool.submit(async () => { order.push(`a${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'a', key: 'ka' })
        .catch(e => rejections.push(e));
      pool.submit(async () => { order.push(`b${i}`); }, { priority: Priority.THUMBNAIL_BULK, group: 'b', key: 'kb' });
    }
    expect(pool.pending).toBe(6);
    pool.cancel('ka');
    expect(pool.pending).toBe(3);
    release();
    await settle(12);

    expect(rejections.every(e => e instanceof TaskCancelled)).toBe(true);
    expect(order).toEqual(['b0', 'b1', 'b2']);
  });
});

// ── The same rotation seen from the sweep runner, at the field's grid shape ──

function grid(tuples: number, mods: number) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.map(m => ({ modality: m, name: `${t}_${m}.png` })),
  }));
  return { rows, modalities };
}

const jpeg = (): ThumbnailBytes => ({ bytes: new Uint8Array(4), mime: 'image/jpeg' });

interface PanelRig {
  io: { makeThumbnail: (item: { tupleIndex: number; modalityIndex: number; image: { modality: string } }) => Promise<ThumbnailBytes | typeof SWEEP_REQUEUE>; dropQueued: () => void };
  post: (m: ExtensionMessage) => void;
  delivered: string[];
}

/** One panel's half of the sweep IO, on a shared pool, exactly as the provider wires it. */
function panelRig(pool: WorkPool, name: string, started: string[], release: Array<() => void>): PanelRig {
  const rig: PanelRig = {
    delivered: [],
    post: (m: ExtensionMessage) => {
      if (m.type === 'thumbnail') rig.delivered.push(`${name}:${m.tupleIndex}-${m.modalityIndex}`);
    },
    io: {
      makeThumbnail: item =>
        pool
          .submit(
            () =>
              new Promise<ThumbnailBytes>(resolve => {
                started.push(name);
                release.push(() => resolve(jpeg()));
              }),
            { priority: Priority.THUMBNAIL_BULK, key: `${name}-sweep`, group: name }
          )
          .catch(error => {
            if (error instanceof TaskCancelled) return SWEEP_REQUEUE;
            throw error;
          }),
      dropQueued: () => pool.cancel(`${name}-sweep`),
    },
  };
  return rig;
}

describe('two panels sweeping at once', () => {
  it('serves the second tab within one batch instead of after the first tab\'s whole queued chunk', async () => {
    const pool = new WorkPool(WIDTH);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(40, 4);

    const a = panelRig(pool, 'a', started, release);
    const sweepA = runThumbnailSweep(planThumbnails(rows, modalities), a.io, a.post, { centre: () => ({ tuple: 0 }) });
    await settle();
    // The first tab has handed the pool its whole chunk: 4 reading, 28 queued behind them.
    expect(started.length).toBe(BULK_SLOTS);
    expect(pool.pending).toBe(SWEEP_CHUNK - BULK_SLOTS);

    const b = panelRig(pool, 'b', started, release);
    const sweepB = runThumbnailSweep(planThumbnails(rows, modalities), b.io, b.post, { centre: () => ({ tuple: 0 }) });
    await settle();
    const startsBeforeB = started.length;

    // Release whole batches until the second tab has read something: each batch is the pool's 4 bulk
    // slots, ~1.6 s of wall time at the field's cold per-thumbnail cost.
    let batches = 0;
    while (!started.slice(startsBeforeB).includes('b') && batches++ < 40) {
      for (const r of release.splice(0)) r();
      await settle();
    }
    const waited = started.slice(startsBeforeB).indexOf('b');
    expect(waited, 'the second tab never got a slot').toBeGreaterThanOrEqual(0);
    expect(waited, `second tab waited ${waited} reads of the first tab's backlog`).toBeLessThanOrEqual(BULK_SLOTS);
    expect(batches, `second tab waited ${batches} batches`).toBeLessThanOrEqual(1);

    // Both grids still complete, each slot exactly once.
    let guard = 0;
    while (release.length && guard++ < 5000) {
      for (const r of release.splice(0)) r();
      await settle(2);
    }
    await Promise.all([sweepA, sweepB]);
    expect(a.delivered.length).toBe(160);
    expect(new Set(a.delivered).size).toBe(160);
    expect(b.delivered.length).toBe(160);
    expect(new Set(b.delivered).size).toBe(160);
  });

  it('splits the bulk slots roughly evenly once both tabs are sweeping', async () => {
    const pool = new WorkPool(WIDTH);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { rows, modalities } = grid(40, 4);

    const a = panelRig(pool, 'a', started, release);
    const sweepA = runThumbnailSweep(planThumbnails(rows, modalities), a.io, a.post, { centre: () => ({ tuple: 0 }) });
    await settle();
    const b = panelRig(pool, 'b', started, release);
    const sweepB = runThumbnailSweep(planThumbnails(rows, modalities), b.io, b.post, { centre: () => ({ tuple: 0 }) });
    await settle();

    const joinedAt = started.length;
    // Drain batches until 32 reads have started since the second tab joined — one chunk's worth.
    let batches = 0;
    while (started.length - joinedAt < SWEEP_CHUNK && batches++ < 40) {
      for (const r of release.splice(0)) r();
      await settle(2);
    }
    const window = started.slice(joinedAt, joinedAt + SWEEP_CHUNK);
    const bShare = window.filter(n => n === 'b').length / window.length;
    // A single FIFO gave the second tab 4 of these 32 (12%): the first tab's queued chunk came first.
    expect(bShare, `second tab got ${(bShare * 100).toFixed(0)}% of the bulk slots`).toBeGreaterThan(0.4);
    expect(bShare).toBeLessThanOrEqual(0.6);

    let guard = 0;
    while (release.length && guard++ < 5000) {
      for (const r of release.splice(0)) r();
      await settle(2);
    }
    await Promise.all([sweepA, sweepB]);
  });
});
