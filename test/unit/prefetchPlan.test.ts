import { describe, expect, it } from 'vitest';
import { prefetchColumns, prefetchTuples, prefetchWavePlan } from '../../src/prefetchPlan';

// The speculation policy, on the real module the provider imports.
// The field pathology it replaces (docs/loading-architecture.md, "Prefetch"): every wave loaded
// `center ± prefetchCount` x *all* modalities at full resolution. Measured on a 10-modality grid at
// prefetchCount 3 that is 69 slots / 164.5MB per wave and 13.3s of a 5-slot pool, of which a
// five-tuple browsing trace displayed 10MB — 4%. The order mattered as much as the volume: the
// visible column of the +1 tuple sat behind the centre tuple's other nine columns, so the first step
// to a neighbour was a cache MISS (1022ms measured, against a 741ms idle cold load) — prefetch was
// slower than no prefetch at the one thing it exists for.
// (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column, prefetch-visible-column-first)

const WIDE = Array.from({ length: 10 }, (_, i) => i);
const scope = (over: Partial<Parameters<typeof prefetchColumns>[0]> = {}) => ({
  modalityOrder: WIDE,
  currentDisplayIndex: 3,
  isHidden: () => false,
  ...over
});

describe('prefetch columns: the one on screen plus the nearest siblings', () => {
  it('leads with the on-screen column, then the nearest sibling either side, forward first', () => {
    expect(prefetchColumns(scope())).toEqual([3, 4, 2]);
  });

  it('never widens past three columns, however wide the tuple', () => {
    // Ten modalities used to mean ten columns per neighbour; that is the whole bug.
    expect(prefetchColumns(scope({ currentDisplayIndex: 5 }))).toHaveLength(3);
    expect(prefetchColumns(scope({ modalityOrder: Array.from({ length: 40 }, (_, i) => i), currentDisplayIndex: 20 }))).toHaveLength(3);
  });

  it('measures distance over the display order, not raw modality ids', () => {
    // On screen the strip reads [1,2,3,4,5,6,0,9,7,8]; from display 7 the neighbours are 0 and 7.
    const order = [1, 2, 3, 4, 5, 6, 0, 9, 7, 8];
    expect(prefetchColumns(scope({ modalityOrder: order, currentDisplayIndex: 7 }))).toEqual([9, 7, 0]);
  });

  it('never speculates on a hidden column — no key can reach one', () => {
    expect(prefetchColumns(scope({ isHidden: o => o === 4 }))).toEqual([3, 5, 2]);
    expect(prefetchColumns(scope({ isHidden: o => o === 4 || o === 2 }))).toEqual([3, 5, 1]);
  });

  it('still leads with a hidden current column (a click or digit jump lands on one)', () => {
    expect(prefetchColumns(scope({ isHidden: o => o === 3 }))).toEqual([3, 4, 2]);
  });

  it('is one column for a single-modality session, and empty when the strip is empty', () => {
    expect(prefetchColumns(scope({ modalityOrder: [7], currentDisplayIndex: 0 }))).toEqual([7]);
    expect(prefetchColumns(scope({ modalityOrder: [], currentDisplayIndex: 0 }))).toEqual([]);
  });
});

describe('prefetch tuples: the band prefetchCount names, centre-out', () => {
  it('walks outward in pairs, forward before backward', () => {
    expect(prefetchTuples(10, 100, 3)).toEqual([10, 11, 9, 12, 8, 13, 7]);
  });

  it('clamps at both ends of the session without shifting the band', () => {
    expect(prefetchTuples(1, 4, 3)).toEqual([1, 2, 0, 3]);
    expect(prefetchTuples(0, 1, 3)).toEqual([0]);
  });

  it('is the centre alone at prefetchCount 0 — the setting still means tuples', () => {
    expect(prefetchTuples(10, 100, 0)).toEqual([10]);
  });
});

describe('prefetch wave: column-major, so the next step is already cached', () => {
  const plan = (over: Partial<Parameters<typeof prefetchWavePlan>[0]> = {}) => prefetchWavePlan({
    centerIndex: 2,
    tupleCount: 5,
    prefetchCount: 1,
    scope: scope(),
    isCached: () => false,
    ...over
  });

  it('issues every neighbour\'s on-screen column before any sibling column', () => {
    // The whole point: (+1, on-screen) is slot 2 of the wave, not slot 14.
    expect(plan().map(s => `${s.tupleIndex}-${s.modalityIndex}`)).toEqual([
      '2-3', '3-3', '1-3',
      '2-4', '3-4', '1-4',
      '2-2', '3-2', '1-2'
    ]);
  });

  it('is three columns per tuple at the field shape, not ten', () => {
    // 7 tuples x 3 columns. All ten columns would be 70 slots and, measured, 175MB.
    const wave = plan({ centerIndex: 30, tupleCount: 60, prefetchCount: 3 });
    expect(wave).toHaveLength(21);
    expect(new Set(wave.map(s => s.modalityIndex))).toEqual(new Set([2, 3, 4]));
  });

  it('omits slots the extension already holds, without disturbing the order of the rest', () => {
    const wave = plan({ isCached: (t, m) => m === 3 && t !== 1 });
    expect(wave.map(s => `${s.tupleIndex}-${s.modalityIndex}`)).toEqual([
      '1-3', '2-4', '3-4', '1-4', '2-2', '3-2', '1-2'
    ]);
  });

  it('speculates on nothing when every column is hidden and the strip is empty', () => {
    expect(plan({ scope: scope({ modalityOrder: [], currentDisplayIndex: 0 }) })).toEqual([]);
  });
});
