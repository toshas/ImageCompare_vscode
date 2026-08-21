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
  /** Drop the host's queued-but-unstarted sweep work; called when the centre moves and when the host pauses, and every dropped slot must then resolve SWEEP_REQUEUE (docs/loading-architecture.md: sweep-cancels-on-reaim, hidden-sweep-pauses-not-cancels). */
  dropQueued?(): void;
}

/** Dispatches the sweep keeps outstanding at once; refilled per settle (docs/loading-architecture.md: sweep-dispatch-bounded). */
export const SWEEP_CHUNK = 32;

export interface ThumbnailSweepOptions {
  /** Where the user is now, as a grid position; read once per pump pass, so a move re-aims the remaining work (docs/loading-architecture.md: thumbnails-centre-out, sweep-aims-once-per-pass). */
  centre?: () => SweepAim;
  /** True once the host has abandoned this sweep — panel disposed, session re-opened; the pump then stops at the batch boundary and the cursor keeps the rest (docs/loading-architecture.md: sweep-stops-when-host-abandons). */
  abandoned?: () => boolean;
  /** Dispatch bound; defaults to SWEEP_CHUNK (docs/loading-architecture.md: sweep-dispatch-bounded). */
  chunk?: number;
  /** True while the host is not on screen: the pump returns its queued dispatches and hands out nothing until the host repumps (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels). */
  paused?: () => boolean;
  /** Called once with the callback that re-enters the pump; the host must invoke it whenever its own `paused`/`abandoned` answer changes, or a pause takes effect only at the next settle and a sweep paused with nothing outstanding never ends at all (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels). */
  onRepump?: (repump: () => void) => void;
}

/** Where the user is, as a tile: the sweep aims at a grid position, not at a row (docs/loading-architecture.md: thumbnails-centre-out). */
export interface SweepAim {
  /** Tuple row, in original (global) space. */
  tuple: number;
  /** Original modality index of the column on screen; absent or unknown aims at the strip's first column. */
  modality?: number;
  /** Display position -> original modality index, as the strip is shown; absent means the plan's own column order (docs/tuple-matching.md: wire-index-is-original). */
  modalityOrder?: readonly number[];
  /** Original indices of the columns the user has hidden: swept after every visible one, never dropped (docs/session-files.md: hidden-is-presentation-only). */
  hidden?: readonly number[];
  /** Carousel rows one screenful high — how far the cross's column arm reaches; absent falls back to SWEEP_CROSS_RADIUS (docs/loading-architecture.md: sweep-cross-then-row-major). */
  radius?: number;
}

/** Fallback screenful for a host that reports no visible row count (docs/loading-architecture.md: sweep-cross-then-row-major). */
export const SWEEP_CROSS_RADIUS = 12;

const sameList = (a?: readonly number[], b?: readonly number[]): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));

/** Aims compare by value: a host that rebuilds its aim object on every read must not count as a re-aim (docs/loading-architecture.md: sweep-aims-once-per-pass). */
export function sameAim(a: SweepAim, b: SweepAim | undefined): boolean {
  return b !== undefined && a.tuple === b.tuple && a.modality === b.modality && a.radius === b.radius &&
    sameList(a.modalityOrder, b.modalityOrder) && sameList(a.hidden, b.hidden);
}

/** A host's raw aim made comparable: a NaN or fractional coordinate would otherwise differ from itself and re-aim every pass (docs/loading-architecture.md: sweep-aims-once-per-pass). */
function readAim(centre: () => SweepAim): SweepAim {
  const raw = centre();
  const tuple = Number.isFinite(raw.tuple) ? Math.trunc(raw.tuple) : 0;
  const modality = raw.modality !== undefined && Number.isFinite(raw.modality) ? Math.trunc(raw.modality) : undefined;
  // A non-finite radius means "no report" here as it does in the walk, so the two agree and the aim stays equal to itself.
  const radius = raw.radius !== undefined && Number.isFinite(raw.radius) ? Math.trunc(raw.radius) : undefined;
  return tuple === raw.tuple && modality === raw.modality && radius === raw.radius ? raw : { ...raw, tuple, modality, radius };
}

/** One grid position; the cell may be empty by the time the walk reaches it. */
interface SweepPosition {
  tuple: number;
  modality: number;
}

/** The sweep's dispatch order: the focused tile, then its cross interleaved out to one screenful, then the rest row-major centre-out, each cell leaving the grid exactly once (docs/loading-architecture.md: sweep-cross-then-row-major, sweep-covers-every-slot-once). */
export class SweepCursor<T> {
  private readonly grid: Array<Array<(ThumbnailSlot & { image: T }) | undefined>> = [];
  private columns = 0;
  private count: number;
  private aim?: SweepAim;
  private walk?: Iterator<SweepPosition>;

  constructor(items: ReadonlyArray<ThumbnailSlot & { image: T }>) {
    for (const item of items) {
      while (this.grid.length <= item.tupleIndex) this.grid.push([]);
      const row = this.grid[item.tupleIndex];
      while (row.length <= item.modalityIndex) row.push(undefined);
      row[item.modalityIndex] = item;
      if (item.modalityIndex >= this.columns) this.columns = item.modalityIndex + 1;
    }
    this.count = items.length;
  }

  /** Planned slots not yet handed out. */
  get remaining(): number {
    return this.count;
  }

  /** The next slot to dispatch, nearest `aim` first; undefined once every slot has been handed out. */
  next(aim: SweepAim): (ThumbnailSlot & { image: T }) | undefined {
    if (this.count === 0) return undefined;
    // A new aim restarts the enumeration; cells emptied under the old one are skipped, never re-visited.
    if (this.walk === undefined || !sameAim(aim, this.aim)) {
      this.aim = aim;
      this.walk = this.positions(aim);
    }
    let walk = this.walk;
    let restarted = false;
    for (;;) {
      const step = walk.next();
      if (step.done) {
        // A slot returned behind the walk is reached by the next enumeration, wherever the aim now puts it.
        if (restarted) return undefined;
        restarted = true;
        walk = this.positions(this.aim!);
        this.walk = walk;
        continue;
      }
      const item = this.grid[step.value.tuple]?.[step.value.modality];
      if (item === undefined) continue;
      // Consumed, not peeked: an emptied cell can never be dispatched twice (docs/loading-architecture.md: sweep-covers-every-slot-once).
      this.grid[step.value.tuple][step.value.modality] = undefined;
      this.count--;
      return item;
    }
  }

  /** Return a handed-out slot whose work never started, so it is handed out again exactly once (docs/loading-architecture.md: sweep-covers-every-slot-once). */
  putBack(item: ThumbnailSlot & { image: T }): void {
    this.grid[item.tupleIndex][item.modalityIndex] = item;
    this.count++;
    // The walk may be past this cell on either axis, so it is discarded: re-enumerating rewinds both at once.
    this.walk = undefined;
  }

  /** Columns in sweep order: the focused one first, then by display distance, hidden columns after every visible one (docs/loading-architecture.md: sweep-cross-then-row-major, docs/session-files.md: hidden-is-presentation-only). */
  private rankColumns(aim: SweepAim): number[] {
    const order = aim.modalityOrder !== undefined && aim.modalityOrder.length > 0 ? [...aim.modalityOrder] : [];
    for (let m = 0; m < this.columns; m++) if (!order.includes(m)) order.push(m);
    const hidden = new Set(aim.hidden ?? []);
    const at = aim.modality === undefined ? -1 : order.indexOf(aim.modality);
    const here = at >= 0 ? at : 0;
    // Hidden columns are not steps, and the focused one counts as reachable even when hidden — a click or digit jump lands on it (docs/loading-architecture.md: sibling-order-by-display-distance).
    const steps = new Map<number, number>();
    for (let d = 0; d < order.length; d++) if (d === here || !hidden.has(order[d])) steps.set(d, steps.size);
    const hereStep = steps.get(here) ?? 0;
    const distance = (d: number): number => {
      const step = steps.get(d);
      return step === undefined ? Math.abs(d - here) : Math.abs(step - hereStep);
    };
    return order
      .map((modality, d) => ({ modality, d }))
      // Visible before hidden, then nearest, then forward on a tie — the rule the sibling order uses (docs/loading-architecture.md: sibling-order-by-display-distance).
      .sort((a, b) => (steps.has(a.d) ? 0 : 1) - (steps.has(b.d) ? 0 : 1) || distance(a.d) - distance(b.d) || b.d - a.d)
      .map(c => c.modality);
  }

  /** Every grid position from the aim, in dispatch order (docs/loading-architecture.md: sweep-cross-then-row-major). */
  private *positions(aim: SweepAim): Generator<SweepPosition> {
    const rows = this.grid.length;
    if (rows === 0) return;
    const columns = this.rankColumns(aim);
    const wanted = Number.isFinite(aim.tuple) ? Math.trunc(aim.tuple) : 0;
    const t0 = Math.min(Math.max(wanted, 0), rows - 1);
    const reach = Math.max(1, Number.isFinite(aim.radius) ? Math.trunc(aim.radius as number) : SWEEP_CROSS_RADIUS);
    const focus = columns[0];
    yield { tuple: t0, modality: focus };

    const across = (function* (): Generator<SweepPosition> {
      for (let r = 1; r < columns.length; r++) yield { tuple: t0, modality: columns[r] };
    })();
    // Bounded, unlike the row arm: past one screenful the column is no longer what the user is looking at (docs/loading-architecture.md: sweep-cross-then-row-major).
    const down = (function* (): Generator<SweepPosition> {
      for (let k = 1; k <= reach; k++) {
        for (const tuple of [t0 + k, t0 - k]) if (tuple >= 0 && tuple < rows) yield { tuple, modality: focus };
      }
    })();
    const nextSlot = (arm: Generator<SweepPosition>): SweepPosition | undefined => {
      for (;;) {
        const step = arm.next();
        if (step.done) return undefined;
        if (this.grid[step.value.tuple]?.[step.value.modality] !== undefined) return step.value;
      }
    };
    // The cross, at equal rates: one slot from the row arm, one from the column arm, the row arm first (docs/loading-architecture.md: sweep-cross-then-row-major).
    let row = nextSlot(across);
    let column = nextSlot(down);
    let rowTurn = true;
    while (row !== undefined || column !== undefined) {
      if (row !== undefined && (rowTurn || column === undefined)) {
        yield row;
        row = nextSlot(across);
      } else {
        yield column!;
        column = nextSlot(down);
      }
      rowTurn = !rowTurn;
    }

    // Everything the cross did not reach, row-major centre-out — the whole grid, so no cell depends on the radius (docs/loading-architecture.md: sweep-cross-then-row-major, sweep-covers-every-slot-once).
    for (let k = 0; k < rows; k++) {
      for (const tuple of k === 0 ? [t0] : [t0 + k, t0 - k]) {
        if (tuple < 0 || tuple >= rows) continue;
        for (const modality of columns) yield { tuple, modality };
      }
    }
  }
}

/** Run the sweep: missing-slot errors first, then items dispatched centre-out, at most `chunk` outstanding and refilled per settle, each settle posting its result and a progress tick; a paused host suspends dispatch until it resumes, an abandoned one ends it early with the grid uncovered (docs/loading-architecture.md: thumbnails-centre-out, sweep-dispatch-bounded, sweep-stops-when-host-abandons, hidden-sweep-pauses-not-cancels). */
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

  // No centre supplied is an aim pinned at the first tile, which is what the plan's own order starts from (docs/loading-architecture.md: thumbnails-centre-out).
  const centre = options.centre ?? (() => ({ tuple: 0 }));
  // A host that never abandons is the old behaviour: the sweep runs to full coverage (docs/loading-architecture.md: sweep-stops-when-host-abandons).
  const abandoned = options.abandoned ?? (() => false);
  // A host that never pauses is the old behaviour too: it sweeps whether anyone is looking or not (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels).
  const paused = options.paused ?? (() => false);
  const chunk = Math.max(1, options.chunk ?? SWEEP_CHUNK);
  const cursor = new SweepCursor(plan.items);
  let done = 0;
  let outstanding = 0;
  let aimed: SweepAim | undefined;
  let pauseDropped = false;
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
      // A requeue re-uses the aim it was dropped for; re-reading here lets a drop's own fallout buy another drop, forever (docs/loading-architecture.md: sweep-aims-once-per-pass).
      pump(requeued && aimed !== undefined ? aimed : readAim(centre));
    } catch (error) {
      rejectSweep(error);
      return;
    }
    // An abandoned sweep leaves slots in the cursor, so the last outstanding settle is its exit (docs/loading-architecture.md: sweep-stops-when-host-abandons).
    if (outstanding === 0 && (cursor.remaining === 0 || abandoned())) resolveSweep();
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
  function pump(aim: SweepAim): void {
    // Nobody is watching: the rest of the grid stays in the cursor instead of being read for a window that is gone (docs/loading-architecture.md: sweep-stops-when-host-abandons).
    if (abandoned()) return;
    // Hidden, not gone: the queued dispatches go back to the cursor so the tab in focus gets those slots, and the grid is still owed (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels).
    if (paused()) {
      if (outstanding > 0 && !pauseDropped) {
        pauseDropped = true;
        io.dropQueued?.();
      }
      return;
    }
    pauseDropped = false;
    // The outstanding dispatches ARE the lag: drop the ones that never started so the new centre is next (docs/loading-architecture.md: sweep-cancels-on-reaim).
    if (!sameAim(aim, aimed)) {
      aimed = aim;
      if (outstanding > 0) io.dropQueued?.();
    }
    // One pass, one aim: a centre re-read per dispatch drops the slots this very pass just handed out (docs/loading-architecture.md: sweep-aims-once-per-pass).
    while (outstanding < chunk) {
      const item = cursor.next(aim);
      if (!item) return;
      dispatch(item);
    }
  }

  // The runner's own re-entry point: a pause acts at once, and a sweep paused with nothing outstanding still has an exit (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels).
  options.onRepump?.(() => {
    pump(readAim(centre));
    if (outstanding === 0 && (abandoned() || cursor.remaining === 0)) resolveSweep();
  });

  pump(readAim(centre));
  // Nothing dispatched means no settle can ever fire, so this is the only exit — unless a pause still owes the grid, and then the repump is (docs/loading-architecture.md: sweep-stops-when-host-abandons, hidden-sweep-pauses-not-cancels).
  if (outstanding === 0 && (abandoned() || !paused())) resolveSweep();
  return finished;
}
