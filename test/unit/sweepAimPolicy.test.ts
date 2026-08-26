import { describe, expect, it } from 'vitest';
import { AIM_DWELL_MS, AimTimers, SweepAimPolicy } from '../../src/sweepAimPolicy';
import { sameAim } from '../../src/thumbnailPlan';
import { LOAD_DEBOUNCE_MS } from '../../src/webview/tupleLoadPlan';

// The policy both products' sweeps aim by, on a fake clock and with no host in sight. Everything a
// host is allowed to contribute is here as data (a raw setCurrentTuple, a raw tupleFullyLoaded, the
// tuple the sweep opens on) or as a primitive (the two timer functions below). Nothing about WHEN
// the aim moves is reachable from a host, which is the whole point: the trailing-edge dwell shipped
// in one host's wiring once and the other silently kept chasing the cursor.
// (docs/loading-architecture.md: sweep-centre-dwells, thumbnails-centre-out)

/** A clock the test owns: timers fire only when it is advanced, and every armed one is visible. */
function fakeClock(): AimTimers & { advance(ms: number): void; armed(): number; delays: number[] } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    delays: [],
    setTimer(run: () => void, ms: number): unknown {
      const id = next++;
      this.delays.push(ms);
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.run();
        }
      }
    },
    armed: () => timers.size
  };
}

const STRIP = { modalityOrder: [0, 1, 2], currentDisplayIndex: 0, hiddenModalities: [] as number[] };

describe('sweep aim policy: where the sweep aims, and when that moves', () => {
  it('holds the dwell open for a whole burst and re-aims once, at the row the burst ended on', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteSweepStart(0);

    // A held key: ten repeats, each well inside the dwell.
    for (const row of [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) {
      policy.noteTuple(row);
      clock.advance(20);
      // Not one of them has moved the aim: the sweep is still filling around where it opened.
      expect(policy.aim().tuple).toBe(0);
    }
    expect(clock.armed()).toBe(1);

    // The key comes up.
    clock.advance(AIM_DWELL_MS);
    expect(policy.aim().tuple).toBe(49);
    expect(clock.armed()).toBe(0);
  });

  it('waits the navigation debounce, not a dwell of its own invention', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteTuple(7);
    // Pinned from outside the policy: the dwell IS the webview's navigation debounce, and that is
    // 150 ms (docs/loading-architecture.md: sweep-centre-dwells, siblings-dwell-gated).
    expect(clock.delays).toEqual([150]);
    expect(AIM_DWELL_MS).toBe(LOAD_DEBOUNCE_MS);

    clock.advance(AIM_DWELL_MS - 1);
    expect(policy.aim().tuple).toBe(0);
    clock.advance(1);
    expect(policy.aim().tuple).toBe(7);
  });

  it('takes the column out of display space, and the radius the webview measured', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    // The strip as the user rearranged it: display position 0 holds ORIGINAL modality 2.
    policy.noteStrip({ modalityOrder: [2, 0, 1], currentDisplayIndex: 0, hiddenModalities: [1], visibleRows: 9 });
    expect(policy.aim()).toEqual({ tuple: 0, modality: 2, modalityOrder: [2, 0, 1], hidden: [1], radius: 9 });
  });

  it('applies the strip at once — only the tuple dwells', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteStrip({ ...STRIP, currentDisplayIndex: 2 });
    // No time has passed and no dwell was armed: a column change is not navigation.
    expect(clock.armed()).toBe(0);
    expect(policy.aim().modality).toBe(2);
  });

  it('ignores a report whose display position names no column, keeping the aim it had', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteStrip({ ...STRIP, currentDisplayIndex: 1 });
    policy.noteStrip({ ...STRIP, currentDisplayIndex: 7 });
    expect(policy.aim().modality).toBe(1);
    policy.noteStrip({ modalityOrder: [], currentDisplayIndex: 0, hiddenModalities: [] });
    expect(policy.aim().modality).toBe(1);
  });

  it('opens the sweep at the tuple its host reports, with no dwell to wait for', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteSweepStart(20);
    expect(policy.aim().tuple).toBe(20);
    // A dwell armed after that still settles on the row the user navigated to, not on the prime.
    policy.noteTuple(31);
    expect(policy.aim().tuple).toBe(20);
    clock.advance(AIM_DWELL_MS);
    expect(policy.aim().tuple).toBe(31);
  });

  it('re-reads as the same aim, so a host that reads it every pass is not re-aiming', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteSweepStart(4);
    policy.noteStrip({ ...STRIP, currentDisplayIndex: 1, visibleRows: 5 });
    const first = policy.aim();
    const second = policy.aim();
    expect(first).not.toBe(second);
    // The runner's own comparison, not a hand-rolled one (docs/loading-architecture.md: sweep-aims-once-per-pass).
    expect(sameAim(first, second)).toBe(true);
  });

  it('drops a pending dwell when its host goes away', () => {
    const clock = fakeClock();
    const policy = new SweepAimPolicy(clock);
    policy.noteTuple(12);
    expect(clock.armed()).toBe(1);
    policy.dispose();
    expect(clock.armed()).toBe(0);
    clock.advance(AIM_DWELL_MS * 10);
    expect(policy.aim().tuple).toBe(0);
  });
});
