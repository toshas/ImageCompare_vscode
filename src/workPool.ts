/**
 * Bounded, prioritized, cancellable async work pool; ordered by priority (lower
 * first), FIFO within a priority. See docs/loading-architecture.md.
 */

import * as os from 'os';

// This order is what keeps the visible image ahead of thumbnails/prefetch/polling (docs/loading-architecture.md: visible-never-starved).
export enum Priority {
  VISIBLE = 0, // the image currently on screen
  SIBLING = 1, // other modalities of the current tuple
  EXPORT = 2, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation
  PREFETCH = 3, // neighbor tuples
  THUMBNAIL = 4, // on-demand re-requests after the carousel changes (tuple/modality added or removed, watcher regeneration)
  THUMBNAIL_BULK = 5, // the whole-session sweep at open; must not starve the above
  POLL = 6 // background filesystem existence checks
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

const PRIORITY_COUNT = 7;

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

  // The admission rules; see docs/loading-architecture.md ("The work pool") for why each exists.
  private canStart(p: number): boolean {
    if (this.active >= this.concurrency) return false;
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
      // Max-min fair share: the emptiest running class goes first, so no queued class starves behind a wave (docs/loading-architecture.md: background-trickle).
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

let shared: WorkPool | undefined;
let panelKeySeq = 0;

/**
 * The single pool every panel's image work goes through. No aging: safe only while
 * every producer stays finite — see docs/loading-architecture.md.
 */
export function sharedWorkPool(): WorkPool {
  if (!shared) {
    const cpus = os.cpus()?.length || 4;
    // Latency-bound, not CPU-bound: reads are file-service RPC and Sharp decodes on its own pool, so width hides mount latency (docs/loading-architecture.md: pool-width-hides-latency).
    shared = new WorkPool(Math.max(1, Math.min(16, cpus - 1)));
  }
  return shared;
}

/** Cancellation-key prefix; the counter is process-global so keys are never reused (docs/loading-architecture.md: panel-keys-never-reused). */
export function nextPanelKey(): string {
  return `panel-${++panelKeySeq}`;
}
