import { describe, it, expect } from 'vitest';
import { buildSavedView, planRestore } from '../../src/webview/viewState';

// A saved view names everything and restores by name against the comparison as it lists NOW
// (docs/standalone.md: view-restored-by-name). Every expected value below is worked out by hand
// from the listing, never derived from the module.

const DEFAULTS = { order: [0, 1, 2], hidden: [], tuple: 0, modality: 0, zoom: 1, panX: 0, panY: 0 };

describe('view state (viewState.ts, real code)', () => {
  it('saves names, never indices', () => {
    expect(buildSavedView(['pred', 'gt', 'depth'], [false, true, false], 'scene_02', 2, 3.5, -12, 40)).toEqual({
      order: ['pred', 'gt', 'depth'], hidden: ['gt'], tuple: 'scene_02', modality: 'depth', zoom: 3.5, panX: -12, panY: 40,
    });
  });

  it('applies a saved order by name onto a listing whose original order differs', () => {
    // Saved against [gt, pred, depth]; the listing now reads [depth, gt, pred].
    const plan = planRestore(
      { order: ['pred', 'depth', 'gt'], hidden: ['gt'], tuple: 'scene_03', modality: 'depth', zoom: 4, panX: 10, panY: -5 },
      ['depth', 'gt', 'pred'],
      ['scene_01', 'scene_02', 'scene_03'],
    );
    expect(plan).toEqual({ order: [2, 0, 1], hidden: [1], tuple: 2, modality: 0, zoom: 4, panX: 10, panY: -5 });
  });

  it('skips a name that is gone and appends an unseen modality after the saved ones, in default order', () => {
    // 'old' is gone; 'normal' and 'albedo' were never saved and keep their listing order (3 before 4).
    const plan = planRestore(
      { order: ['pred', 'old', 'gt'], hidden: ['old'], tuple: 'scene_01', modality: 'old' },
      ['gt', 'depth', 'pred', 'normal', 'albedo'],
      ['scene_01'],
    );
    expect(plan.order).toEqual([2, 0, 1, 3, 4]);
    expect(plan.hidden).toEqual([]);
    // The saved modality is gone: the first visible one in the restored order.
    expect(plan.modality).toBe(2);
  });

  it('a gone modality defaults to the first one that is not hidden', () => {
    const plan = planRestore({ order: ['pred', 'gt'], hidden: ['pred'], modality: 'gone' }, ['gt', 'pred'], ['a']);
    expect(plan.order).toEqual([1, 0]);
    expect(plan.modality).toBe(0);
  });

  it('a tuple name that is gone leaves the first tuple', () => {
    expect(planRestore({ tuple: 'scene_99' }, ['gt', 'pred', 'depth'], ['scene_01', 'scene_02']).tuple).toBe(0);
    expect(planRestore({ tuple: 'scene_02' }, ['gt', 'pred', 'depth'], ['scene_01', 'scene_02']).tuple).toBe(1);
  });

  it('clamps zoom to 0.1-50 and ignores non-finite numbers', () => {
    const names = ['gt', 'pred', 'depth'];
    expect(planRestore({ zoom: 400 }, names, ['a']).zoom).toBe(50);
    expect(planRestore({ zoom: 0.001 }, names, ['a']).zoom).toBe(0.1);
    expect(planRestore({ zoom: Infinity, panX: NaN, panY: -Infinity }, names, ['a'])).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
  });

  it('a malformed save restores every default and never throws', () => {
    const names = ['gt', 'pred', 'depth'];
    for (const bad of [null, undefined, 'garbage', 42, [], { order: 'gt', hidden: { gt: true }, tuple: 7, modality: [], zoom: '3', panX: '1' }]) {
      expect(planRestore(bad, names, ['a', 'b'])).toEqual(DEFAULTS);
    }
  });
});
