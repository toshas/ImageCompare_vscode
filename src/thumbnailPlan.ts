// Pure sweep planning and running (no vscode): slot selection, order, progress totals and the sweep's wire traffic, shared by the provider and the standalone adapter (docs/standalone.md: adapter-contains-no-logic).
import { ExtensionMessage, asOriginal, asTuple } from './types';

/** A tuple×modality grid position; indices are in original (global) space. */
export interface ThumbnailSlot {
  tupleIndex: number;
  modalityIndex: number;
}

export interface ThumbnailPlan<T> {
  /** Slots with an image, in the order the sweep must process them. */
  items: Array<ThumbnailSlot & { image: T }>;
  /** Slots with no image for their modality — each owes the webview a thumbnailError. */
  missing: ThumbnailSlot[];
  /** Progress denominator: items + missing. With zero items the terminal tick is (total, total). */
  total: number;
}

/** Plan every slot in scanline order — tuple-major, modality-minor; the runner dispatches them centre-out from this list (docs/loading-architecture.md: thumbnails-centre-out). */
export function planThumbnails<T extends { modality: string }>(
  tuples: ReadonlyArray<{ images: readonly T[] }>,
  modalities: readonly string[]
): ThumbnailPlan<T> {
  const items: Array<ThumbnailSlot & { image: T }> = [];
  const missing: ThumbnailSlot[] = [];
  for (let tupleIndex = 0; tupleIndex < tuples.length; tupleIndex++) {
    for (let modalityIndex = 0; modalityIndex < modalities.length; modalityIndex++) {
      const image = tuples[tupleIndex].images.find(img => img.modality === modalities[modalityIndex]);
      if (image) items.push({ tupleIndex, modalityIndex, image });
      else missing.push({ tupleIndex, modalityIndex });
    }
  }
  return { items, missing, total: items.length + missing.length };
}

/** One slot's encoded thumbnail, in the `thumbnail` message's wire shape. */
export interface ThumbnailBytes {
  bytes: Uint8Array;
  mime: string;
}

/** Resolved by `makeThumbnail` for a slot the host dropped before it started; the sweep returns it to the cursor and hands it out again (docs/loading-architecture.md: sweep-cancels-on-reaim). */
export const SWEEP_REQUEUE: unique symbol = Symbol('sweep-requeue');

export interface ThumbnailSweepIo<T> {
  /** Resolve one slot's encoded bytes; null settles the slot with no per-slot post (provider: disposed panel), SWEEP_REQUEUE returns it unsettled. */
  makeThumbnail(item: ThumbnailSlot & { image: T }): Promise<ThumbnailBytes | null | typeof SWEEP_REQUEUE>;
  /** Drop the host's queued-but-unstarted sweep work; called when the centre moves, and every dropped slot must then resolve SWEEP_REQUEUE (docs/loading-architecture.md: sweep-cancels-on-reaim). */
  dropQueued?(): void;
}

/** Dispatches the sweep keeps outstanding at once; refilled per settle (docs/loading-architecture.md: sweep-dispatch-bounded). */
export const SWEEP_CHUNK = 32;

export interface ThumbnailSweepOptions {
  /** Where the user is now, as a tuple index; read at every dispatch, so a jump re-aims the remaining work (docs/loading-architecture.md: thumbnails-centre-out). */
  centre?: () => number;
  /** Dispatch bound; defaults to SWEEP_CHUNK (docs/loading-architecture.md: sweep-dispatch-bounded). */
  chunk?: number;
}

/** The sweep's dispatch order: two walks out from the centre over the plan's rows, forward first on a tie, each item leaving its row exactly once (docs/loading-architecture.md: sweep-covers-every-slot-once). */
export class SweepCursor<T> {
  private readonly rows: Array<Array<ThumbnailSlot & { image: T }>> = [];
  private count: number;
  private centre = -1;
  private up = 0;
  private down = -1;

  constructor(items: ReadonlyArray<ThumbnailSlot & { image: T }>) {
    for (const item of items) {
      while (this.rows.length <= item.tupleIndex) this.rows.push([]);
      this.rows[item.tupleIndex].push(item);
    }
    this.count = items.length;
  }

  /** Planned slots not yet handed out. */
  get remaining(): number {
    return this.count;
  }

  /** The next slot to dispatch, nearest `centre` first; undefined once every slot has been handed out. */
  next(centre: number): (ThumbnailSlot & { image: T }) | undefined {
    if (this.count === 0) return undefined;
    const wanted = Number.isFinite(centre) ? Math.trunc(centre) : 0;
    const aim = Math.min(Math.max(wanted, 0), this.rows.length - 1);
    // A new centre restarts both walks there; rows emptied under the old one are skipped, never re-visited.
    if (aim !== this.centre) {
      this.centre = aim;
      this.up = aim;
      this.down = aim - 1;
    }
    while (this.up < this.rows.length && this.rows[this.up].length === 0) this.up++;
    while (this.down >= 0 && this.rows[this.down].length === 0) this.down--;
    const hasUp = this.up < this.rows.length;
    const hasDown = this.down >= 0;
    let row: number;
    // Nearer walk wins; forward on a tie, the rule the sibling order uses (docs/loading-architecture.md: thumbnails-centre-out).
    if (hasUp && hasDown) row = this.up - this.centre <= this.centre - this.down ? this.up : this.down;
    else if (hasUp) row = this.up;
    else if (hasDown) row = this.down;
    else return undefined;
    this.count--;
    return this.rows[row].shift();
  }

  /** Return a handed-out slot whose work never started, in modality order, so it is handed out again exactly once (docs/loading-architecture.md: sweep-covers-every-slot-once). */
  putBack(item: ThumbnailSlot & { image: T }): void {
    const row = this.rows[item.tupleIndex];
    let at = 0;
    while (at < row.length && row[at].modalityIndex < item.modalityIndex) at++;
    row.splice(at, 0, item);
    this.count++;
    // Rewind whichever walk had already passed this row, or nothing ever revisits it.
    if (item.tupleIndex >= this.centre) {
      if (item.tupleIndex < this.up) this.up = item.tupleIndex;
    } else if (item.tupleIndex > this.down) this.down = item.tupleIndex;
  }
}

/** Run the sweep: missing-slot errors first, then items dispatched centre-out, at most `chunk` outstanding and refilled per settle, each settle posting its result and a progress tick (docs/loading-architecture.md: thumbnails-centre-out, sweep-dispatch-bounded). */
export function runThumbnailSweep<T extends { modality: string }>(
  plan: ThumbnailPlan<T>,
  io: ThumbnailSweepIo<T>,
  post: (message: ExtensionMessage) => void,
  options: ThumbnailSweepOptions = {}
): Promise<void> {
  for (const { tupleIndex, modalityIndex } of plan.missing) {
    post({ type: 'thumbnailError', tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex), error: 'Image not available' });
  }

  // With nothing to invoke no per-item settle fires, so post the terminal tick here or the bar hangs.
  if (plan.items.length === 0) {
    post({ type: 'thumbnailProgress', current: plan.total, total: plan.total });
    return Promise.resolve();
  }

  // No centre supplied is a centre pinned at 0 — scanline order, the old behaviour (docs/loading-architecture.md: thumbnails-centre-out).
  const centre = options.centre ?? (() => 0);
  const chunk = Math.max(1, options.chunk ?? SWEEP_CHUNK);
  const cursor = new SweepCursor(plan.items);
  let done = 0;
  let outstanding = 0;
  let aimed = Number.NaN;
  let resolveSweep!: () => void;
  let rejectSweep!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveSweep = resolve;
    rejectSweep = reject;
  });

  // A requeued slot is not done: it was put back before this ran, and its progress tick comes when it settles for real.
  const settle = (requeued: boolean): void => {
    if (!requeued) {
      done++;
      post({ type: 'thumbnailProgress', current: done + plan.missing.length, total: plan.total });
    }
    outstanding--;
    try {
      pump();
    } catch (error) {
      rejectSweep(error);
      return;
    }
    if (outstanding === 0 && cursor.remaining === 0) resolveSweep();
  };

  const dispatch = (item: ThumbnailSlot & { image: T }): void => {
    outstanding++;
    let requeued = false;
    const slot = io.makeThumbnail(item)
      .then(
        thumb => {
          if (thumb === SWEEP_REQUEUE) {
            // Put back before the settle, so the sweep cannot see itself finished with this slot outstanding.
            requeued = true;
            cursor.putBack(item);
          } else if (thumb !== null) {
            post({ type: 'thumbnail', tupleIndex: asTuple(item.tupleIndex), modalityIndex: asOriginal(item.modalityIndex), bytes: thumb.bytes, mime: thumb.mime });
          }
        },
        error => {
          post({
            type: 'thumbnailError',
            tupleIndex: asTuple(item.tupleIndex),
            modalityIndex: asOriginal(item.modalityIndex),
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      )
      .finally(() => settle(requeued));
    // A post that throws still settles its slot (finally), then fails the sweep as one exit rather than as a floating rejection.
    void slot.catch(rejectSweep);
  };

  // Refilled on every settle, so the pool always has queued work behind its running slots (docs/loading-architecture.md: sweep-dispatch-bounded).
  function pump(): void {
    while (outstanding < chunk) {
      const aim = centre();
      // The outstanding dispatches ARE the lag: drop the ones that never started so the new centre is next (docs/loading-architecture.md: sweep-cancels-on-reaim).
      if (aim !== aimed) {
        aimed = aim;
        if (outstanding > 0) io.dropQueued?.();
      }
      const item = cursor.next(aim);
      if (!item) return;
      dispatch(item);
    }
  }

  pump();
  return finished;
}
