import { describe, it, expect } from 'vitest';
import { matchDeletedFile, modalityInsertIndex, shiftIndexAfterRemoval, tupleInsertIndex, DeletedEntry } from '../../src/watcherLogic';

const D = '/exp/runA/images';

describe('file-watcher pure helpers (real watcherLogic code)', () => {
  describe('matchDeletedFile', () => {
    it('Test 1: single same-dir delete is treated as a rename', () => {
      const deleted: DeletedEntry[] = [{ dir: D, filename: 'a.png' }];
      expect(matchDeletedFile(deleted, D, 'b.png', true), 'expected index 0').toBe(0);
    });

    it('Test 2: two same-dir deletes are ambiguous -> no match (the hijack bug)', () => {
      const deleted: DeletedEntry[] = [
        { dir: D, filename: 'a.png' },
        { dir: D, filename: 'b.png' }
      ];
      expect(matchDeletedFile(deleted, D, 'c.png', true), 'ambiguous should return -1').toBe(-1);
    });

    it('Test 3: no pending delete -> no match', () => {
      expect(matchDeletedFile([], D, 'a.png', true), 'empty should return -1').toBe(-1);
    });

    it('Test 4: sibling-modality unique filename match', () => {
      const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
      // new file in a sibling modality dir under the same parent, same filename
      expect(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', true), 'expected sibling match at 0').toBe(0);
    });

    it('Test 5: sibling-modality requires filename match', () => {
      const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
      expect(matchDeletedFile(deleted, '/exp/runA/pred', 'other.png', true), 'different filename should not match').toBe(-1);
    });

    it('Test 6: sibling match disabled when not multi-tuple', () => {
      const deleted: DeletedEntry[] = [{ dir: '/exp/runA/gt', filename: 'img5.png' }];
      expect(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', false), 'single-tuple mode: no sibling match').toBe(-1);
    });

    it('Test 7: two sibling filename matches are ambiguous -> no match', () => {
      const deleted: DeletedEntry[] = [
        { dir: '/exp/runA/gt', filename: 'img5.png' },
        { dir: '/exp/runA/ref', filename: 'img5.png' }
      ];
      expect(matchDeletedFile(deleted, '/exp/runA/pred', 'img5.png', true), 'two sibling matches ambiguous').toBe(-1);
    });
  });

  describe('shiftIndexAfterRemoval', () => {
    it('Test 8: index before the removed one is unchanged', () => {
      expect(shiftIndexAfterRemoval(2, 5), 'index 2, remove 5 -> 2').toBe(2);
    });

    it('Test 9: index after the removed one shifts down', () => {
      expect(shiftIndexAfterRemoval(7, 5), 'index 7, remove 5 -> 6').toBe(6);
    });

    it('Test 10: the removed index itself is dropped (null)', () => {
      expect(shiftIndexAfterRemoval(5, 5), 'index 5, remove 5 -> null').toBeNull();
    });

    it('Test 11: adjacent-after shifts to the removed slot', () => {
      expect(shiftIndexAfterRemoval(6, 5), 'index 6, remove 5 -> 5').toBe(5);
    });
  });

  describe('modalityInsertIndex', () => {
    it('Test 12: caller order wins over alphabetical (mode-2 re-add)', () => {
      expect(modalityInsertIndex(['zebra', 'apple'], 'mid', ['zebra', 'mid', 'apple']), 'mid returns between zebra and apple').toBe(1);
    });

    it('Test 13: caller-ordered re-add lands back at the front', () => {
      expect(modalityInsertIndex(['pred', 'diff'], 'gt', ['gt', 'pred', 'diff']), 'gt returns to first').toBe(0);
    });

    it('Test 14: caller-ordered re-add lands back at the end', () => {
      expect(modalityInsertIndex(['gt', 'pred'], 'diff', ['gt', 'pred', 'diff']), 'diff returns to last').toBe(2);
    });

    it('Test 15: no caller order -> alphabetical (mode 1)', () => {
      expect(modalityInsertIndex(['apple', 'zebra'], 'mid'), 'mid sorts between apple and zebra').toBe(1);
    });

    it('Test 16: alphabetical is plain localeCompare, not natural (the documented mod3 caveat)', () => {
      expect(modalityInsertIndex(['mod2', 'mod10'], 'mod3'), 'mod3 appends after mod10 under plain compare').toBe(2);
    });

    it('Test 17: name missing from the caller order falls back to alphabetical', () => {
      expect(modalityInsertIndex(['apple', 'zebra'], 'mid', ['apple', 'zebra']), 'unranked name placed alphabetically').toBe(1);
    });
  });

  describe('tupleInsertIndex', () => {
    it('Test 18: a crop row lands right after its parent, wherever the user is', () => {
      expect(tupleInsertIndex(['img001', 'img002', 'img003'], 'img001_crop01'), 'crop inserts directly after img001').toBe(1);
    });

    it('Test 19: row insertion is natural-ordered, not plain-alphabetical', () => {
      expect(tupleInsertIndex(['img2', 'img10'], 'img3'), 'img3 sorts between img2 and img10').toBe(1);
    });

    it('Test 20: a row sorting after every existing name appends', () => {
      expect(tupleInsertIndex(['a', 'b'], 'z'), 'z appends at the end').toBe(2);
    });
  });
});
