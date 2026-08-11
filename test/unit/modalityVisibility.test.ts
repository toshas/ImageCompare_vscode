import { describe, it, expect } from 'vitest';
import { nextVisibleModality, isVoteClickable, WINNER_CIRCLE_PX, displayOrderAfterInsert } from '../../src/webview/modalityVisibility';

const V = false; // visible
const H = true; // hidden

describe('hidden-modality keyboard navigation (real modalityVisibility code)', () => {
  it('Test 1: no hidden pills — plain step', () => {
    expect(nextVisibleModality(0, 1, [V, V, V]), 'step right from 0 lands on 1').toBe(1);
    expect(nextVisibleModality(2, -1, [V, V, V]), 'step left from 2 lands on 1').toBe(1);
  });

  it('Test 2: a hidden neighbour is skipped', () => {
    expect(nextVisibleModality(0, 1, [V, H, V]), 'right over hidden 1 lands on 2').toBe(2);
    expect(nextVisibleModality(2, -1, [V, H, V]), 'left over hidden 1 lands on 0').toBe(0);
  });

  it('Test 3: a run of hidden pills is skipped in one step', () => {
    expect(nextVisibleModality(0, 1, [V, H, H, H, V]), 'right over hidden 1-3 lands on 4').toBe(4);
  });

  it('Test 4: non-wrapping — nothing visible beyond the edge means stay', () => {
    expect(nextVisibleModality(2, 1, [V, V, V]), 'right from the last pill stays').toBe(2);
    expect(nextVisibleModality(0, -1, [V, V, V]), 'left from the first pill stays').toBe(0);
    expect(nextVisibleModality(0, 1, [V, H, H]), 'right with only hidden pills ahead stays').toBe(0);
  });

  it('Test 5: everything else hidden — stay, even from a hidden current', () => {
    expect(nextVisibleModality(1, 1, [H, H, H]), 'all hidden: stay put').toBe(1);
  });

  it('Test 6: a hidden current pill still steps out to a visible one', () => {
    expect(nextVisibleModality(1, 1, [V, H, V]), 'from hidden 1, right lands on visible 2').toBe(2);
  });

  it('Test: mouse voting is disabled below 3x the winner-circle size', () => {
    expect(isVoteClickable(3 * WINNER_CIRCLE_PX), 'exactly 3x the circle must stay votable').toBe(true);
    expect(isVoteClickable(3 * WINNER_CIRCLE_PX - 0.5), 'just under 3x must not be votable').toBe(false);
    expect(isVoteClickable(12), 'the 12px tile floor must never vote by mouse').toBe(false);
    expect(isVoteClickable(50), 'natural-size tiles vote normally').toBe(true);
  });

  it('Test: a watcher-inserted modality preserves the user rearrangement', () => {
    // m1c1,m1c2,m2c1,m2c2,gtm1,gtm2 rearranged to m1c1,m1c2,gtm1,gtm2,m2c1,m2c2; m1c3 arrives at original 2.
    const r = displayOrderAfterInsert([0, 1, 4, 5, 2, 3], 2);
    expect(r.order, `expected [0,1,2,5,6,3,4], got ${JSON.stringify(r.order)}`).toEqual([0, 1, 2, 5, 6, 3, 4]);
    expect(r.displayPos, `new column must land after its original predecessor, got ${r.displayPos}`).toBe(2);

    // Inserted first in original order: lands before its original successor.
    const f = displayOrderAfterInsert([2, 0, 1], 0);
    expect(JSON.stringify(f.order) === JSON.stringify([3, 0, 1, 2]) && f.displayPos === 1,
      `expected [3,0,1,2]@1, got ${JSON.stringify(f.order)}@${f.displayPos}`).toBe(true);

    // Identity order stays identity.
    const i = displayOrderAfterInsert([0, 1, 2], 1);
    expect(JSON.stringify(i.order) === JSON.stringify([0, 1, 2, 3]) && i.displayPos === 1, 'identity must stay identity').toBe(true);
  });
});
