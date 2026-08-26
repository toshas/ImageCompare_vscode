import { describe, it, expect } from 'vitest';
import { planArrival, applyArrival, ArrivalPlan } from '../../src/arrivalPlan';

// Fixture literals are external to the implementation: indices, names and message
// shapes are written out by hand, never derived by re-running the planner.
const img = (name: string, modality: string) => ({ name, modality });

describe('arrival planner (real arrivalPlan code)', () => {
  describe('planArrival', () => {
    it('Test 1: exact-basename sibling fills the free slot of the existing tuple', () => {
      const tuples = [{ name: 'img001', images: [img('img001.png', 'gt')] }];
      const plan = planArrival(tuples, ['gt', 'pred'], img('img001.png', 'pred'));
      expect(plan).toEqual({ kind: 'slot-fill', tupleIndex: 0, modalityIndex: 1 });
    });

    it('Test 2: exact basename re-groups into a de-duplicated "name (2)" tuple whose name is no substring', () => {
      const tuples = [
        { name: 'img001', images: [img('img001.png', 'gt'), img('img001.png', 'pred')] },
        { name: 'img001 (2)', images: [img('img001.png', 'gt')] },
      ];
      // Tie on match length; the free pred slot of "img001 (2)" must win over the taken one.
      const plan = planArrival(tuples, ['gt', 'pred'], img('img001.png', 'pred'));
      expect(plan).toEqual({ kind: 'slot-fill', tupleIndex: 1, modalityIndex: 1 });
    });

    it('Test 3: equal-score tie breaks toward the tuple with a free slot', () => {
      const tuples = [
        { name: 'runA', images: [img('frame.png', 'gt'), img('frame.png', 'pred')] },
        { name: 'runB', images: [img('frame.png', 'gt')] },
      ];
      const plan = planArrival(tuples, ['gt', 'pred'], img('frame.png', 'pred'));
      expect(plan).toEqual({ kind: 'slot-fill', tupleIndex: 1, modalityIndex: 1 });
    });

    it('Test 4: a taken slot means a new tuple, never a looser match', () => {
      const tuples = [{ name: 'img001', images: [img('img001.png', 'pred')] }];
      const plan = planArrival(tuples, ['gt', 'pred'], img('img001_x.png', 'pred'));
      expect(plan).toEqual({ kind: 'new-tuple', name: 'img001_x', insertIndex: 1, modalityIndex: 1 });
    });

    it('Test 5: name collisions get the scan-path " (2)" suffix', () => {
      const tuples = [{ name: 'img002', images: [img('img002.png', 'gt')] }];
      const plan = planArrival(tuples, ['gt'], img('img002.png', 'gt'));
      expect(plan).toEqual({ kind: 'new-tuple', name: 'img002 (2)', insertIndex: 1, modalityIndex: 0 });
    });

    it('Test 6: a new tuple is inserted at its natural-sort position among row names', () => {
      const tuples = [
        { name: 'img2', images: [img('img2.png', 'gt')] },
        { name: 'img10', images: [img('img10.png', 'gt')] },
      ];
      const plan = planArrival(tuples, ['gt'], img('img3.png', 'gt'));
      // Natural order: img2 < img3 < img10 — plain lexicographic would put img3 last.
      expect(plan).toEqual({ kind: 'new-tuple', name: 'img3', insertIndex: 1, modalityIndex: 0 });
    });

    it('Test 7: an unknown modality yields no plan', () => {
      expect(planArrival([], ['gt'], img('a.png', 'depth'))).toBeUndefined();
    });
  });

  describe('applyArrival', () => {
    it('Test 8: slot-fill pushes the image, re-sorts by modality order, and builds fileRestored with imageInfo', () => {
      const scan = {
        tuples: [{ name: 'img001', images: [img('img001.png', 'pred')] }],
        modalities: ['gt', 'pred'],
      };
      const winners = new Map<number, number>([[0, 1]]);
      const plan: ArrivalPlan = { kind: 'slot-fill', tupleIndex: 0, modalityIndex: 0 } as ArrivalPlan;
      const applied = applyArrival(scan, winners, 0, plan, img('img001.png', 'gt'));
      expect(scan.tuples[0].images.map(i => i.modality)).toEqual(['gt', 'pred']);
      expect(applied.currentTupleIndex).toBe(0);
      expect([...winners]).toEqual([[0, 1]]);
      expect(applied.message).toEqual({
        type: 'fileRestored',
        tupleIndex: 0,
        modalityIndex: 0,
        imageInfo: { name: 'img001.png', modality: 'gt', tupleIndex: 0, modalityIndex: 0 },
      });
    });

    it('Test 9: new-tuple splices at the insert index and shifts winners and the current index up', () => {
      const scan = {
        tuples: [
          { name: 'a', images: [img('a.png', 'gt')] },
          { name: 'c', images: [img('c.png', 'gt')] },
        ],
        modalities: ['gt'],
      };
      const winners = new Map<number, number>([[0, 0], [1, 0]]);
      const plan: ArrivalPlan = { kind: 'new-tuple', name: 'b', insertIndex: 1, modalityIndex: 0 } as ArrivalPlan;
      const applied = applyArrival(scan, winners, 1, plan, img('b.png', 'gt'));
      expect(scan.tuples.map(t => t.name)).toEqual(['a', 'b', 'c']);
      // The winner at row 1 ("c") moved to row 2; the view stays on "c" too.
      expect([...winners]).toEqual([[0, 0], [2, 0]]);
      expect(applied.currentTupleIndex).toBe(2);
      expect(applied.message.type).toBe('tupleAdded');
    });

    it('Test 10: the tupleAdded payload is dense over ALL modalities with empty-name placeholders', () => {
      const scan = {
        tuples: [{ name: 'img001', images: [img('img001.png', 'gt'), img('img001.png', 'pred')] }],
        modalities: ['gt', 'pred'],
      };
      const plan = planArrival(scan.tuples, scan.modalities, img('img001_crop01.png', 'gt'))!;
      const applied = applyArrival(scan, new Map(), 0, plan, img('img001_crop01.png', 'gt'));
      // The crop row lands right after its parent, and only its own modality is filled.
      expect(applied.message).toEqual({
        type: 'tupleAdded',
        tupleIndex: 1,
        tuple: {
          name: 'img001_crop01',
          images: [
            { name: 'img001_crop01.png', modality: 'gt', tupleIndex: 1, modalityIndex: 0 },
            { name: '', modality: 'pred', tupleIndex: 1, modalityIndex: 1 },
          ],
        },
      });
    });

    it('Test 11: the post-crop sequence — first file tupleAdded, second file fileRestored into the crop tuple', () => {
      const scan = {
        tuples: [{ name: 'img001', images: [img('img001.png', 'gt'), img('img001.png', 'pred')] }],
        modalities: ['gt', 'pred'],
      };
      const first = planArrival(scan.tuples, scan.modalities, img('img001_crop01.png', 'gt'))!;
      expect(first.kind).toBe('new-tuple');
      applyArrival(scan, new Map(), 0, first, img('img001_crop01.png', 'gt'));
      const second = planArrival(scan.tuples, scan.modalities, img('img001_crop01.png', 'pred'))!;
      expect(second).toEqual({ kind: 'slot-fill', tupleIndex: 1, modalityIndex: 1 });
    });
  });
});
