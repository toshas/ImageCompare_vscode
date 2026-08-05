/**
 * Tests for the pure file-watcher helpers (rename disambiguation + index
 * re-indexing). Imports the real implementation (watcherLogic.ts has no vscode
 * dependency).
 *
 * Run: npx ts-node src/test/watcherLogic.test.ts
 */

import { matchDeletedFile, modalityInsertIndex, shiftIndexAfterRemoval, tupleInsertIndex, DeletedEntry } from '../watcherLogic';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function printResults() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed!');
}

const D = '/exp/runA/images';

// ── matchDeletedFile ────────────────────────────────────────────────────────

console.log('Test 1: single same-dir delete is treated as a rename');
{
  const deleted: DeletedEntry[] = [{ dir: D, filename: 'a.png' }];
  assert(matchDeletedFile(deleted, D, 'b.png', true) === 0, 'expected index 0');
}

console.log('Test 2: two same-dir deletes are ambiguous -> no match (the hijack bug)');
{
  const deleted: DeletedEntry[] = [
    { dir: D, filename: 'a.png' },
    { dir: D, filename: 'b.png' }
  ];
  assert(matchDeletedFile(deleted, D, 'c.png', true) === -1, 'ambiguous should return -1');
}

console.log('Test 3: no pending delete -> no match');
{
  assert(matchDeletedFile([], D, 'a.png', true) === -1, 'empty should return -1');
}

console.log('Test 4: sibling-modality unique filename match');
{
  const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
  // new file in a sibling modality dir under the same parent, same filename
  assert(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', true) === 0, 'expected sibling match at 0');
}

console.log('Test 5: sibling-modality requires filename match');
{
  const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
  assert(matchDeletedFile(deleted, '/exp/runA/pred', 'other.png', true) === -1, 'different filename should not match');
}

console.log('Test 6: sibling match disabled when not multi-tuple');
{
  const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
  assert(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', false) === -1, 'single-tuple mode: no sibling match');
}

console.log('Test 7: two sibling filename matches are ambiguous -> no match');
{
  const deleted: DeletedEntry[] = [
    { dir: '/exp/runA/gt', filename: 'img5.png' },
    { dir: '/exp/runA/ref', filename: 'img5.png' }
  ];
  assert(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', true) === -1, 'two sibling matches ambiguous');
}

// ── shiftIndexAfterRemoval ──────────────────────────────────────────────────

console.log('Test 8: index before the removed one is unchanged');
assert(shiftIndexAfterRemoval(2, 5) === 2, 'index 2, remove 5 -> 2');

console.log('Test 9: index after the removed one shifts down');
assert(shiftIndexAfterRemoval(7, 5) === 6, 'index 7, remove 5 -> 6');

console.log('Test 10: the removed index itself is dropped (null)');
assert(shiftIndexAfterRemoval(5, 5) === null, 'index 5, remove 5 -> null');

console.log('Test 11: adjacent-after shifts to the removed slot');
assert(shiftIndexAfterRemoval(6, 5) === 5, 'index 6, remove 5 -> 5');

// ── modalityInsertIndex ─────────────────────────────────────────────────────

console.log('Test 12: caller order wins over alphabetical (mode-2 re-add)');
assert(modalityInsertIndex(['zebra', 'apple'], 'mid', ['zebra', 'mid', 'apple']) === 1, 'mid returns between zebra and apple');

console.log('Test 13: caller-ordered re-add lands back at the front');
assert(modalityInsertIndex(['pred', 'diff'], 'gt', ['gt', 'pred', 'diff']) === 0, 'gt returns to first');

console.log('Test 14: caller-ordered re-add lands back at the end');
assert(modalityInsertIndex(['gt', 'pred'], 'diff', ['gt', 'pred', 'diff']) === 2, 'diff returns to last');

console.log('Test 15: no caller order -> alphabetical (mode 1)');
assert(modalityInsertIndex(['apple', 'zebra'], 'mid') === 1, 'mid sorts between apple and zebra');

console.log('Test 16: alphabetical is plain localeCompare, not natural (the documented mod3 caveat)');
assert(modalityInsertIndex(['mod2', 'mod10'], 'mod3') === 2, 'mod3 appends after mod10 under plain compare');

console.log('Test 17: name missing from the caller order falls back to alphabetical');
assert(modalityInsertIndex(['apple', 'zebra'], 'mid', ['apple', 'zebra']) === 1, 'unranked name placed alphabetically');

// ── tupleInsertIndex ────────────────────────────────────────────────────────

console.log('Test 18: a crop row lands right after its parent, wherever the user is');
assert(tupleInsertIndex(['img001', 'img002', 'img003'], 'img001_crop01') === 1, 'crop inserts directly after img001');

console.log('Test 19: row insertion is natural-ordered, not plain-alphabetical');
assert(tupleInsertIndex(['img2', 'img10'], 'img3') === 1, 'img3 sorts between img2 and img10');

console.log('Test 20: a row sorting after every existing name appends');
assert(tupleInsertIndex(['a', 'b'], 'z') === 2, 'z appends at the end');

printResults();
