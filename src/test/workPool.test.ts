/**
 * Tests for the bounded priority work pool. Imports the real implementation
 * (workPool.ts has no vscode dependency).
 *
 * Run: npx ts-node src/test/workPool.test.ts
 */

import { WorkPool, Priority, TaskCancelled } from '../workPool';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function printResults() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed!');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
// A controllable task: resolves when release() is called.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

async function run() {
  // Test 1: concurrency is never exceeded
  {
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
    assert(pool.running === 2, `expected 2 running, got ${pool.running}`);
    assert(pool.pending === 4, `expected 4 pending, got ${pool.pending}`);
    gates.forEach((g) => g.release());
    await Promise.all(tasks);
    assert(peak === 2, `concurrency should cap at 2, peaked at ${peak}`);
  }

  // Test 2: strict priority ordering + FIFO within a priority
  {
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
    assert(
      JSON.stringify(order) === JSON.stringify(['visibleA', 'visibleB', 'prefetch', 'thumb']),
      `priority/FIFO order wrong: ${JSON.stringify(order)}`
    );
  }

  // Test 3: cancel() drops queued tasks and never starts them
  {
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
    assert(!started, 'cancelled task must not run');
    assert(rejectedWith instanceof TaskCancelled, 'cancelled task should reject with TaskCancelled');
  }

  // Test 4: a running task is NOT cancelled
  {
    const pool = new WorkPool(1);
    const g = gate();
    let finished: boolean = false;
    const p = pool.submit(async () => { await g.promise; finished = true; }, { priority: Priority.VISIBLE, key: 'k' });
    await tick();
    pool.cancel('k'); // task already running
    g.release();
    await p;
    assert(finished, 'running task must complete despite cancel');
  }

  // Test 5: pins the (priority, seq) key — better priority wins, equal priority keeps submit order.
  {
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
    assert(
      JSON.stringify(order) === JSON.stringify(['visible', 'sibling', 'bulk1', 'bulk2']),
      `priority beats submit order, ties keep it: ${JSON.stringify(order)}`
    );
  }

  // The whole ladder, pinned against a hand-written expectation rather than against the enum itself.
  {
    const pool = new WorkPool(1);
    const first = gate();
    pool.submit(async () => { await first.promise; }, { priority: Priority.VISIBLE });
    await tick();
    const order: string[] = [];
    // Submitted worst-first, so only the ordering can produce the expected sequence.
    pool.submit(async () => { order.push('poll'); }, { priority: Priority.POLL });
    pool.submit(async () => { order.push('bulk'); }, { priority: Priority.THUMBNAIL_BULK });
    pool.submit(async () => { order.push('thumb'); }, { priority: Priority.THUMBNAIL });
    pool.submit(async () => { order.push('prefetch'); }, { priority: Priority.PREFETCH });
    pool.submit(async () => { order.push('export'); }, { priority: Priority.EXPORT });
    pool.submit(async () => { order.push('sibling'); }, { priority: Priority.SIBLING });
    pool.submit(async () => { order.push('visible'); }, { priority: Priority.VISIBLE });
    first.release();
    for (let i = 0; i < 8; i++) await tick();
    assert(
      JSON.stringify(order) === JSON.stringify(['visible', 'sibling', 'export', 'prefetch', 'thumb', 'bulk', 'poll']),
      `full priority ladder: ${JSON.stringify(order)}`
    );
    // Export is user-initiated: ahead of speculation, behind the image on screen.
    assert(Priority.SIBLING < Priority.EXPORT && Priority.EXPORT < Priority.PREFETCH,
      'EXPORT must rank between SIBLING and PREFETCH');
  }

  // Test 7: concurrency is released on the REJECT path too; a missing `finally` would deadlock.
  {
    const pool = new WorkPool(1);
    await pool.submit(async () => { throw new Error('x'); }, { priority: Priority.VISIBLE }).catch(() => undefined);
    let ran = false;
    await pool.submit(async () => { ran = true; }, { priority: Priority.VISIBLE });
    assert(ran, 'pool must keep running tasks after one rejects');
    await tick(); // the slot is released in a finally, i.e. after the awaited resolve
    assert(pool.running === 0 && pool.pending === 0, `pool should be idle, got ${pool.running}/${pool.pending}`);
  }

  // Test 8: a synchronously-throwing fn is caught like a rejection
  {
    const pool = new WorkPool(1);
    let err: unknown;
    await pool.submit((() => { throw new Error('sync'); }) as unknown as () => Promise<void>, {
      priority: Priority.VISIBLE
    }).catch(e => (err = e));
    assert(err instanceof Error && (err as Error).message === 'sync', 'sync throw should reject, not escape');
    const ok = await pool.submit(async () => 1, { priority: Priority.VISIBLE });
    assert(ok === 1, 'pool still usable after a sync throw');
  }

  // Test 9: cancel() drops ALL queued tasks under a key and leaves the rest ordered
  {
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
    assert(pool.pending === before - 2, `cancel should drop exactly 2, ${before}->${pool.pending}`);
    first.release();
    await tick();
    await tick();
    assert(
      JSON.stringify(order) === JSON.stringify(['keep1', 'keep2']),
      `survivors must run in order: ${JSON.stringify(order)}`
    );
  }

  // Test 10: re-entrant submit needs a free slot; nesting on the last slot self-deadlocks by design.
  {
    const pool = new WorkPool(2);
    let inner = false;
    await pool.submit(async () => {
      await pool.submit(async () => { inner = true; }, { priority: Priority.VISIBLE });
    }, { priority: Priority.VISIBLE });
    assert(inner, 're-entrant submit must not deadlock when a slot is free');
    await tick();
    assert(pool.running === 0 && pool.pending === 0, 'pool idle after re-entrant work');
  }

  // Test 11: speculation leaves one slot free; user-facing work takes it immediately.
  {
    const pool = new WorkPool(2);
    const g1 = gate();
    const g2 = gate();
    const p1 = pool.submit(async () => { await g1.promise; }, { priority: Priority.PREFETCH });
    const p2 = pool.submit(async () => { await g2.promise; }, { priority: Priority.PREFETCH });
    await tick();
    // Only one of the two speculative tasks may run: the last slot is reserved.
    assert(pool.running === 1, `speculation must cap at concurrency-1, got ${pool.running} running`);
    assert(pool.pending === 1, `second speculative task should queue, got ${pool.pending} pending`);
    let visibleRan = false;
    const pv = pool.submit(async () => { visibleRan = true; }, { priority: Priority.VISIBLE });
    await tick();
    assert(visibleRan, 'VISIBLE must start in the reserved slot while speculation runs');
    g1.release();
    g2.release();
    await Promise.all([p1, p2, pv]);
    assert(pool.running === 0 && pool.pending === 0, 'queued speculative task must still drain');
  }

  // Test 12: at concurrency 1 the reservation is waived — speculation must not starve forever.
  {
    const pool = new WorkPool(1);
    let ran = false;
    await pool.submit(async () => { ran = true; }, { priority: Priority.POLL });
    assert(ran, 'a speculative task must run at concurrency 1 (no reserved slot to leave)');
  }

  // Test 13: a freed slot goes to queued background, not a further sibling — foreground at budget-1 defers.
  {
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
    assert(pool.running === 2, `nothing queued below: V+S fill the pool, got ${pool.running}`);
    const ps2 = pool.submit(async () => { s2Started = true; await gS2.promise; }, { priority: Priority.SIBLING });
    const pb = pool.submit(async () => { bStarted = true; await gB.promise; }, { priority: Priority.THUMBNAIL_BULK });
    await tick();
    gV.release();
    await tick();
    assert(bStarted && !s2Started, 'the freed slot goes to the queued sweep item, not the third sibling');
    assert(pool.running === 2, `one sibling + one sweep item run: got ${pool.running}`);
    gS1.release();
    await tick();
    assert(s2Started, 'the next freed slot goes back to the sibling');
    gS2.release();
    gB.release();
    await Promise.all([pv, ps1, ps2, pb]);
  }

  // Test 14: prefetch leaves one speculative slot to the queued thumbnail sweep.
  {
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
    assert(pool.running === 3, `speculation stays at concurrency-1: got ${pool.running}`);
    assert(bStarted && pStarted === 2, `prefetch shares the speculative budget with the sweep: ${pStarted} prefetch + bulk=${bStarted}`);
    gB.release();
    gP.forEach((g) => g.release());
    await Promise.all([pb, ...pps]);
  }

  // Test 15: within speculation, a freed slot goes to the queued sweep, not a further prefetch.
  {
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
    assert(pool.running === 3, `speculative budget is 3 of 4: got ${pool.running}`);
    const pb2 = pool.submit(async () => { b2Started = true; await gB2.promise; }, { priority: Priority.THUMBNAIL_BULK });
    const pp3 = pool.submit(async () => { p3Started = true; await gP3.promise; }, { priority: Priority.PREFETCH });
    await tick();
    gB1.release();
    await tick();
    assert(b2Started && !p3Started, 'the freed speculative slot goes to the queued sweep item, not more prefetch');
    gP.forEach((g) => g.release());
    await tick();
    gB2.release();
    gP3.release();
    await Promise.all([pb1, ...pps, pb2, pp3]);
  }

  // Test 16: work-conserving — with nothing queued below, foreground uses the whole pool.
  {
    const pool = new WorkPool(2);
    const gV = gate();
    const gS = gate();
    const pv = pool.submit(async () => { await gV.promise; }, { priority: Priority.VISIBLE });
    const ps = pool.submit(async () => { await gS.promise; }, { priority: Priority.SIBLING });
    await tick();
    assert(pool.running === 2, `no background queued: both foreground tasks run, got ${pool.running}`);
    gV.release();
    gS.release();
    await Promise.all([pv, ps]);
  }

  // Test 17: soak — mixed priorities, keys, throws and cancels; everything settles and the pool drains.
  {
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
      const priority = Math.floor(rng() * 7) as Priority;
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
    assert(settled === N, `every submission settles: ${settled}/${N}`);
    assert(pool.running === 0 && pool.pending === 0, `pool drains: ${pool.running}/${pool.pending}`);
  }

  // Test 6: result and error propagation
  {
    const pool = new WorkPool(2);
    const v = await pool.submit(async () => 42, { priority: Priority.VISIBLE });
    assert(v === 42, `expected 42, got ${v}`);
    let err: unknown;
    await pool.submit(async () => { throw new Error('boom'); }, { priority: Priority.VISIBLE }).catch((e) => (err = e));
    assert(err instanceof Error && (err as Error).message === 'boom', 'error should propagate');
  }

  printResults();
}

// Without this a setup throw would exit 0 and CI would go green on a broken pool.
run().catch(e => {
  console.error(e);
  process.exit(1);
});
