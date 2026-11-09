import { describe, it, expect } from 'vitest';
import { toRelativeRect } from '../../src/cropPlan';

// Literals are external: expected fractions are hand-computed, never derived by re-running the code.
describe('toRelativeRect (real cropPlan code)', () => {
  it('Test 1: divides x/w by the width and y/h by the height (non-square source)', () => {
    expect(toRelativeRect({ x: 100, y: 50, w: 200, h: 25 }, 400, 100)).toEqual({
      x: 0.25, y: 0.5, w: 0.5, h: 0.25,
    });
  });
});
