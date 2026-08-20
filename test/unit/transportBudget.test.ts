import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRANSPORT_BUDGET_MB,
  MAX_DEFERRED_PUSHES,
  TransportBudget,
  resolveTransportBudgetBytes
} from '../../src/transportBudget';

// The decision half of the transport policy, pinned against values from outside the implementation
// (the setting's documented semantics, and the trace's 16MB whale against an 8MB budget).
// (docs/loading-architecture.md: user-pushes-never-withheld, speculation-yields-the-wire, wire-budget-remote-only)

const MB = 1024 * 1024;

describe('resolveTransportBudgetBytes', () => {
  it('is unlimited on a local session, whatever the setting says', () => {
    expect(resolveTransportBudgetBytes(8, undefined)).toBe(Infinity);
    expect(resolveTransportBudgetBytes(1, undefined)).toBe(Infinity);
  });

  it('applies the configured megabytes on any remote', () => {
    expect(resolveTransportBudgetBytes(8, 'ssh-remote')).toBe(8 * MB);
    expect(resolveTransportBudgetBytes(2, 'wsl')).toBe(2 * MB);
    expect(resolveTransportBudgetBytes(64, 'dev-container')).toBe(64 * MB);
  });

  it('falls back to the documented default when the setting is absent or unusable', () => {
    expect(resolveTransportBudgetBytes(undefined, 'ssh-remote')).toBe(DEFAULT_TRANSPORT_BUDGET_MB * MB);
    expect(resolveTransportBudgetBytes(Number.NaN, 'ssh-remote')).toBe(DEFAULT_TRANSPORT_BUDGET_MB * MB);
    expect(DEFAULT_TRANSPORT_BUDGET_MB).toBe(8);
  });

  it('treats 0 (and anything below it) as "no bound"', () => {
    expect(resolveTransportBudgetBytes(0, 'ssh-remote')).toBe(Infinity);
    expect(resolveTransportBudgetBytes(-5, 'ssh-remote')).toBe(Infinity);
  });
});

describe('TransportBudget.canSend', () => {
  it('never withholds a user-facing push — not while sweeping, not over budget', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.setSweepActive(true);
    b.noteSent(200 * MB);
    expect(b.canSend(16 * MB, false)).toBe(true);
  });

  it('withholds every speculative push while a bulk sweep drains', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.setSweepActive(true);
    expect(b.canSend(1, true)).toBe(false);
    b.setSweepActive(false);
    expect(b.canSend(1, true)).toBe(true);
  });

  it('bounds speculation in bytes, not in messages', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.noteSent(6 * MB);
    expect(b.canSend(2 * MB, true)).toBe(true);
    expect(b.canSend(2 * MB + 1, true)).toBe(false);
  });

  it('lets one over-budget image go alone, so a 16MB image is never stranded', () => {
    const b = new TransportBudget<string>(8 * MB);
    expect(b.canSend(16 * MB, true)).toBe(true);
    b.noteSent(16 * MB);
    expect(b.canSend(1, true)).toBe(false);
    b.noteDelivered(16 * MB);
    expect(b.canSend(16 * MB, true)).toBe(true);
  });

  it('is inert when unlimited: a local session never defers or accounts a thing', () => {
    const b = new TransportBudget<string>(Infinity);
    b.setSweepActive(true);
    b.noteSent(500 * MB);
    expect(b.active).toBe(false);
    expect(b.canSend(16 * MB, true)).toBe(true);
  });

  it('an ack that arrives twice cannot drive the in-flight count negative', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.noteSent(1 * MB);
    b.noteDelivered(1 * MB);
    b.noteDelivered(1 * MB);
    expect(b.inFlightBytes).toBe(0);
  });
});

describe('TransportBudget parking', () => {
  it('releases parked pushes oldest-first, and only while the budget allows', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.defer('a', 'A', 5 * MB);
    b.defer('b', 'B', 5 * MB);
    expect(b.deferredCount).toBe(2);
    const first = b.takeNext();
    expect(first?.item).toBe('A');
    b.noteSent(first!.bytes);
    expect(b.takeNext()).toBeUndefined();
    b.noteDelivered(5 * MB);
    expect(b.takeNext()?.item).toBe('B');
  });

  it('parks nothing twice for one slot — the newest payload wins its place', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.defer('7-2', 'stale', 1);
    b.defer('7-2', 'fresh', 1);
    expect(b.deferredCount).toBe(1);
    expect(b.takeNext()?.item).toBe('fresh');
  });

  it('drops the oldest over the parking cap rather than growing without bound', () => {
    const b = new TransportBudget<string>(8 * MB);
    for (let i = 0; i < MAX_DEFERRED_PUSHES + 3; i++) b.defer(`k${i}`, `v${i}`, 1);
    expect(b.deferredCount).toBe(MAX_DEFERRED_PUSHES);
    expect(b.takeNext()?.item).toBe('v3');
  });

  it('drop() forgets a slot a user-facing push has just served', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.defer('7-2', 'v', 1);
    b.drop('7-2');
    expect(b.takeNext()).toBeUndefined();
  });

  it('reset() clears parked pushes, in-flight bytes and the sweep flag (panel dispose)', () => {
    const b = new TransportBudget<string>(8 * MB);
    b.defer('a', 'A', 1);
    b.noteSent(4 * MB);
    b.setSweepActive(true);
    b.reset();
    expect(b.deferredCount).toBe(0);
    expect(b.inFlightBytes).toBe(0);
    expect(b.sweepActive).toBe(false);
  });
});
