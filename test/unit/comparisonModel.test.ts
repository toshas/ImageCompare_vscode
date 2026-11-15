import { describe, it, expect } from 'vitest';
import {
  ComparisonModel,
  TupleInfo,
  asOriginal,
  asTuple,
  hiddenByDisplay,
  hiddenToggled,
  modalityAdded,
  modalityAt,
  modalityMoved,
  modalityRemoved,
  modelFromInit,
  reorderImagesForDisplay,
  tupleAdded,
  tupleRemoved,
  winnerAt,
  winnerSet,
  winnersReset,
} from '../../src/webview/comparisonModel';

// Every expected value is worked out by hand from docs/tuple-matching.md ("The webview's comparison
// model"), never recomputed from the module. The fixture's order is PERMUTED on purpose: the bug class
// is an operation that is correct only for the identity order.

const NAMES = ['A', 'B', 'C', 'D'];

function tuple(name: string, t: number, names = NAMES): TupleInfo {
  return { name, images: names.map((m, o) => ({ name: `${name}_${m}.png`, modality: m, tupleIndex: asTuple(t), modalityIndex: asOriginal(o) })) };
}

/** Columns A B C D (original 0-3) shown as C A D B; votes t0 -> D, t2 -> B, t1 -> A in that entry order; D then A hidden. */
function base(): ComparisonModel {
  return {
    tuples: [tuple('t0', 0), tuple('t1', 1), tuple('t2', 2)],
    modalities: NAMES.map(n => ({ name: n, path: `/p/${n}`, color: `c${n}` })),
    order: [2, 0, 3, 1].map(asOriginal),
    winners: new Map([[asTuple(0), asOriginal(3)], [asTuple(2), asOriginal(1)], [asTuple(1), asOriginal(0)]]),
    hidden: new Set([asOriginal(3), asOriginal(0)]),
  };
}

const names = (m: ComparisonModel) => m.order.map(o => m.modalities[o].name);
const winners = (m: ComparisonModel) => [...m.winners];
const displays = (remap: (d: never) => number | null, n: number) => Array.from({ length: n }, (_, d) => remap(d as never));

describe('comparison model (comparisonModel.ts, real code)', () => {
  describe('init', () => {
    it('keeps the wire order, the tuples object and the votes; nothing hidden', () => {
      const tuples = [tuple('t0', 0, ['A', 'B'])];
      const m = modelFromInit({ tuples, modalities: ['A', 'B'], modalityPaths: ['/a', '/b'], modalityColors: ['#111', '#222'], winners: { 0: asOriginal(1) } });
      expect(m.tuples).toBe(tuples);
      expect(m.modalities).toEqual([{ name: 'A', path: '/a', color: '#111' }, { name: 'B', path: '/b', color: '#222' }]);
      expect(m.order).toEqual([0, 1]);
      expect(winners(m)).toEqual([[0, 1]]);
      expect([...m.hidden]).toEqual([]);
    });

    it('falls back to the positional palette when the host sends no colours, or not one per modality', () => {
      const msg = { tuples: [], modalities: 'ABCDEFGHI'.split(''), modalityPaths: [] as string[] };
      const palette = ['#0f0', '#f60', '#0af', '#f0f', '#ff0', '#f44', '#4f4', '#44f', '#0f0'];
      expect(modelFromInit(msg).modalities.map(r => r.color)).toEqual(palette);
      expect(modelFromInit({ ...msg, modalityColors: ['#123'] }).modalities.map(r => r.color)).toEqual(palette);
    });
  });

  describe('derived display views', () => {
    it('read every per-modality value through the order', () => {
      const m = base();
      expect(names(m)).toEqual(['C', 'A', 'D', 'B']);
      expect(modalityAt(m, 2)).toEqual({ name: 'D', path: '/p/D', color: 'cD' });
      expect(modalityAt(m, 4)).toBeUndefined();
      expect(hiddenByDisplay(m)).toEqual([false, true, true, false]);
      expect([0, 1, 2].map(t => winnerAt(m, asTuple(t)))).toEqual([2, 1, 3]);
      expect(reorderImagesForDisplay(['a', 'b', 'c', 'd'], m.order)).toEqual(['c', 'a', 'd', 'b']);
      expect(reorderImagesForDisplay(['a', 'b'], m.order)).toEqual([undefined, 'a', undefined, 'b']);
    });
  });

  describe('tuple added', () => {
    it('shifts every row at or after the insert, the votes with them, and leaves the columns alone', () => {
      const m = base();
      const before = structuredClone(m);
      const { model, remap } = tupleAdded(m, asTuple(1), tuple('new', 1));
      expect(model.tuples.map(t => t.name)).toEqual(['t0', 'new', 't1', 't2']);
      expect(model.tuples[0]).toBe(m.tuples[0]);
      expect(winners(model)).toEqual([[0, 3], [3, 1], [2, 0]]);
      expect([0, 1, 2].map(t => remap.tuple(asTuple(t)))).toEqual([0, 2, 3]);
      expect(names(model)).toEqual(['C', 'A', 'D', 'B']);
      expect([...model.hidden]).toEqual([3, 0]);
      expect(displays(remap.display, 4)).toEqual([0, 1, 2, 3]);
      expect(m).toEqual(before);
    });
  });

  describe('tuple removed', () => {
    it('drops the row and its vote, and moves every later row up one', () => {
      const m = base();
      const before = structuredClone(m);
      const { model, remap } = tupleRemoved(m, asTuple(1));
      expect(model.tuples.map(t => t.name)).toEqual(['t0', 't2']);
      expect(winners(model)).toEqual([[0, 3], [1, 1]]);
      expect([0, 1, 2].map(t => remap.tuple(asTuple(t)))).toEqual([0, null, 1]);
      expect([0, 1, 2, 3].map(o => remap.modality(asOriginal(o)))).toEqual([0, 1, 2, 3]);
      expect(m).toEqual(before);
    });
  });

  describe('modality added', () => {
    // E arrives at original index 1 (between A and B). Shown C A D B, it lands beside its predecessor A: C A E D B.
    const added = (m: ComparisonModel) => modalityAdded(m, {
      modality: 'E', modalityPath: '/p/E', modalityColors: ['k0', 'k1', 'k2', 'k3', 'k4'], modalityIndex: asOriginal(1),
    });

    it('keeps the arrangement: the new column lands beside its original-order predecessor', () => {
      const { model } = added(base());
      expect(model.order).toEqual([3, 0, 1, 4, 2]);
      expect(names(model)).toEqual(['C', 'A', 'E', 'D', 'B']);
      expect(model.modalities.map(r => [r.name, r.path, r.color])).toEqual([
        ['A', '/p/A', 'k0'], ['E', '/p/E', 'k1'], ['B', '/p/B', 'k2'], ['C', '/p/C', 'k3'], ['D', '/p/D', 'k4'],
      ]);
    });

    it('shifts display indices only at and after the insertion point, and originals at and after the wire index', () => {
      const m = base();
      const before = structuredClone(m);
      const { model, remap } = added(m);
      // C A D B -> C A E D B: D (2) moves to 3, B (3) to 4.
      expect(displays(remap.display, 4)).toEqual([0, 1, 3, 4]);
      expect([0, 1, 2, 3].map(o => remap.modality(asOriginal(o)))).toEqual([0, 2, 3, 4]);
      expect(winners(model)).toEqual([[0, 4], [2, 2], [1, 0]]);
      expect([0, 1, 2].map(t => winnerAt(model, asTuple(t)))).toEqual([3, 1, 4]);
      expect([...model.hidden]).toEqual([4, 0]);
      expect(m).toEqual(before);
    });

    it('splices a placeholder into every tuple and re-numbers the slots after it, in copies', () => {
      const m = base();
      const { model } = added(m);
      expect(model.tuples[2].images.map(i => [i.name, i.modality, i.tupleIndex, i.modalityIndex])).toEqual([
        ['t2_A.png', 'A', 2, 0], ['', 'E', 2, 1], ['t2_B.png', 'B', 2, 2], ['t2_C.png', 'C', 2, 3], ['t2_D.png', 'D', 2, 4],
      ]);
      expect(m.tuples[2].images.map(i => i.modalityIndex)).toEqual([0, 1, 2, 3]);
    });
  });

  describe('modality removed', () => {
    // A (original 0) goes while shown C A D B; the arrangement is kept: C D B, renumbered B=0 C=1 D=2.
    it('keeps the arrangement: the order loses the removed column and each display index follows its column', () => {
      const m = base();
      const before = structuredClone(m);
      const { model, remap } = modalityRemoved(m, asOriginal(0));
      expect(model.order).toEqual([1, 2, 0]);
      expect(names(model)).toEqual(['C', 'D', 'B']);
      // C stays at display 0, A is gone, D (display 2) is now 1, B (display 3) is now 2.
      expect(displays(remap.display, 5)).toEqual([0, null, 1, 2, null]);
      expect([0, 1, 2, 3].map(o => remap.modality(asOriginal(o)))).toEqual([null, 0, 1, 2]);
      expect(m).toEqual(before);
    });

    it('drops the column from votes, hidden and every tuple, re-numbering what is left', () => {
      const { model } = modalityRemoved(base(), asOriginal(0));
      expect(winners(model)).toEqual([[0, 2], [2, 0]]);
      expect([...model.hidden]).toEqual([2]);
      expect(model.modalities.map(r => r.path)).toEqual(['/p/B', '/p/C', '/p/D']);
      expect(model.tuples[1].images.map(i => [i.modality, i.modalityIndex])).toEqual([['B', 0], ['C', 1], ['D', 2]]);
    });
  });

  describe('modality moved', () => {
    // C A D B, display 0 -> 2: A D C B.
    it('changes only the order; votes and hidden stay original-indexed and so follow their columns', () => {
      const m = base();
      const before = structuredClone(m);
      const { model, remap } = modalityMoved(m, 0, 2)!;
      expect(model.order).toEqual([0, 3, 2, 1]);
      expect(names(model)).toEqual(['A', 'D', 'C', 'B']);
      expect(winners(model)).toEqual([[0, 3], [2, 1], [1, 0]]);
      expect([0, 1, 2].map(t => winnerAt(model, asTuple(t)))).toEqual([1, 0, 3]);
      expect(hiddenByDisplay(model)).toEqual([true, true, false, false]);
      expect([0, 1, 2, 3].map(o => remap.modality(asOriginal(o)))).toEqual([0, 1, 2, 3]);
      expect(m).toEqual(before);
    });

    it('moves the selection with its column: the moved one lands at to, the ones between close up', () => {
      const { remap } = modalityMoved(base(), 0, 2)!;
      expect(displays(remap.display, 4)).toEqual([2, 0, 1, 3]);
      const back = modalityMoved(base(), 3, 1)!;
      // C A D B, 3 -> 1: C B A D.
      expect(names(back.model)).toEqual(['C', 'B', 'A', 'D']);
      expect(displays(back.remap.display, 4)).toEqual([0, 2, 3, 1]);
    });

    it('refuses a move off either end or onto itself', () => {
      expect(modalityMoved(base(), 0, -1)).toBeNull();
      expect(modalityMoved(base(), 3, 4)).toBeNull();
      expect(modalityMoved(base(), 2, 2)).toBeNull();
    });
  });

  describe('winners and hidden', () => {
    it('a set keeps the entry position, a clear drops it, and an index the order lacks changes nothing', () => {
      const m = base();
      const before = structuredClone(m);
      expect(winners(winnerSet(m, asTuple(0), asOriginal(2)))).toEqual([[0, 2], [2, 1], [1, 0]]);
      expect(winners(winnerSet(m, asTuple(2), null))).toEqual([[0, 3], [1, 0]]);
      expect(winners(winnerSet(m, asTuple(3), asOriginal(1)))).toEqual([[0, 3], [2, 1], [1, 0], [3, 1]]);
      expect(winnerSet(m, asTuple(0), asOriginal(7))).toBe(m);
      expect(m).toEqual(before);
    });

    it('a reset replaces every vote from the wire record, dropping indices the order lacks', () => {
      const m = base();
      const reset = winnersReset(m, { 1: asOriginal(3), 2: asOriginal(9), 0: asOriginal(2) });
      expect(winners(reset)).toEqual([[0, 2], [1, 3]]);
      expect([0, 1].map(t => winnerAt(reset, asTuple(t)))).toEqual([0, 2]);
      expect(winners(m)).toEqual([[0, 3], [2, 1], [1, 0]]);
    });

    it('a toggle shows a hidden column or hides a visible one, keeping insertion order', () => {
      const m = base();
      expect([...hiddenToggled(m, asOriginal(3)).hidden]).toEqual([0]);
      expect([...hiddenToggled(m, asOriginal(1)).hidden]).toEqual([3, 0, 1]);
      expect([...m.hidden]).toEqual([3, 0]);
    });
  });
});
