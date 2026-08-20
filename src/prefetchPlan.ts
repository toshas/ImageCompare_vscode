/**
 * What a prefetch wave speculates on: which neighbour tuples, which modality columns of each, and
 * in what order. Pure (no vscode, no DOM) — the extension's counterpart to `tupleLoadPlan.ts`,
 * whose nearest-sibling rule it reuses rather than restates. See docs/loading-architecture.md,
 * "Prefetch".
 */
import { siblingLoadPlan } from './webview/tupleLoadPlan';

/** The webview's view of its own modality strip, as reported with `tupleFullyLoaded`. */
export interface PrefetchScope {
  /** Display position -> original modality index. */
  modalityOrder: readonly number[];
  currentDisplayIndex: number;
  isHidden: (originalIndex: number) => boolean;
}

export interface PrefetchWaveInput {
  centerIndex: number;
  tupleCount: number;
  prefetchCount: number;
  scope: PrefetchScope;
  /** The extension already holds this slot's bytes. */
  isCached: (tupleIndex: number, modalityIndex: number) => boolean;
}

/** One speculative slot, in the wire (original) modality space. */
export interface PrefetchSlot {
  tupleIndex: number;
  modalityIndex: number;
}

/** Columns a wave may touch: the one on screen plus the siblings the tuple-load policy calls nearest (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column). */
export function prefetchColumns(scope: PrefetchScope): number[] {
  const shown = scope.modalityOrder[scope.currentDisplayIndex];
  // Hidden pills and display distance are decided once, by the policy the current tuple already uses.
  const nearest = siblingLoadPlan({ ...scope, isCached: () => false })
    .filter(s => s.rank === 'sibling')
    .map(s => s.modalityIndex);
  return shown === undefined ? nearest : [shown, ...nearest];
}

/** Tuples a wave covers: the centre, then outward in pairs to `prefetchCount`, clamped to the session. */
export function prefetchTuples(centerIndex: number, tupleCount: number, prefetchCount: number): number[] {
  const tuples: number[] = [];
  for (let offset = 0; offset <= prefetchCount; offset++) {
    for (const t of offset === 0 ? [centerIndex] : [centerIndex + offset, centerIndex - offset]) {
      if (t >= 0 && t < tupleCount) tuples.push(t);
    }
  }
  return tuples;
}

/** The whole wave, column-major: every neighbour's on-screen column before any sibling column (docs/loading-architecture.md: prefetch-visible-column-first). */
export function prefetchWavePlan(input: PrefetchWaveInput): PrefetchSlot[] {
  const tuples = prefetchTuples(input.centerIndex, input.tupleCount, input.prefetchCount);
  const slots: PrefetchSlot[] = [];
  for (const modalityIndex of prefetchColumns(input.scope)) {
    for (const tupleIndex of tuples) {
      if (!input.isCached(tupleIndex, modalityIndex)) slots.push({ tupleIndex, modalityIndex });
    }
  }
  return slots;
}
