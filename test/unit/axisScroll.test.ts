import { describe, it, expect } from 'vitest';
import { ALT_SPEED, ZOOM_STEP, centreOffset, scrollStep, wheelPixels, zoomFactor } from '../../src/webview/axisScroll';

// Values are computed by hand from the geometry, never re-derived from the implementation.
describe('axis scrolling (axisScroll.ts, real code)', () => {
  describe('centreOffset', () => {
    it('centres the item in the viewport', () => {
      // item 5 of a 20px pitch starts at 100, is 20 tall, viewport 200 -> 100 - (200-20)/2 = 10.
      expect(centreOffset(100, 20, 200, 1000)).toBe(10);
    });

    it('clamps at both ends rather than scrolling past the content', () => {
      expect(centreOffset(0, 20, 200, 1000)).toBe(0);
      // The last item of a 1000px content in a 200px viewport can only reach 800.
      expect(centreOffset(980, 20, 200, 1000)).toBe(800);
    });

    it('returns 0 when the content fits, so a short axis never scrolls', () => {
      expect(centreOffset(60, 20, 200, 150)).toBe(0);
    });

    // The snap is what makes an arrow step move the grid exactly one item or not at all; without it
    // the offset lands mid-item and every subsequent step inherits the fractional error.
    it('snaps to the item pitch when one is given', () => {
      // Raw centre for item 5 at pitch 30, viewport 100: 150 - (100-30)/2 = 115 -> snapped to 120.
      expect(centreOffset(150, 30, 100, 3000)).toBe(115);
      expect(centreOffset(150, 30, 100, 3000, 30)).toBe(120);
      // Consecutive items differ by exactly one pitch once snapped.
      const a = centreOffset(150, 30, 100, 3000, 30);
      const b = centreOffset(180, 30, 100, 3000, 30);
      expect(b - a).toBe(30);
    });

    it('honours an origin offset, so an axis whose first item is padded still centres', () => {
      // The carousel's tiles start 6px in; the same item therefore sits 6px further along.
      expect(centreOffset(6 + 100, 20, 200, 1000)).toBe(centreOffset(100, 20, 200, 1000) + 6);
    });
  });

  describe('wheel units', () => {
    // A LINE-mode wheel sends "3" meaning three lines. Read as pixels that is a 3px scroll, which is
    // what a gentle swipe on the carousel actually did before this: it barely moved.
    it('converts a line-mode delta into pixels using the caller s line', () => {
      expect(wheelPixels(3, 1, 14, 700)).toBe(42);
      expect(wheelPixels(-3, 1, 14, 700)).toBe(-42);
    });

    it('converts a page-mode delta with the caller s page', () => {
      expect(wheelPixels(1, 2, 14, 700)).toBe(700);
    });

    it('leaves a pixel-mode delta alone', () => {
      expect(wheelPixels(120, 0, 14, 700)).toBe(120);
    });
  });

  describe('Alt speed', () => {
    it('multiplies a linear scroll, because distance adds', () => {
      expect(scrollStep(12, false)).toBe(12);
      expect(scrollStep(12, true)).toBe(12 * ALT_SPEED);
      expect(scrollStep(-12, true)).toBe(-12 * ALT_SPEED);
    });

    it('compounds the zoom step, because zoom multiplies', () => {
      const inOne = zoomFactor(-1, false);
      const outOne = zoomFactor(1, false);
      expect(inOne).toBe(1 + ZOOM_STEP);
      expect(outOne).toBe(1 - ZOOM_STEP);
      // ALT_SPEED notches of the plain step, not the step scaled by ALT_SPEED — the two differ a lot
      // (1.03^5 = 1.159 vs 1.15), and only the former makes Alt mean the same movement on every axis.
      expect(zoomFactor(-1, true)).toBeCloseTo(inOne ** ALT_SPEED, 12);
      expect(zoomFactor(1, true)).toBeCloseTo(outOne ** ALT_SPEED, 12);
      expect(zoomFactor(-1, true)).not.toBeCloseTo(1 + ZOOM_STEP * ALT_SPEED, 3);
    });

    it('keeps zoom in and out exact inverses, Alt or not, so a notch back undoes a notch', () => {
      expect(zoomFactor(-1, false) * zoomFactor(1, false)).toBeCloseTo(1 - ZOOM_STEP ** 2, 12);
      expect(zoomFactor(-1, true) * zoomFactor(1, true)).toBeCloseTo((1 - ZOOM_STEP ** 2) ** ALT_SPEED, 12);
    });
  });
});
