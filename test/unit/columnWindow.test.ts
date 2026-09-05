import { describe, it, expect } from 'vitest';
import {
  COLUMN_OVERSCAN,
  MIN_COLUMN_PITCH,
  columnLeft,
  columnPoolSize,
  columnWindow,
} from '../../src/webview/columnWindow';

// The field grid this exists for: 265 tuples x 136 modality columns. At a 220px carousel the tiles
// hit their 12px floor, so the row is 12 + 136*12 + 135*2 = 1914px inside a 220px scroller.
const CAROUSEL_W = 220;
const COLS = 136;
const PITCH = 14; // floored 12px tile + 2px gap
const PAD = 6;

describe('column window (columnWindow.ts, real code)', () => {
  describe('pool size', () => {
    it('is bounded by the viewport, not the modality count — the whole point of the change', () => {
      const pool = columnPoolSize(CAROUSEL_W, COLS);
      // ceil(220/14) = 16 visible at the narrowest, + 2*2 overscan + 2 spare.
      expect(pool).toBe(22);
      expect(pool).toBeLessThan(COLS);
      // Ten times the columns costs the same pool.
      expect(columnPoolSize(CAROUSEL_W, COLS * 10)).toBe(22);
    });

    it('never exceeds the columns that exist', () => {
      expect(columnPoolSize(CAROUSEL_W, 3)).toBe(3);
      expect(columnPoolSize(CAROUSEL_W, 0)).toBe(0);
    });

    // Stated as a property with hand-computed numbers, not as the implementation's own formula: an
    // earlier version asserted ceil(W/MIN_PITCH) + 2*OVERSCAN + 2, which is the code compared to
    // itself and would survive any change made to both at once.
    it('is sized from the narrowest tile, so resizing tiles never remaps the ring', () => {
      // The signature is the proof: no pitch is passed, so a tile resize cannot move the pool.
      expect(columnPoolSize.length).toBe(2);
      // 220px of strip at the 14px floor holds 16 columns; the ring adds 2 either side and 1 spare
      // each end, which is the 22 the other tests pin. It does not move when the tiles do.
      expect(columnPoolSize(CAROUSEL_W, COLS)).toBe(22);
      expect(MIN_COLUMN_PITCH).toBe(14);
      expect(COLUMN_OVERSCAN).toBe(2);
    });

    it('grows with the viewport', () => {
      expect(columnPoolSize(880, COLS)).toBeGreaterThan(columnPoolSize(220, COLS));
    });
  });

  describe('visible range', () => {
    it('covers the viewport plus the overscan at the left edge', () => {
      // scrollLeft 0: first tile starts at pad, so column 0 is first; last = floor((220-6)/14)+2 = 17.
      expect(columnWindow(0, CAROUSEL_W, PITCH, PAD, COLS)).toEqual({ first: 0, last: 17 });
    });

    // Away from the clamps: at scrollLeft 0 the overscan is already off the left edge, so `first`
    // stays pinned at 0 for the first few pitches — correct, and not the property under test.
    it('advances by one column per pitch scrolled', () => {
      const a = columnWindow(50 * PITCH, CAROUSEL_W, PITCH, PAD, COLS);
      const b = columnWindow(51 * PITCH, CAROUSEL_W, PITCH, PAD, COLS);
      expect(b.first - a.first).toBe(1);
      expect(b.last - a.last).toBe(1);
    });

    it('holds the left clamp until the overscan clears the edge, rather than going negative', () => {
      expect(columnWindow(0, CAROUSEL_W, PITCH, PAD, COLS).first).toBe(0);
      expect(columnWindow(PITCH, CAROUSEL_W, PITCH, PAD, COLS).first).toBe(0);
      // floor((4*14 - 6)/14) - 2 = 3 - 2 = 1; one pitch later, 2. Hand-computed, pad included.
      expect(columnWindow(4 * PITCH, CAROUSEL_W, PITCH, PAD, COLS).first).toBe(1);
      expect(columnWindow(5 * PITCH, CAROUSEL_W, PITCH, PAD, COLS).first).toBe(2);
    });

    it('clamps at the right edge instead of running past the last column', () => {
      const w = columnWindow(99999, CAROUSEL_W, PITCH, PAD, COLS);
      expect(w.last).toBe(COLS - 1);
      expect(w.first).toBeLessThanOrEqual(COLS - 1);
    });

    it('fits inside the pool it will be bound into — the ring depends on it', () => {
      const pool = columnPoolSize(CAROUSEL_W, COLS);
      for (let scroll = 0; scroll < COLS * PITCH; scroll += PITCH) {
        const { first, last } = columnWindow(scroll, CAROUSEL_W, PITCH, PAD, COLS);
        expect(last - first + 1).toBeLessThanOrEqual(pool);
      }
    });

    it('binds every column when they all fit, so a narrow grid is unchanged', () => {
      expect(columnWindow(0, CAROUSEL_W, 60, PAD, 3)).toEqual({ first: 0, last: 2 });
    });

    it('reports an empty range rather than a bogus one when there is nothing to draw', () => {
      expect(columnWindow(0, CAROUSEL_W, PITCH, PAD, 0)).toEqual({ first: 0, last: -1 });
      expect(columnWindow(0, CAROUSEL_W, 0, PAD, COLS)).toEqual({ first: 0, last: -1 });
    });
  });

  it('places a column where the row s padding and pitch say it goes', () => {
    expect(columnLeft(0, PITCH, PAD)).toBe(6);
    expect(columnLeft(1, PITCH, PAD)).toBe(20);
    expect(columnLeft(135, PITCH, PAD)).toBe(6 + 135 * 14);
  });
});
