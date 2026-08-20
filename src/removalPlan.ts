// Pure removal sequencing (no vscode): the tuple-delete wire order — tupleDeleted, refresh, then modalityRemoved per emptied column, re-saving after every step — lives only here; both products execute it through injected IO (docs/file-watching.md: delete-message-order).
import { ExtensionMessage, OriginalModalityIndex, TupleIndex, asOriginal, asTuple } from './types';
import { shiftIndexAfterRemoval } from './watcherLogic';

export interface RemovalScan<TImage extends { modality: string }> {
  tuples: Array<{ name: string; images: TImage[] }>;
  modalities: string[];
}

export type RemovalStep =
  | { kind: 'tuple'; tupleIndex: TupleIndex }
  | { kind: 'modality'; modality: string; modalityIndex: OriginalModalityIndex };

export interface TupleRemovalIo {
  post(message: ExtensionMessage): void;
  /** Commits the shifted current index, then re-sends that tuple's images (docs/file-watching.md: mutation-never-strands-view). */
  refreshCurrentTuple(currentTupleIndex: number): void;
  saveResults(): void;
  /** Product-only index-keyed caches re-key here, inside the same operation as the splice (docs/file-watching.md: reindex-in-lockstep). */
  onTupleRemoved?(tupleIndex: number): void;
}

export interface ModalityRemovalIo {
  post(message: ExtensionMessage): void;
  saveResults(): void;
  /** Product-only cleanup (watcher release, cache clear) in the same operation as the splice (docs/file-watching.md: reindex-in-lockstep). */
  onModalityRemoved?(modality: string, modalityIndex: number): void;
}

export interface TupleDeleteIo<TImage> {
  /** Best-effort per-file disk delete; one already-gone file must not abort the rest. */
  deleteFile(image: TImage): Promise<void>;
  /** Execute the shared tuple step (removeTupleStep) with the product's io; product gates and the live current index stay inside. */
  removeTuple(tupleIndex: TupleIndex): void;
  /** Execute the shared modality step (removeModalityStep) with the product's io. */
  removeModality(modalityIndex: OriginalModalityIndex): void;
}

/** The whole delete-tuple flow: every file deleted first, then the removal plan — computed from the tuple's live index, since the deletion awaits may shift rows — executed step by step in order (docs/file-watching.md: delete-message-order). */
export async function deleteTupleFlow<TImage extends { modality: string }>(
  scan: RemovalScan<TImage>,
  tupleIndex: number,
  io: TupleDeleteIo<TImage>
): Promise<void> {
  const tuple = scan.tuples[tupleIndex];
  if (!tuple) return;

  for (const img of tuple.images) {
    try {
      await io.deleteFile(img);
    } catch {
      // File may already be gone
    }
  }

  const liveIndex = scan.tuples.indexOf(tuple);
  if (liveIndex < 0) return;
  for (const step of planTupleRemoval(scan.tuples, scan.modalities, liveIndex)) {
    if (step.kind === 'tuple') io.removeTuple(step.tupleIndex);
    else io.removeModality(step.modalityIndex);
  }
}

export interface SlotRemovalIo {
  post(message: ExtensionMessage): void;
  saveResults(): void;
  /** Execute the shared tuple step (removeTupleStep) with the product's io when the removal empties its tuple. */
  removeTuple(tupleIndex: TupleIndex): void;
  /** Execute the shared modality step (removeModalityStep) with the product's io when the removal empties its column. */
  removeModality(modalityIndex: OriginalModalityIndex): void;
  /** Product-only cache eviction for the removed slot, before winner/wire steps run (docs/file-watching.md: reindex-in-lockstep). */
  onSlotRemoved?(tupleIndex: number, modalityIndex: number): void;
}

/**
 * Commit one slot's file removal: strip the image, clear its winner, then the tuple-empty vs
 * `fileDeleted` branch and the column-empty follow-up, in the provider's rename-window commit
 * order — shared with the standalone poll (docs/file-watching.md: delete-message-order).
 */
export function commitSlotRemoval<TImage extends { modality: string }>(
  scan: RemovalScan<TImage>,
  winners: Map<number, number>,
  tupleIndex: number,
  modalityIndex: number,
  io: SlotRemovalIo
): void {
  const tuple = scan.tuples[tupleIndex];
  const modality = scan.modalities[modalityIndex];
  if (!tuple || !modality) return;
  tuple.images = tuple.images.filter(img => img.modality !== modality);
  io.onSlotRemoved?.(tupleIndex, modalityIndex);
  if (winners.get(tupleIndex) === modalityIndex) {
    winners.delete(tupleIndex);
    io.post({ type: 'winnerUpdated', tupleIndex: asTuple(tupleIndex), modalityIndex: null });
  }
  if (tuple.images.length === 0) {
    io.removeTuple(asTuple(tupleIndex));
  } else {
    io.post({ type: 'fileDeleted', tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex) });
    io.saveResults();
  }
  // Same end state a modality-directory delete reaches, but from below — the column drops with its last file.
  const stillIndex = scan.modalities.indexOf(modality);
  if (stillIndex >= 0 && !modalityHasFiles(scan.tuples, modality)) {
    io.removeModality(asOriginal(stillIndex));
  }
}

/** True when any tuple still holds a file of `modality`; its last file leaving is what drops the column. */
export function modalityHasFiles(tuples: ReadonlyArray<{ images: ReadonlyArray<{ modality: string }> }>, modality: string): boolean {
  return tuples.some(tuple => tuple.images.some(img => img.modality === modality));
}

/** Ordered steps for deleting a tuple: the tuple first, then each modality it emptied — indices pre-shifted for the earlier splices (docs/file-watching.md: delete-message-order). */
export function planTupleRemoval(
  tuples: ReadonlyArray<{ name: string; images: ReadonlyArray<{ modality: string }> }>,
  modalities: readonly string[],
  tupleIndex: number
): RemovalStep[] {
  const steps: RemovalStep[] = [{ kind: 'tuple', tupleIndex: asTuple(tupleIndex) }];
  const remaining = tuples.filter((_, i) => i !== tupleIndex);
  const working = [...modalities];
  for (const { modality } of tuples[tupleIndex].images) {
    if (modalityHasFiles(remaining, modality)) continue;
    const idx = working.indexOf(modality);
    if (idx < 0) continue;
    working.splice(idx, 1);
    steps.push({ kind: 'modality', modality, modalityIndex: asOriginal(idx) });
  }
  return steps;
}

/** Remove one tuple: splice + winner-key shift, then post tupleDeleted, refresh the (shifted, clamped) current tuple, re-save (docs/file-watching.md: delete-message-order). */
export function removeTupleStep<TImage extends { modality: string }>(
  scan: RemovalScan<TImage>,
  winners: Map<number, number>,
  currentTupleIndex: number,
  tupleIndex: number,
  io: TupleRemovalIo
): void {
  scan.tuples.splice(tupleIndex, 1);
  const entries = [...winners];
  winners.clear();
  for (const [t, m] of entries) {
    const shifted = shiftIndexAfterRemoval(t, tupleIndex);
    if (shifted !== null) winners.set(shifted, m);
  }
  io.onTupleRemoved?.(tupleIndex);
  let current = currentTupleIndex;
  if (current >= scan.tuples.length) {
    current = Math.max(0, scan.tuples.length - 1);
  } else if (current > tupleIndex) {
    current--;
  }
  io.post({ type: 'tupleDeleted', tupleIndex: asTuple(tupleIndex) });
  io.refreshCurrentTuple(current);
  io.saveResults();
}

/** Remove one modality column: splice + strip + winner-value shift, then post modalityRemoved and re-save (docs/file-watching.md: delete-message-order). */
export function removeModalityStep<TImage extends { modality: string }>(
  scan: RemovalScan<TImage>,
  winners: Map<number, number>,
  modalityIndex: number,
  io: ModalityRemovalIo
): void {
  const modality = scan.modalities[modalityIndex];
  scan.modalities.splice(modalityIndex, 1);
  for (const tuple of scan.tuples) {
    tuple.images = tuple.images.filter(img => img.modality !== modality);
  }
  const entries = [...winners];
  winners.clear();
  for (const [t, m] of entries) {
    const shifted = shiftIndexAfterRemoval(m, modalityIndex);
    if (shifted !== null) winners.set(t, shifted);
  }
  io.onModalityRemoved?.(modality, modalityIndex);
  io.post({ type: 'modalityRemoved', modalityIndex: asOriginal(modalityIndex) });
  io.saveResults();
}
