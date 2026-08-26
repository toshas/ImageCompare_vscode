import { describe, expect, it } from 'vitest';
import {
  LOAD_DEBOUNCE_MS,
  NEAREST_SIBLINGS,
  rankCovers,
  siblingLoadPlan,
  tupleArrivalPlan
} from '../../src/webview/tupleLoadPlan';

// The load *policy* a tuple arrival applies, on the real module the webview bundle imports.
// The field pathology it replaces: every visited tuple requested all ten modalities on arrival, so
// browsing 746 tuples queued 7460 full-resolution loads and the carousel sweep got ~4 tiles/s.
// Three decisions live here and each is a separate way to regress silently — arrival requests only
// the on-screen modality, siblings are ordered by *display* distance (skipping hidden pills, which
// no cycling key can reach), and only the nearest two rank as siblings.
// (docs/loading-architecture.md: siblings-dwell-gated, sibling-order-by-display-distance)

const ids = (plan: { modalityIndex: number }[]): number[] => plan.map(p => p.modalityIndex);
const ranks = (plan: { rank: string }[]): string[] => plan.map(p => p.rank);

/** Default rig: six modalities in identity display order, nothing hidden, nothing cached. */
function plan(over: Partial<Parameters<typeof siblingLoadPlan>[0]> = {}) {
  return siblingLoadPlan({
    modalityOrder: [0, 1, 2, 3, 4, 5],
    currentDisplayIndex: 2,
    isHidden: () => false,
    isCached: () => false,
    ...over
  });
}

describe('tuple arrival plan (what a navigation asks for now)', () => {
  it('requests exactly the on-screen modality and defers every sibling', () => {
    const arrival = tupleArrivalPlan({
      modalityOrder: [0, 1, 2, 3, 4, 5],
      currentDisplayIndex: 2,
      isHidden: () => false,
      isCached: () => false
    });
    expect(ids(arrival.now)).toEqual([2]);
    expect(ranks(arrival.now)).toEqual(['visible']);
    // The other five ride the dwell, or the pathology is back at full strength.
    expect(arrival.afterDwell).toHaveLength(5);
  });

  it('asks for nothing on arrival when the shown modality is already cached', () => {
    const arrival = tupleArrivalPlan({
      modalityOrder: [0, 1, 2],
      currentDisplayIndex: 1,
      isHidden: () => false,
      isCached: o => o === 1
    });
    expect(arrival.now).toEqual([]);
  });

  it('dwells for the navigation debounce, not an invented interval', () => {
    // One constant for both, so the dwell cannot drift away from the burst window it is defined by.
    expect(LOAD_DEBOUNCE_MS).toBe(150);
  });
});

// The rank a slot is outstanding at decides whether a later, more urgent ask is suppressed. A queued
// task is never promoted by either host — the rank is mapped to a pool priority once, at submit — so
// a flip onto a slot already queued at `tail` (admitted only when nothing else has queue) is a
// spinner for the sweep's whole duration unless the webview re-posts it.
// (docs/loading-architecture.md: request-rank-upgrades)
describe('outstanding-request ranks: visible > sibling > tail', () => {
  it('suppresses a re-ask only when the outstanding request ranks at least as high', () => {
    expect(rankCovers('visible', 'visible')).toBe(true);
    expect(rankCovers('visible', 'sibling')).toBe(true);
    expect(rankCovers('visible', 'tail')).toBe(true);
    expect(rankCovers('sibling', 'sibling')).toBe(true);
    expect(rankCovers('sibling', 'tail')).toBe(true);
    expect(rankCovers('tail', 'tail')).toBe(true);
  });

  it('re-asks when the slot is queued below the rank now needed', () => {
    // The regression that shipped: after the dwell, a flip onto a tail-ranked slot posted nothing.
    expect(rankCovers('tail', 'visible')).toBe(false);
    expect(rankCovers('sibling', 'visible')).toBe(false);
    expect(rankCovers('tail', 'sibling')).toBe(false);
  });

  it('never suppresses a slot with no outstanding request', () => {
    expect(rankCovers(undefined, 'visible')).toBe(false);
    expect(rankCovers(undefined, 'tail')).toBe(false);
  });
});

describe('sibling load plan: distance over the display order', () => {
  it('orders nearest-first, forward before backward at equal distance', () => {
    // 3 is what the next `→` reaches, so it must arrive first.
    expect(ids(plan())).toEqual([3, 1, 4, 0, 5]);
  });

  it('measures distance over the user-rearranged display order, not raw modality ids', () => {
    // Display order [3,0,2,1] on screen: from display 0 the neighbours are originals 0, 2, 1.
    // A raw-id implementation would answer [0,1,2] here.
    expect(ids(plan({ modalityOrder: [3, 0, 2, 1], currentDisplayIndex: 0 }))).toEqual([0, 2, 1]);
  });

  it('skips hidden modalities entirely, and does not count them as distance', () => {
    // Pill at display 3 is hidden: `→` from display 2 lands on 4, so 4 is the nearest sibling.
    const p = plan({ isHidden: o => o === 3 });
    expect(ids(p)).toEqual([4, 1, 5, 0]);
    expect(ranks(p).slice(0, 2)).toEqual(['sibling', 'sibling']);
  });

  it('still plans from a hidden current modality (click and digit jump reach one)', () => {
    const p = plan({ currentDisplayIndex: 2, isHidden: o => o === 2 });
    expect(ids(p)).toEqual([3, 1, 4, 0, 5]);
  });

  it('omits slots the webview already holds, and ranks over what is left', () => {
    const p = plan({ isCached: o => o === 3 || o === 1 });
    expect(ids(p)).toEqual([4, 0, 5]);
    expect(ranks(p)).toEqual(['sibling', 'sibling', 'tail']);
  });
});

describe('sibling load plan: only the nearest two are load-bearing', () => {
  it('ranks the nearest two as siblings and everything beyond as tail', () => {
    expect(ranks(plan())).toEqual(['sibling', 'sibling', 'tail', 'tail', 'tail']);
    expect(NEAREST_SIBLINGS).toBe(2);
  });

  it('never ranks more than the nearest two above the tail, however wide the tuple', () => {
    const wide = plan({ modalityOrder: Array.from({ length: 12 }, (_, i) => i), currentDisplayIndex: 6 });
    expect(ranks(wide).filter(r => r === 'sibling')).toHaveLength(2);
    expect(ranks(wide).filter(r => r === 'tail')).toHaveLength(9);
  });

  it('is empty for a single-modality tuple', () => {
    expect(plan({ modalityOrder: [0], currentDisplayIndex: 0 })).toEqual([]);
  });
});
