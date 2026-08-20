/**
 * Bounded, prioritized, cancellable async work pool; ordered by priority (lower
 * first), FIFO within a priority. No aging: safe only while every producer
 * stays finite. Browser-safe on purpose — the standalone adapter bundles this
 * module, so no node imports. See docs/loading-architecture.md.
 */

// This order is what keeps the visible image ahead of thumbnails/prefetch/polling (docs/loading-architecture.md: visible-never-starved).
export enum Priority {
  VISIBLE = 0, // the image currently on screen
  SIBLING = 1, // other modalities of the current tuple
  EXPORT = 2, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation
  PREFETCH = 3, // neighbor tuples
  THUMBNAIL = 4, // on-demand re-requests after the carousel changes (tuple/modality added or removed, watcher regeneration)
  THUMBNAIL_BULK = 5, // the whole-session sweep at open; must not starve the above
  POLL = 6, // background filesystem existence checks
  SIBLING_TAIL = 7 // modalities beyond the nearest two of the current tuple: strictly last (docs/loading-architecture.md: sibling-tail-never-competes)
}

/** Thrown to a queued task's awaiter when it is cancelled before it starts. */
export class TaskCancelled extends Error {
  constructor() {
    super('work cancelled');
    this.name = 'TaskCancelled';
  }
}

interface QueueItem<T> {
  fn: () => Promise<T>;
  priority: number;
  key?: string;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export interface SubmitOptions {
  priority: Priority;
  /** Groups tasks so they can be cancelled/bumped together (e.g. a prefetch wave). */
  key?: string;
}

const PRIORITY_COUNT = 8;

export class WorkPool {
  private readonly concurrency: number;
  private active = 0;
  private activeByPrio: number[] = new Array(PRIORITY_COUNT).fill(0);
  // One FIFO per priority: class order is the loop in pump(), submit order is array order.
  private queues: QueueItem<unknown>[][] = Array.from({ length: PRIORITY_COUNT }, () => []);

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * Schedule `fn`. Resolves/rejects with its result. If the task is cancelled
   * while still queued (via cancel(key)), the promise rejects with TaskCancelled
   * and `fn` is never invoked. Tasks already running are not interrupted.
   */
  submit<T>(fn: () => Promise<T>, opts: SubmitOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        fn,
        priority: opts.priority,
        key: opts.key,
        resolve,
        reject
      };
      this.queues[opts.priority].push(item as QueueItem<unknown>);
      this.pump();
    });
  }

  /** Drop all queued (not-yet-started) tasks with this key; they reject with TaskCancelled. */
  cancel(key: string): void {
    for (let p = 0; p < PRIORITY_COUNT; p++) {
      const remaining: QueueItem<unknown>[] = [];
      for (const item of this.queues[p]) {
        if (item.key === key) {
          item.reject(new TaskCancelled());
        } else {
          remaining.push(item);
        }
      }
      this.queues[p] = remaining;
    }
  }

  /** Number of queued (not yet started) tasks — for tests/diagnostics. */
  get pending(): number {
    return this.queues.reduce((sum, q) => sum + q.length, 0);
  }

  /** Number of currently running tasks — for tests/diagnostics. */
  get running(): number {
    return this.active;
  }

  private anyQueuedBelow(p: number): boolean {
    for (let q = p + 1; q < PRIORITY_COUNT; q++) {
      if (this.queues[q].length > 0) return true;
    }
    return false;
  }

  private anyQueuedElsewhere(p: number): boolean {
    for (let q = 0; q < PRIORITY_COUNT; q++) {
      if (q !== p && this.queues[q].length > 0) return true;
    }
    return false;
  }

  // The admission rules; see docs/loading-architecture.md ("The work pool") for why each exists.
  private canStart(p: number): boolean {
    if (this.active >= this.concurrency) return false;
    // Exempt from the concurrency-1 waiver below: being deferred behind every other class is the point (docs/loading-architecture.md: sibling-tail-never-competes).
    if (p === Priority.SIBLING_TAIL && this.anyQueuedElsewhere(p)) return false;
    if (this.concurrency === 1) return true; // every reservation is waived at one slot: it would starve a whole class outright
    if (p >= Priority.PREFETCH) {
      // Speculation collectively leaves one slot free for user-facing arrivals (docs/loading-architecture.md: visible-never-starved).
      let spec = 0;
      for (let q = Priority.PREFETCH; q < PRIORITY_COUNT; q++) spec += this.activeByPrio[q];
      return spec < this.concurrency - 1;
    }
    if (p === Priority.VISIBLE) return true; // the on-screen image owes nobody a courtesy slot
    // SIBLING/EXPORT leave one slot of the pool to lower classes while they have work (docs/loading-architecture.md: background-trickle).
    let atOrAbove = 0;
    for (let q = Priority.VISIBLE; q <= p; q++) atOrAbove += this.activeByPrio[q];
    return atOrAbove < this.concurrency - (this.anyQueuedBelow(p) ? 1 : 0);
  }

  private pickSpeculative(): number {
    let best = -1;
    for (let q = Priority.PREFETCH; q < PRIORITY_COUNT; q++) {
      if (this.queues[q].length === 0 || !this.canStart(q)) continue;
      // Max-min fair share: the emptiest running class goes first; ties fall to priority, so at spec width 1 this is strict priority (docs/loading-architecture.md: background-trickle).
      if (best === -1 || this.activeByPrio[q] < this.activeByPrio[best]) best = q;
    }
    return best;
  }

  private start(p: number): void {
    const item = this.queues[p].shift()!;
    this.active++;
    this.activeByPrio[p]++;
    // Run outside the current tick so submit() has returned before fn side effects.
    Promise.resolve()
      .then(() => item.fn())
      .then(
        (v) => item.resolve(v),
        (e) => item.reject(e)
      )
      .finally(() => {
        this.active--;
        this.activeByPrio[p]--;
        this.pump();
      });
  }

  private pump(): void {
    // canStart is the single authority on admission (its active-vs-cap check included); the loop just rescans until nothing admits.
    outer: while (true) {
      for (let p = Priority.VISIBLE; p < Priority.PREFETCH; p++) {
        if (this.queues[p].length === 0 || !this.canStart(p)) continue;
        this.start(p);
        continue outer;
      }
      const q = this.pickSpeculative();
      if (q === -1) break;
      this.start(q);
    }
  }

  /** One-line load snapshot for the debug channel — running per class + queued per class. */
  stats(): string {
    return `active=${this.active}/${this.concurrency} run=[${this.activeByPrio.join(',')}] queued=[${this.queues.map(q => q.length).join(',')}]`;
  }
}

let panelKeySeq = 0;

// The decode ceiling: Sharp holds one libuv thread per operation and libuv's pool is 4, unsettable from inside the host (docs/loading-architecture.md: pool-width-hides-latency).
const LIBUV_WIDTH = 4;
// Just enough extra in flight to refill a freed libuv thread across a JS round-trip; more only queues ahead of the user's image (docs/loading-architecture.md: pool-width-hides-latency).
const DISPATCH_SLACK = 2;

/**
 * Pool width — `clamp(parallelism - 1, 1, 4)` saturating slots plus 2 of dispatch slack (so 1..6),
 * or an explicit positive `override`. The one width rule both products use; feed it
 * `usableParallelism`, never a raw logical-core count.
 */
export function poolWidth(parallelism: number, override?: number): number {
  if (override !== undefined && override > 0) return Math.max(1, Math.floor(override));
  const saturating = Math.max(1, Math.min(LIBUV_WIDTH, parallelism - 1));
  return saturating === 1 ? 1 : saturating + DISPATCH_SLACK;
}

/** Parallelism actually usable: the runtime's own report (os.availableParallelism / hardwareConcurrency) if any, else a logical-core count, else 4 (docs/loading-architecture.md: pool-width-hides-latency). */
export function usableParallelism(available: number | undefined, logical: number | undefined): number {
  if (available !== undefined && available > 0) return available;
  return logical !== undefined && logical > 0 ? logical : LIBUV_WIDTH;
}

/** Cancellation-key prefix; the counter is process-global so keys are never reused (docs/loading-architecture.md: panel-keys-never-reused). */
export function nextPanelKey(): string {
  return `panel-${++panelKeySeq}`;
}
