/**
 * Backpressure for the extension→webview channel: the work pool orders *work*, this orders *bytes
 * on the wire*. Pure (no vscode, no node) — the provider owns one per panel and feeds it the
 * config and `vscode.env.remoteName`. Rationale, numbers and the failure it fixes:
 * docs/loading-architecture.md ("Transport backpressure").
 */

/** Default speculative in-flight bound on a remote session, in MB. */
export const DEFAULT_TRANSPORT_BUDGET_MB = 8;

/** Parked speculative pushes, capped by slot count like the scrub-burst park (docs/loading-architecture.md: speculation-yields-the-wire). */
export const MAX_DEFERRED_PUSHES = 64;

/** A push waiting for the wire: its slot key, its byte cost, and the payload to post when it may go. */
export interface DeferredPush<T> {
  key: string;
  bytes: number;
  item: T;
}

/** Re-key slot-keyed image posts (`${tupleIndex}-${modalityIndex}`) after a row splice; `shift` returns the row's new index or null when the row is gone (docs/file-watching.md: reindex-in-lockstep). */
export function reindexSlotKeyedPosts<T extends { tupleIndex: number }>(
  posts: Iterable<[string, T]>,
  shift: (tupleIndex: number) => number | null
): Array<[string, T]> {
  const out: Array<[string, T]> = [];
  for (const [key, post] of posts) {
    const next = shift(post.tupleIndex);
    if (next === null) continue;
    const column = key.slice(key.indexOf('-') + 1);
    out.push([`${next}-${column}`, next === post.tupleIndex ? post : { ...post, tupleIndex: next } as T]);
  }
  return out;
}

/**
 * Effective budget in bytes. `Infinity` means the policy is inert: local sessions (no serialized
 * channel to fight over) and an explicit `0` (docs/loading-architecture.md: wire-budget-remote-only).
 */
export function resolveTransportBudgetBytes(configuredMB: number | undefined, remoteName: string | undefined): number {
  if (remoteName === undefined) return Infinity;
  const mb = typeof configuredMB === 'number' && Number.isFinite(configuredMB) ? configuredMB : DEFAULT_TRANSPORT_BUDGET_MB;
  if (mb <= 0) return Infinity;
  return Math.round(mb * 1024 * 1024);
}

/** Per-panel wire accounting: what may go now, what waits, and what has not been acknowledged yet. */
export class TransportBudget<T> {
  private inFlight = 0;
  private sweeping = false;
  private readonly parked = new Map<string, DeferredPush<T>>();

  constructor(private limitBytes: number, private readonly maxDeferred: number = MAX_DEFERRED_PUSHES) {}

  /** False when the budget is unlimited — the provider then skips the ack plumbing entirely. */
  get active(): boolean {
    return this.limitBytes !== Infinity;
  }

  get limit(): number {
    return this.limitBytes;
  }

  get inFlightBytes(): number {
    return this.inFlight;
  }

  get deferredCount(): number {
    return this.parked.size;
  }

  get sweepActive(): boolean {
    return this.sweeping;
  }

  setLimit(bytes: number): void {
    this.limitBytes = bytes;
  }

  /** A bulk thumbnail sweep is draining: speculation stays off the wire until it ends. */
  setSweepActive(active: boolean): void {
    this.sweeping = active;
  }

  /** The whole policy: user-facing pushes always go now (docs/loading-architecture.md: user-pushes-never-withheld); speculative ones yield to a sweep, then to the byte bound (docs/loading-architecture.md: speculation-yields-the-wire). */
  canSend(bytes: number, speculative: boolean): boolean {
    if (!speculative || this.limitBytes === Infinity) return true;
    if (this.sweeping) return false;
    // One speculative push always fits, or an image larger than the budget could never be sent at all.
    if (this.inFlight === 0) return true;
    return this.inFlight + bytes <= this.limitBytes;
  }

  /** Every `image` on the wire is counted, user-facing included — they displace speculation, never the reverse. */
  noteSent(bytes: number): void {
    this.inFlight += bytes;
  }

  noteDelivered(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
  }

  /** Park a speculative push, newest last; over the cap the oldest is dropped (its bytes stay in `loadedImages`, so a drop costs one re-request). */
  defer(key: string, item: T, bytes: number): void {
    this.parked.delete(key);
    this.parked.set(key, { key, bytes, item });
    while (this.parked.size > this.maxDeferred) {
      const oldest = this.parked.keys().next().value;
      if (oldest === undefined) break;
      this.parked.delete(oldest);
    }
  }

  /** Forget a parked push — the slot has just been served by a user-facing post. */
  drop(key: string): void {
    this.parked.delete(key);
  }

  /** Forget every parked push, in-flight accounting untouched: a splice invalidated their slot keys (docs/file-watching.md: reindex-in-lockstep). */
  clearParked(): void {
    this.parked.clear();
  }

  /** Re-key the park in oldest-first order after a splice moved rows; `undefined` forgets the entry (docs/file-watching.md: reindex-in-lockstep). */
  remap(next: (entry: DeferredPush<T>) => DeferredPush<T> | undefined): void {
    const entries = [...this.parked.values()];
    this.parked.clear();
    for (const entry of entries) {
      const mapped = next(entry);
      if (mapped) this.parked.set(mapped.key, mapped);
    }
  }

  /** The oldest parked push if the budget allows it out now, else undefined. */
  takeNext(): DeferredPush<T> | undefined {
    const first = this.parked.values().next();
    if (first.done) return undefined;
    if (!this.canSend(first.value.bytes, true)) return undefined;
    this.parked.delete(first.value.key);
    return first.value;
  }

  /** Panel dispose: nothing parked survives it, and no ack can resurrect the counter. */
  reset(): void {
    this.parked.clear();
    this.inFlight = 0;
    this.sweeping = false;
  }
}
