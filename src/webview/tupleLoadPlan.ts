/**
 * What a tuple arrival asks the extension to load, and in what order.
 * Pure (no DOM, no vscode): the policy the webview applies on every navigation.
 * See docs/loading-architecture.md, "Request path (the image on screen)".
 */

/** Wire rank of one slot request; the host maps it to a pool priority. */
export type SlotRank = 'visible' | 'sibling' | 'tail';

export interface SlotRequest {
  /** Original modality index — the wire space, never a display position. */
  modalityIndex: number;
  rank: SlotRank;
}

export interface TupleLoadInput {
  /** Display position -> original modality index. */
  modalityOrder: readonly number[];
  currentDisplayIndex: number;
  isHidden: (originalIndex: number) => boolean;
  /** The webview already holds this modality's frame for the arriving tuple. */
  isCached: (originalIndex: number) => boolean;
}

/** Navigation debounce and sibling dwell: one constant, deliberately (docs/loading-architecture.md: siblings-dwell-gated). */
export const LOAD_DEBOUNCE_MS = 150;

/** Rank ladder, highest first; the host maps each rank to a pool priority once, at submit. */
const RANK_ORDER: Record<SlotRank, number> = { visible: 2, sibling: 1, tail: 0 };

/** Whether an outstanding request at `posted` already covers one now wanted at `wanted` (docs/loading-architecture.md: request-rank-upgrades). */
export function rankCovers(posted: SlotRank | undefined, wanted: SlotRank): boolean {
  return posted !== undefined && RANK_ORDER[posted] >= RANK_ORDER[wanted];
}

/** Siblings this near stay load-bearing; beyond it a flip is rare enough to pay for itself. */
export const NEAREST_SIBLINGS = 2;

/**
 * Siblings of the current tuple, nearest first over the *display* order with hidden pills skipped
 * (they are unreachable by cycling), split so only the nearest two rank above the tail.
 */
export function siblingLoadPlan(input: TupleLoadInput): SlotRequest[] {
  const { modalityOrder, currentDisplayIndex, isHidden, isCached } = input;
  // Hidden pills are skipped as targets *and* as steps; the current one counts even when hidden, since a click or digit jump can land on it (docs/loading-architecture.md: sibling-order-by-display-distance).
  const reachable: number[] = [];
  for (let d = 0; d < modalityOrder.length; d++) {
    if (d === currentDisplayIndex || !isHidden(modalityOrder[d])) reachable.push(d);
  }
  const here = reachable.indexOf(currentDisplayIndex);
  if (here < 0) return [];

  const ordered = reachable
    .map((display, step) => ({ display, step }))
    .filter(c => c.display !== currentDisplayIndex)
    .filter(c => !isCached(modalityOrder[c.display]))
    // Distance in display steps, forward winning an equal-distance tie (docs/loading-architecture.md: sibling-order-by-display-distance).
    .sort((a, b) => Math.abs(a.step - here) - Math.abs(b.step - here) || b.step - a.step);

  return ordered.map((c, i) => ({
    modalityIndex: modalityOrder[c.display],
    rank: i < NEAREST_SIBLINGS ? 'sibling' : 'tail'
  }));
}

/**
 * The whole arrival policy: the on-screen modality now, every sibling only after a dwell the next
 * navigation cancels. Requesting the tuple up front is what queued ten full-resolution loads per
 * tuple passed (docs/loading-architecture.md: siblings-dwell-gated).
 */
export function tupleArrivalPlan(input: TupleLoadInput): { now: SlotRequest[]; afterDwell: SlotRequest[] } {
  const shown = input.modalityOrder[input.currentDisplayIndex];
  const now: SlotRequest[] = shown === undefined || input.isCached(shown)
    ? []
    : [{ modalityIndex: shown, rank: 'visible' }];
  return { now, afterDwell: siblingLoadPlan(input) };
}
