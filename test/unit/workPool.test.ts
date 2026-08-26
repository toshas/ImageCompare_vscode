import { describe, it, expect } from 'vitest';
import { WorkPool, Priority, TaskCancelled, poolWidth, usableParallelism } from '../../src/workPool';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
// A controllable task: resolves when release() is called.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe('bounded priority work pool (real workPool code)', () => {
  it('Test 1: concurrency is never exceeded', async () => {
    const pool = new WorkPool(2);
    let peak = 0;
    let cur = 0;
    const gates = Array.from({ length: 6 }, () => gate());
    const tasks = gates.map((g, i) =>
      pool.submit(async () => {
        cur++;
        peak = Math.max(peak, cur);
        await g.promise;
        cur--;
      }, { priority: Priority.VISIBLE })
    );
    await tick();
    expect(pool.running, `expected 2 running, got ${pool.running}`).toBe(2);
    expect(pool.pending, `expected 4 pending, got ${pool.pending}`).toBe(4);
    gates.forEach((g) => g.release());
    await Promise.all(tasks);
    expect(peak, `concurrency should cap at 2, peaked at ${peak}`).toBe(2);
  });

  it('Test 2: strict priority ordering + FIFO within a priority', async () => {
    const pool = new WorkPool(1);
    const order: string[] = [];
    const first = gate(); // occupy the single slot
    pool.submit(async () => {
      await first.promise;
    }, { priority: Priority.VISIBLE });
    await tick();
    // Enqueue out of priority order, and two at the same priority to check FIFO.
    pool.submit(async () => { order.push('thumb'); }, { priority: Priority.THUMBNAIL });
    pool.submit(async () => { order.push('prefetch'); }, { priority: Priority.PREFETCH });
    pool.submit(async () => { order.push('visibleA'); }, { priority: Priority.VISIBLE });
    pool.submit(async () => { order.push('visibleB'); }, { priority: Priority.VISIBLE });
    first.release();
    await tick();
    await tick();
    expect(order, `priority/FIFO order wrong: ${JSON.stringify(order)}`)
      .toEqual(['visibleA', 'visibleB', 'prefetch', 'thumb']);
  });

  it('Test 3: cancel() drops queued tasks and never starts them', async () => {
    const pool = new WorkPool(1);
    const first = gate();
    pool.submit(async () => { await first.promise; }, { priority: Priority.VISIBLE });
    await tick();
    let started: boolean = false;
    const cancelled = pool.submit(async () => { started = true; }, { priority: Priority.PREFETCH, key: 'wave1' });
    let rejectedWith: unknown;
    cancelled.catch((e) => (rejectedWith = e));
    pool.cancel('wave1');
    first.release();
    await tick();
    expect(started, 'cancelled task must not run').toBe(false);
    expect(rejectedWith instanceof TaskCancelled, 'cancelled task should reject with TaskCancelled').toBe(true);
  });

  it('Test 4: a running task is NOT cancelled', async () => {
    const pool = new WorkPool(1);
    const g = gate();
    let finished: boolean = false;
    const p = pool.submit(async () => { await g.promise; finished = true; }, { priority: Priority.VISIBLE, key: 'k' });
    await tick();
    pool.cancel('k'); // task already running
    g.release();
    await p;
    expect(finished, 'running task must complete despite cancel').toBe(true);
  });

  it('Test 5: pins the (priority, seq) key — better priority wins, equal priority keeps submit order', async () => {
    const pool = new WorkPool(1);
    const first = gate();
    pool.submit(async () => { await first.promise; }, { priority: Priority.VISIBLE });
    await tick();
    const order: string[] = [];
    pool.submit(async () => { order.push('bulk1'); }, { priority: Priority.THUMBNAIL_BULK });
    pool.submit(async () => { order.push('bulk2'); }, { priority: Priority.THUMBNAIL_BULK });
    pool.submit(async () => { order.push('sibling'); }, { priority: Priority.SIBLING });
    pool.submit(async () => { order.push('visible'); }, { priority: Priority.VISIBLE });
    first.release();
    await tick();
    await tick();
    expect(order, `priority beats submit order, ties keep it: ${JSON.stringify(order)}`)
      .toEqual(['visible', 'sibling', 'bulk1', 'bulk2']);
  });

  it('Full priority ladder, pinned against a hand-written expectation rather than the enum itself', async () => {
    const pool = new WorkPool(1);
    const first = gate();
    pool.submit(async () => { await first.promise; }, { priority: Priority.VISIBLE });
    await tick();
    const order: string[] = [];
    // Submitted worst-first, so only the ordering can produce the expected sequence.
    pool.submit(async () => { order.push('tail'); }, { priority: Priority.SIBLING_TAIL });
    pool.submit(async () => { order.push('poll'); }, { priority: Priority.POLL });
    pool.submit(async () => { order.push('bulk'); }, { priority: Priority.THUMBNAIL_BULK });
    pool.submit(async () => { order.push('thumb'); }, { priority: Priority.THUMBNAIL });
    pool.submit(async () => { order.push('prefetch'); }, { priority: Priority.PREFETCH });
    pool.submit(async () => { order.push('export'); }, { priority: Priority.EXPORT });
    pool.submit(async () => { order.push('sibling'); }, { priority: Priority.SIBLING });
    pool.submit(async () => { order.push('visible'); }, { priority: Priority.VISIBLE });
    first.release();
    for (let i = 0; i < 8; i++) await tick();
    expect(order, `full priority ladder: ${JSON.stringify(order)}`)
      .toEqual(['visible', 'sibling', 'export', 'prefetch', 'thumb', 'bulk', 'poll', 'tail']);
    // Export is user-initiated: ahead of speculation, behind the image on screen.
    expect(Priority.SIBLING < Priority.EXPORT && Priority.EXPORT < Priority.PREFETCH,
      'EXPORT must rank between SIBLING and PREFETCH').toBe(true);
  });

  it('Test 7: concurrency is released on the REJECT path too; a missing `finally` would deadlock', async () => {
    const pool = new WorkPool(1);
    await pool.submit(async () => { throw new Error('x'); }, { priority: Priority.VISIBLE }).catch(() => undefined);
    let ran = false;
    await pool.submit(async () => { ran = true; }, { priority: Priority.VISIBLE });
    expect(ran, 'pool must keep running tasks after one rejects').toBe(true);
    await tick(); // the slot is released in a finally, i.e. after the awaited resolve
    expect(pool.running === 0 && pool.pending === 0, `pool should be idle, got ${pool.running}/${pool.pending}`).toBe(true);
  });

  it('Test 8: a synchronously-throwing fn is caught like a rejection', async () => {
    const pool = new WorkPool(1);
    let err: unknown;
    await pool.submit((() => { throw new Error('sync'); }) as unknown as () => Promise<void>, {
      priority: Priority.VISIBLE
    }).catch(e => (err = e));
    expect(err instanceof Error && (err as Error).message === 'sync', 'sync throw should reject, not escape').toBe(true);
    const ok = await pool.submit(async () => 1, { priority: Priority.VISIBLE });
    expect(ok, 'pool still usable after a sync throw').toBe(1);
  });

  it('Test 9: cancel() drops ALL queued tasks under a key and leaves the rest ordered', async () => {
    const pool = new WorkPool(1);
    const first = gate();
    pool.submit(async () => { await first.promise; }, { priority: Priority.VISIBLE });
    await tick();
    const order: string[] = [];
    const swallow = () => undefined; // these two get cancelled below
    pool.submit(async () => { order.push('a'); }, { priority: Priority.PREFETCH, key: 'w' }).catch(swallow);
    pool.submit(async () => { order.push('keep1'); }, { priority: Priority.PREFETCH });
    pool.submit(async () => { order.push('b'); }, { priority: Priority.PREFETCH, key: 'w' }).catch(swallow);
    pool.submit(async () => { order.push('keep2'); }, { priority: Priority.PREFETCH });
    const before = pool.pending;
    pool.cancel('w');
    expect(pool.pending, `cancel should drop exactly 2, ${before}->${pool.pending}`).toBe(before - 2);
    first.release();
    await tick();
    await tick();
    expect(order, `survivors must run in order: ${JSON.stringify(order)}`).toEqual(['keep1', 'keep2']);
  });

  it('Test 10: re-entrant submit needs a free slot; nesting on the last slot self-deadlocks by design', async () => {
    const pool = new WorkPool(2);
    let inner = false;
    await pool.submit(async () => {
      await pool.submit(async () => { inner = true; }, { priority: Priority.VISIBLE });
    }, { priority: Priority.VISIBLE });
    expect(inner, 're-entrant submit must not deadlock when a slot is free').toBe(true);
    await tick();
    expect(pool.running === 0 && pool.pending === 0, 'pool idle after re-entrant work').toBe(true);
  });

  it('Test 11: speculation leaves one slot free; user-facing work takes it immediately', async () => {
    const pool = new WorkPool(2);
    const g1 = gate();
    const g2 = gate();
    const p1 = pool.submit(async () => { await g1.promise; }, { priority: Priority.PREFETCH });
    const p2 = pool.submit(async () => { await g2.promise; }, { priority: Priority.PREFETCH });
    await tick();
    // Only one of the two speculative tasks may run: the last slot is reserved.
    expect(pool.running, `speculation must cap at concurrency-1, got ${pool.running} running`).toBe(1);
    expect(pool.pending, `second speculative task should queue, got ${pool.pending} pending`).toBe(1);
    let visibleRan = false;
    const pv = pool.submit(async () => { visibleRan = true; }, { priority: Priority.VISIBLE });
    await tick();
    expect(visibleRan, 'VISIBLE must start in the reserved slot while speculation runs').toBe(true);
    g1.release();
    g2.release();
    await Promise.all([p1, p2, pv]);
    expect(pool.running === 0 && pool.pending === 0, 'queued speculative task must still drain').toBe(true);
  });

  it('Test 12: at concurrency 1 the reservation is waived — speculation must not starve forever', async () => {
    const pool = new WorkPool(1);
    let ran = false;
    await pool.submit(async () => { ran = true; }, { priority: Priority.POLL });
    expect(ran, 'a speculative task must run at concurrency 1 (no reserved slot to leave)').toBe(true);
  });

  it('Test 13: a freed slot goes to queued background, not a further sibling — foreground at budget-1 defers', async () => {
    const pool = new WorkPool(2);
    const gV = gate();
    const gS1 = gate();
    const gS2 = gate();
    const gB = gate();
    let s2Started = false;
    let bStarted = false;
    const pv = pool.submit(async () => { await gV.promise; }, { priority: Priority.VISIBLE });
    const ps1 = pool.submit(async () => { await gS1.promise; }, { priority: Priority.SIBLING });
    await tick();
    expect(pool.running, `nothing queued below: V+S fill the pool, got ${pool.running}`).toBe(2);
    const ps2 = pool.submit(async () => { s2Started = true; await gS2.promise; }, { priority: Priority.SIBLING });
    const pb = pool.submit(async () => { bStarted = true; await gB.promise; }, { priority: Priority.THUMBNAIL_BULK });
    await tick();
    gV.release();
    await tick();
    expect(bStarted && !s2Started, 'the freed slot goes to the queued sweep item, not the third sibling').toBe(true);
    expect(pool.running, `one sibling + one sweep item run: got ${pool.running}`).toBe(2);
    gS1.release();
    await tick();
    expect(s2Started, 'the next freed slot goes back to the sibling').toBe(true);
    gS2.release();
    gB.release();
    await Promise.all([pv, ps1, ps2, pb]);
  });

  it('Test 14: prefetch leaves one speculative slot to the queued thumbnail sweep', async () => {
    const pool = new WorkPool(4);
    const gB = gate();
    const gP = [gate(), gate(), gate()];
    let bStarted = false;
    let pStarted = 0;
    const pb = pool.submit(async () => { bStarted = true; await gB.promise; }, { priority: Priority.THUMBNAIL_BULK });
    await tick();
    const pps = gP.map((g) =>
      pool.submit(async () => { pStarted++; await g.promise; }, { priority: Priority.PREFETCH })
    );
    await tick();
    expect(pool.running, `speculation stays at concurrency-1: got ${pool.running}`).toBe(3);
    expect(bStarted && pStarted === 2, `prefetch shares the speculative budget with the sweep: ${pStarted} prefetch + bulk=${bStarted}`).toBe(true);
    gB.release();
    gP.forEach((g) => g.release());
    await Promise.all([pb, ...pps]);
  });

  it('Test 15: within speculation, a freed slot goes to the queued sweep, not a further prefetch', async () => {
    const pool = new WorkPool(4);
    const gB1 = gate();
    const gP = [gate(), gate()];
    const gB2 = gate();
    const gP3 = gate();
    let b2Started = false;
    let p3Started = false;
    const pb1 = pool.submit(async () => { await gB1.promise; }, { priority: Priority.THUMBNAIL_BULK });
    const pps = gP.map((g) => pool.submit(async () => { await g.promise; }, { priority: Priority.PREFETCH }));
    await tick();
    expect(pool.running, `speculative budget is 3 of 4: got ${pool.running}`).toBe(3);
    const pb2 = pool.submit(async () => { b2Started = true; await gB2.promise; }, { priority: Priority.THUMBNAIL_BULK });
    const pp3 = pool.submit(async () => { p3Started = true; await gP3.promise; }, { priority: Priority.PREFETCH });
    await tick();
    gB1.release();
    await tick();
    expect(b2Started && !p3Started, 'the freed speculative slot goes to the queued sweep item, not more prefetch').toBe(true);
    gP.forEach((g) => g.release());
    await tick();
    gB2.release();
    gP3.release();
    await Promise.all([pb1, ...pps, pb2, pp3]);
  });

  it('Test 16: work-conserving — with nothing queued below, foreground uses the whole pool', async () => {
    const pool = new WorkPool(2);
    const gV = gate();
    const gS = gate();
    const pv = pool.submit(async () => { await gV.promise; }, { priority: Priority.VISIBLE });
    const ps = pool.submit(async () => { await gS.promise; }, { priority: Priority.SIBLING });
    await tick();
    expect(pool.running, `no background queued: both foreground tasks run, got ${pool.running}`).toBe(2);
    gV.release();
    gS.release();
    await Promise.all([pv, ps]);
  });

  it('Test 17: soak — mixed priorities, keys, throws and cancels; everything settles and the pool drains', async () => {
    let seed = 42;
    const rng = () => {
      // Deterministic (mulberry32): the repo forbids nondeterministic tests.
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pool = new WorkPool(3);
    const N = 400;
    let settled = 0;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      // All eight classes, SIBLING_TAIL included — its "only when nothing else is queued" admission is the one that can wedge the pool.
      const priority = Math.floor(rng() * 8) as Priority;
      const key = rng() < 0.2 ? `k${Math.floor(rng() * 5)}` : undefined;
      promises.push(
        pool
          .submit(async () => {
            if (rng() < 0.3) await new Promise<void>((r) => setTimeout(r, 0));
            if (rng() < 0.05) throw new Error('soak');
          }, { priority, key })
          .then(() => { settled++; }, () => { settled++; })
      );
      if (rng() < 0.1) pool.cancel(`k${Math.floor(rng() * 5)}`);
      if (rng() < 0.3) await Promise.resolve();
    }
    await Promise.all(promises);
    await tick();
    expect(settled, `every submission settles: ${settled}/${N}`).toBe(N);
    expect(pool.running === 0 && pool.pending === 0, `pool drains: ${pool.running}/${pool.pending}`).toBe(true);
  });

  it('Test 18: the sibling tail never takes a slot another class has queued work for', async () => {
    // Three speculative slots, two classes queued: the fair-share pick would split them. The tail is
    // the one class that must not be shared with (docs/loading-architecture.md: sibling-tail-never-competes).
    const pool = new WorkPool(4);
    const gV = gate();
    const bulk = [gate(), gate(), gate(), gate()];
    const tail = [gate(), gate()];
    let tailStarted = 0;
    let bulkStarted = 0;
    const pv = pool.submit(async () => { await gV.promise; }, { priority: Priority.VISIBLE });
    const pbs = bulk.map((g) => pool.submit(async () => { bulkStarted++; await g.promise; }, { priority: Priority.THUMBNAIL_BULK }));
    const pts = tail.map((g) => pool.submit(async () => { tailStarted++; await g.promise; }, { priority: Priority.SIBLING_TAIL }));
    await tick();
    expect(bulkStarted, `the sweep takes all three speculative slots, got ${bulkStarted}`).toBe(3);
    expect(tailStarted, `the tail must wait while any other class is queued, ${tailStarted} started`).toBe(0);
    // Even as sweep items complete, the slot goes back to the sweep's own queue.
    bulk[0].release();
    await tick();
    expect(tailStarted, 'a freed slot returns to the sweep, not the tail').toBe(0);
    gV.release();
    bulk.forEach((g) => g.release());
    tail.forEach((g) => g.release());
    await Promise.all([pv, ...pbs, ...pts]);
  });

  it('Test 19: the tail does use genuinely idle capacity (it is deferred, not disabled)', async () => {
    const pool = new WorkPool(4);
    const tail = [gate(), gate()];
    let started = 0;
    const pts = tail.map((g) => pool.submit(async () => { started++; await g.promise; }, { priority: Priority.SIBLING_TAIL }));
    await tick();
    expect(started, `nothing else queued: the tail runs, got ${started}`).toBe(2);
    tail.forEach((g) => g.release());
    await Promise.all(pts);
  });

  it('Test 6: result and error propagation', async () => {
    const pool = new WorkPool(2);
    const v = await pool.submit(async () => 42, { priority: Priority.VISIBLE });
    expect(v, `expected 42, got ${v}`).toBe(42);
    let err: unknown;
    await pool.submit(async () => { throw new Error('boom'); }, { priority: Priority.VISIBLE }).catch((e) => (err = e));
    expect(err instanceof Error && (err as Error).message === 'boom', 'error should propagate').toBe(true);
  });
});

// poolWidth is the one width rule both products feed their own parallelism count (extension:
// os.availableParallelism, standalone: navigator.hardwareConcurrency); values pinned as external
// literals from the measurement round (docs/loading-architecture.md: pool-width-hides-latency),
// not read back out of the formula: the decode ceiling is libuv's 4 threads on every host, so
// width past 4+2 buys no throughput (90 images: 2764ms at 6, 2794ms at 16) and costs interaction
// latency (a VISIBLE decode 525ms at width 4, 2799ms at width 16).
describe('poolWidth (shared width rule, real workPool code)', () => {
  it('clamps the pool width: saturate libuv, floor 1, cap 6', () => {
    expect(poolWidth(4), 'the measured 4-vCPU host lands in the optimal 5-6 band').toBe(5);
    expect(poolWidth(8), 'a mid-size host stops at the libuv ceiling plus slack').toBe(6);
    expect(poolWidth(3)).toBe(4);
    expect(poolWidth(2), 'two cores leave no second core to overlap onto').toBe(1);
    expect(poolWidth(1), 'a 1-core box still gets one slot').toBe(1);
    expect(poolWidth(0), 'an unreported core count still gets one slot').toBe(1);
    expect(poolWidth(17)).toBe(6);
    expect(poolWidth(64), 'the cap is libuv-derived, not core-derived').toBe(6);
  });

  it('sizes from usable parallelism, not the logical-core count', () => {
    expect(usableParallelism(4, 256), 'a cgroup/affinity-limited host: os.cpus() misreads by 64x').toBe(4);
    expect(poolWidth(usableParallelism(4, 256)), 'that host gets 5, not the 16 os.cpus() bought').toBe(5);
    expect(usableParallelism(undefined, 12), 'an old runtime falls back to the logical-core count').toBe(12);
    expect(usableParallelism(0, 8), 'a zero reading is no reading').toBe(8);
    expect(usableParallelism(undefined, undefined), 'neither reported: assume a small box').toBe(4);
  });

  it('an explicit width override wins over the auto rule', () => {
    expect(poolWidth(4, 12), 'imageCompare.maxConcurrentReads=12 on an unconstrained box').toBe(12);
    expect(poolWidth(4, 1)).toBe(1);
    expect(poolWidth(4, 0), '0 means auto').toBe(5);
    expect(poolWidth(4, -3), 'a nonsense override means auto').toBe(5);
  });
});
