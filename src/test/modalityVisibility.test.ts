/**
 * Tests for hidden-modality keyboard navigation. Imports the real implementation
 * (modalityVisibility.ts has no vscode or DOM dependency).
 *
 * Run: npx ts-node src/test/modalityVisibility.test.ts
 */

import { nextVisibleModality, isVoteClickable, WINNER_CIRCLE_PX, displayOrderAfterInsert } from '../webview/modalityVisibility';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

const V = false; // visible
const H = true; // hidden

console.log('Test 1: no hidden pills — plain step');
assert(nextVisibleModality(0, 1, [V, V, V]) === 1, 'step right from 0 lands on 1');
assert(nextVisibleModality(2, -1, [V, V, V]) === 1, 'step left from 2 lands on 1');

console.log('Test 2: a hidden neighbour is skipped');
assert(nextVisibleModality(0, 1, [V, H, V]) === 2, 'right over hidden 1 lands on 2');
assert(nextVisibleModality(2, -1, [V, H, V]) === 0, 'left over hidden 1 lands on 0');

console.log('Test 3: a run of hidden pills is skipped in one step');
assert(nextVisibleModality(0, 1, [V, H, H, H, V]) === 4, 'right over hidden 1-3 lands on 4');

console.log('Test 4: non-wrapping — nothing visible beyond the edge means stay');
assert(nextVisibleModality(2, 1, [V, V, V]) === 2, 'right from the last pill stays');
assert(nextVisibleModality(0, -1, [V, V, V]) === 0, 'left from the first pill stays');
assert(nextVisibleModality(0, 1, [V, H, H]) === 0, 'right with only hidden pills ahead stays');

console.log('Test 5: everything else hidden — stay, even from a hidden current');
assert(nextVisibleModality(1, 1, [H, H, H]) === 1, 'all hidden: stay put');

console.log('Test 6: a hidden current pill still steps out to a visible one');
assert(nextVisibleModality(1, 1, [V, H, V]) === 2, 'from hidden 1, right lands on visible 2');

console.log('Test: mouse voting is disabled below 3x the winner-circle size');
{
  assert(isVoteClickable(3 * WINNER_CIRCLE_PX) === true, 'exactly 3x the circle must stay votable');
  assert(isVoteClickable(3 * WINNER_CIRCLE_PX - 0.5) === false, 'just under 3x must not be votable');
  assert(isVoteClickable(12) === false, 'the 12px tile floor must never vote by mouse');
  assert(isVoteClickable(50) === true, 'natural-size tiles vote normally');
}

console.log('Test: a watcher-inserted modality preserves the user rearrangement');
{
  // m1c1,m1c2,m2c1,m2c2,gtm1,gtm2 rearranged to m1c1,m1c2,gtm1,gtm2,m2c1,m2c2; m1c3 arrives at original 2.
  const r = displayOrderAfterInsert([0, 1, 4, 5, 2, 3], 2);
  assert(JSON.stringify(r.order) === JSON.stringify([0, 1, 2, 5, 6, 3, 4]), `expected [0,1,2,5,6,3,4], got ${JSON.stringify(r.order)}`);
  assert(r.displayPos === 2, `new column must land after its original predecessor, got ${r.displayPos}`);

  // Inserted first in original order: lands before its original successor.
  const f = displayOrderAfterInsert([2, 0, 1], 0);
  assert(JSON.stringify(f.order) === JSON.stringify([3, 0, 1, 2]) && f.displayPos === 1, `expected [3,0,1,2]@1, got ${JSON.stringify(f.order)}@${f.displayPos}`);

  // Identity order stays identity.
  const i = displayOrderAfterInsert([0, 1, 2], 1);
  assert(JSON.stringify(i.order) === JSON.stringify([0, 1, 2, 3]) && i.displayPos === 1, 'identity must stay identity');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
