import { describe, it, expect } from 'vitest';
import { toRelativeRect, scaleAndClampRect } from '../../src/cropPlan';

// Literals are external: expected fractions are hand-computed, never derived by re-running the code.
describe('toRelativeRect (real cropPlan code)', () => {
  it('Test 1: divides x/w by the width and y/h by the height (non-square source)', () => {
    expect(toRelativeRect({ x: 100, y: 50, w: 200, h: 25 }, 400, 100)).toEqual({
      x: 0.25, y: 0.5, w: 0.5, h: 0.25,
    });
  });

  it('Test 2: round-trips through scaleAndClampRect at the source dimensions', () => {
    const rect = { x: 30, y: 40, w: 120, h: 60 };
    const rel = toRelativeRect(rect, 640, 480);
    expect(scaleAndClampRect(rel, 640, 480)).toEqual(rect);
  });
});
