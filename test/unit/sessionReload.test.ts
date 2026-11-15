import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RELOAD_DEBOUNCE_MS, SessionReloadGate } from '../../src/sessionReload';

// SessionReloadGate on Vitest's fake clock (docs/session-files.md: session-edit-reloads).

const T1 = '{"paths": ["/x/a", "/x/b"]}\n';
const T2 = '{"paths": ["/x/a", "/x/b", "/x/c"]}\n';
const T3 = '{"paths": ["/x/a", "/x/c"]}\n';

/** A session file on a fake disk, and a tab that records every reload it is asked for. */
function rig(initial: string) {
  const r = {
    disk: initial,
    readFails: false,
    reads: 0,
    reloads: [] as string[],
    /** When set, a reload stays in progress until `settle()` is called. */
    holdReloads: false,
    settle: () => {},
    /** When set, a read stays in flight until `finishRead(text)` is called. */
    holdReads: false,
    finishRead: (_text: string) => {},
    gate: undefined as unknown as SessionReloadGate
  };
  r.gate = new SessionReloadGate({
    timers: {
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    read: async () => {
      r.reads++;
      if (r.holdReads) return new Promise<string>(resolve => { r.finishRead = resolve; });
      if (r.readFails) throw new Error('ENOENT: no such file');
      return r.disk;
    },
    reload: async text => {
      r.reloads.push(text);
      if (r.holdReloads) await new Promise<void>(resolve => { r.settle = resolve; });
    }
  }, initial);
  return r;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('session reload gate (sessionReload.ts, real code)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a trigger then different bytes reloads exactly once, with the new text, only after the debounce', async () => {
    expect(SESSION_RELOAD_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(SESSION_RELOAD_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
    const r = rig(T1);
    r.disk = T2;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS - 1);
    expect(r.reads).toBe(0);
    expect(r.reloads).toEqual([]);
    await advance(1);
    expect(r.reloads).toEqual([T2]);
    await advance(10 * SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(1);
    expect(r.reloads).toEqual([T2]);
  });

  it('a trigger over unchanged bytes (a touch, a reveal with no edit) never reloads', async () => {
    const r = rig(T1);
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(1);
    expect(r.reloads).toEqual([]);
  });

  it('many triggers inside one debounce cost one read and one reload', async () => {
    const r = rig(T1);
    r.disk = T2;
    for (let i = 0; i < 6; i++) {
      r.gate.trigger();
      await advance(SESSION_RELOAD_DEBOUNCE_MS / 2);
    }
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(1);
    expect(r.reloads).toEqual([T2]);
  });

  it('a read that fails reloads nothing, and the gate keeps listening for the next trigger', async () => {
    const r = rig(T1);
    r.readFails = true;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(1);
    expect(r.reloads).toEqual([]);

    r.readFails = false;
    r.disk = T2;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2]);
  });

  it('a trigger during a reload waits for it to settle, then reloads once with the latest bytes', async () => {
    const r = rig(T1);
    r.holdReloads = true;
    r.disk = T2;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2]);

    // The file changes twice more while the first reload is still opening.
    r.disk = T3;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    r.disk = T2 + ' ';
    r.gate.trigger();
    await advance(10 * SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2]);

    r.holdReloads = false;
    r.settle();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2, T2 + ' ']);
    await advance(10 * SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2, T2 + ' ']);
  });

  it('a reload moves the baseline: a later trigger that reads the reloaded text does nothing', async () => {
    const r = rig(T1);
    r.disk = T2;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2]);

    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(2);
    expect(r.reloads).toEqual([T2]);

    // And back to the original bytes is a change again, not a no-op.
    r.disk = T1;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([T2, T1]);
  });

  it('dispose with a debounce pending clears it: no read, no reload, and later triggers do nothing', async () => {
    const r = rig(T1);
    r.disk = T2;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS / 2);
    r.gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(0);
    expect(r.reloads).toEqual([]);

    r.gate.trigger();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reads).toBe(0);
    expect(r.reloads).toEqual([]);
  });

  it('dispose while a read is in flight drops what it returns', async () => {
    const r = rig(T1);
    r.holdReads = true;
    r.gate.trigger();
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    r.gate.dispose();
    r.finishRead(T2);
    await advance(SESSION_RELOAD_DEBOUNCE_MS);
    expect(r.reloads).toEqual([]);
  });
});
