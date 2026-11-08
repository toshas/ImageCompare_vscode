import { describe, it, expect } from 'vitest';
import { dropSlot, movedIndex, slotShift } from '../../src/webview/pillReorder';

// Every expected value below is written out by hand from the docs/pointer-input.md contract
// ("A reorder is one move"), never recomputed from the function under test.

describe('pill reorder (pillReorder.ts, real code)', () => {
  describe('movedIndex — a move, not a swap', () => {
    it('moving 0 -> 2 of four: the moved one lands at 2, the two it passed close up leftward, the rest stay', () => {
      // [A, B, C, D] -> [B, C, A, D]
      expect([0, 1, 2, 3].map((k) => movedIndex(k, 0, 2))).toEqual([2, 0, 1, 3]);
    });

    it('moving 3 -> 1 of five: the moved one lands at 1, the two it passed close up rightward, the rest stay', () => {
      // [A, B, C, D, E] -> [A, D, B, C, E]
      expect([0, 1, 2, 3, 4].map((k) => movedIndex(k, 3, 1))).toEqual([0, 2, 3, 1, 4]);
    });

    it('a vote on a pill strictly between from and to follows that pill, not the moved one', () => {
      // Vote on C (index 2); A moves 0 -> 3 in [A, B, C, D, E] -> [B, C, D, A, E]: C is now at 1.
      expect(movedIndex(2, 0, 3)).toBe(1);
      // Vote on B (index 1); E moves 4 -> 0 in [A, B, C, D, E] -> [E, A, B, C, D]: B is now at 2.
      expect(movedIndex(1, 4, 0)).toBe(2);
    });

    it('from === to is the identity', () => {
      expect([0, 1, 2, 3].map((k) => movedIndex(k, 2, 2))).toEqual([0, 1, 2, 3]);
    });
  });

  describe('dropSlot — binary search over the resting midpoints', () => {
    // Four 20px pills with a 0px gap: midpoints at 10, 30, 50, 70.
    const MIDS = [10, 30, 50, 70];

    it('a centre that has not moved stays in its own slot', () => {
      expect(dropSlot(MIDS, 1, 30)).toBe(1);
    });

    it('exactly at a neighbour midpoint does not pass it; strictly beyond does (right)', () => {
      expect(dropSlot(MIDS, 1, 50)).toBe(1);
      expect(dropSlot(MIDS, 1, 50.5)).toBe(2);
      expect(dropSlot(MIDS, 1, 70)).toBe(2);
      expect(dropSlot(MIDS, 1, 70.5)).toBe(3);
    });

    it('exactly at a neighbour midpoint does not pass it; strictly beyond does (left)', () => {
      expect(dropSlot(MIDS, 2, 30)).toBe(2);
      expect(dropSlot(MIDS, 2, 29.5)).toBe(1);
      expect(dropSlot(MIDS, 2, 10)).toBe(1);
      expect(dropSlot(MIDS, 2, 9.5)).toBe(0);
    });

    it('beyond either end clamps to the end slot', () => {
      expect(dropSlot(MIDS, 1, 1000)).toBe(3);
      expect(dropSlot(MIDS, 1, -1000)).toBe(0);
    });

    it('from the first slot', () => {
      expect(dropSlot(MIDS, 0, 10)).toBe(0);
      expect(dropSlot(MIDS, 0, 30)).toBe(0);
      expect(dropSlot(MIDS, 0, 31)).toBe(1);
      expect(dropSlot(MIDS, 0, 71)).toBe(3);
      expect(dropSlot(MIDS, 0, -50)).toBe(0);
    });

    it('from the last slot', () => {
      expect(dropSlot(MIDS, 3, 70)).toBe(3);
      expect(dropSlot(MIDS, 3, 50)).toBe(3);
      expect(dropSlot(MIDS, 3, 49)).toBe(2);
      expect(dropSlot(MIDS, 3, 9)).toBe(0);
      expect(dropSlot(MIDS, 3, 500)).toBe(3);
    });

    it('uneven pill widths: the slot follows the midpoints, not an even pitch', () => {
      // Pills 0..3 at lefts 0, 100, 112, 124 with widths 96, 8, 8, 40: midpoints 48, 104, 116, 144.
      const mids = [48, 104, 116, 144];
      expect(dropSlot(mids, 0, 110)).toBe(1);
      expect(dropSlot(mids, 0, 117)).toBe(2);
      expect(dropSlot(mids, 0, 145)).toBe(3);
    });
  });

  describe('slotShift — who slides aside, and which way', () => {
    it('moving right: the pills it passed slide left by one shift, the rest stay', () => {
      expect([0, 2, 3, 4].map((j) => slotShift(j, 1, 3, 24))).toEqual([0, -24, -24, 0]);
    });

    it('moving left: the pills it passed slide right by one shift, the rest stay', () => {
      expect([0, 1, 2, 4].map((j) => slotShift(j, 3, 1, 24))).toEqual([0, 24, 24, 0]);
    });

    it('hovering over its own slot shifts nobody', () => {
      expect([0, 1, 3, 4].map((j) => slotShift(j, 2, 2, 24))).toEqual([0, 0, 0, 0]);
    });
  });
});
