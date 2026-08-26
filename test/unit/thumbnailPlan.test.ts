import { describe, it, expect } from 'vitest';
import { planThumbnails } from '../../src/thumbnailPlan';

// Fixture literals are external to the implementation: slots and order are written out by hand,
// never derived by re-running the planner's own loops.
const img = (modality: string, name: string) => ({ modality, name });

describe('thumbnail sweep plan (thumbnailPlan.ts, real code)', () => {
  it('plans slots in scanline order: tuple-major, modality-minor', () => {
    const tuples = [
      { images: [img('gt', 'a_gt.png'), img('pred', 'a_pred.png')] },
      { images: [img('gt', 'b_gt.png'), img('pred', 'b_pred.png')] },
    ];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    expect(plan.items.map(i => [i.tupleIndex, i.modalityIndex])).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1],
    ]);
    expect(plan.items.map(i => i.image.name)).toEqual([
      'a_gt.png', 'a_pred.png', 'b_gt.png', 'b_pred.png',
    ]);
    expect(plan.missing).toEqual([]);
    expect(plan.total).toBe(4);
  });

  it('slot order follows the modalities array, not each tuple\'s sparse image order', () => {
    // The tuple lists pred before gt; the plan must still walk gt (column 0) first.
    const tuples = [{ images: [img('pred', 'a_pred.png'), img('gt', 'a_gt.png')] }];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    expect(plan.items.map(i => i.image.name)).toEqual(['a_gt.png', 'a_pred.png']);
  });

  it('reports a slot whose modality the tuple lacks as missing, at its grid position', () => {
    const tuples = [
      { images: [img('gt', 'a_gt.png')] },
      { images: [img('gt', 'b_gt.png'), img('pred', 'b_pred.png')] },
    ];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    expect(plan.missing).toEqual([{ tupleIndex: 0, modalityIndex: 1 }]);
    expect(plan.items.map(i => [i.tupleIndex, i.modalityIndex])).toEqual([
      [0, 0], [1, 0], [1, 1],
    ]);
    expect(plan.total).toBe(4);
  });

  it('zero-item terminal case: every slot missing still yields the full progress total', () => {
    // The progress bar's terminal tick is (total, total); with no items the caller has no
    // per-item callback, so `total` must already count the missing slots.
    const tuples = [{ images: [] }, { images: [] }];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    expect(plan.items).toEqual([]);
    expect(plan.missing).toEqual([
      { tupleIndex: 0, modalityIndex: 0 }, { tupleIndex: 0, modalityIndex: 1 },
      { tupleIndex: 1, modalityIndex: 0 }, { tupleIndex: 1, modalityIndex: 1 },
    ]);
    expect(plan.total).toBe(4);
  });

  it('no tuples at all plans nothing with total 0', () => {
    const plan = planThumbnails([], ['gt', 'pred']);
    expect(plan.items).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.total).toBe(0);
  });

  it('total always equals items plus missing', () => {
    const tuples = [
      { images: [img('gt', 'a_gt.png')] },
      { images: [img('pred', 'b_pred.png')] },
      { images: [img('gt', 'c_gt.png'), img('pred', 'c_pred.png')] },
    ];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    expect(plan.items.length).toBe(4);
    expect(plan.missing.length).toBe(2);
    expect(plan.total).toBe(6);
  });
});
