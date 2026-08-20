// Pure arrival planning (no vscode): where a newly arrived file lands — slot-fill vs new tuple — is decided only here, for the provider's watcher arrivals and the standalone's crop writes alike (docs/standalone.md: adapter-contains-no-logic).
import { ExtensionMessage, ImageInfo, OriginalModalityIndex, TupleIndex, asOriginal, asTuple } from './types';
import { tupleInsertIndex } from './watcherLogic';
import { denseTupleInfo } from './initPayload';

/** The minimal file shape the planner scores; products pass their full image objects. */
export interface ArrivedFile {
  name: string;
  modality: string;
}

export interface ArrivalScan<TImage extends ArrivedFile> {
  tuples: Array<{ name: string; images: TImage[] }>;
  modalities: readonly string[];
}

export type ArrivalPlan =
  | { kind: 'slot-fill'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex }
  | { kind: 'new-tuple'; name: string; insertIndex: TupleIndex; modalityIndex: OriginalModalityIndex };

/** Decide where an arrived file goes: an existing tuple's free slot, or a new tuple at its sorted position (docs/file-watching.md). */
export function planArrival(
  tuples: ReadonlyArray<{ name: string; images: ReadonlyArray<ArrivedFile> }>,
  modalities: readonly string[],
  file: ArrivedFile
): ArrivalPlan | undefined {
  const modalityIndex = modalities.indexOf(file.modality);
  if (modalityIndex < 0) return undefined;

  const baseFilename = file.name.replace(/\.[^.]+$/, '');

  // Longest-match-wins, ties toward a free slot; not the trie matcher (docs/file-watching.md).
  let matchingTupleIndex = -1;
  let bestMatchLen = -1;
  let bestSlotFree = false;

  for (let i = 0; i < tuples.length; i++) {
    const tuple = tuples[i];
    let matchLen = -1;

    if (tuple.name && baseFilename.includes(tuple.name)) {
      matchLen = tuple.name.length;
    }

    // An exact basename match scores the maximum possible length.
    for (const img of tuple.images) {
      if (img.name.replace(/\.[^.]+$/, '') === baseFilename) {
        matchLen = baseFilename.length;
        break;
      }
    }

    if (matchLen < 0) continue;

    const slotFree = !tuple.images.find(img => img.modality === file.modality);

    if (matchLen > bestMatchLen) {
      matchingTupleIndex = i;
      bestMatchLen = matchLen;
      bestSlotFree = slotFree;
    } else if (matchLen === bestMatchLen && slotFree && !bestSlotFree) {
      matchingTupleIndex = i;
      bestSlotFree = slotFree;
    }
  }

  // A taken slot means a new tuple, never a looser match (docs/tuple-matching.md: one-file-per-modality).
  if (!bestSlotFree) {
    matchingTupleIndex = -1;
  }

  if (matchingTupleIndex >= 0) {
    return { kind: 'slot-fill', tupleIndex: asTuple(matchingTupleIndex), modalityIndex: asOriginal(modalityIndex) };
  }

  // Suffix collisions ` (2)`, `(3)`… like the scan path, or one results line votes for every same-named tuple (docs/session-files.md: durable-vote-key).
  const existingNames = new Set(tuples.map(t => t.name));
  let uniqueName = baseFilename;
  for (let n = 2; existingNames.has(uniqueName); n++) {
    uniqueName = `${baseFilename} (${n})`;
  }

  // Sorted insertion, not current+1: the create can arrive a whole sweep after the user navigated away (docs/file-watching.md: rows-insert-in-order).
  const insertIndex = tupleInsertIndex(tuples.map(t => t.name), uniqueName);
  return { kind: 'new-tuple', name: uniqueName, insertIndex: asTuple(insertIndex), modalityIndex: asOriginal(modalityIndex) };
}

/** Execute a plan's shared mutations and build its wire message; product-only caches re-key off the plan at the call site. */
export function applyArrival<TImage extends ArrivedFile>(
  scan: ArrivalScan<TImage>,
  winners: Map<number, number>,
  currentTupleIndex: number,
  plan: ArrivalPlan,
  image: TImage
): { currentTupleIndex: number; message: Extract<ExtensionMessage, { type: 'fileRestored' | 'tupleAdded' }> } {
  if (plan.kind === 'slot-fill') {
    const tuple = scan.tuples[plan.tupleIndex];
    tuple.images.push(image);
    tuple.images.sort((a, b) => scan.modalities.indexOf(a.modality) - scan.modalities.indexOf(b.modality));
    const imageInfo: ImageInfo = { name: image.name, modality: image.modality, tupleIndex: plan.tupleIndex, modalityIndex: plan.modalityIndex };
    // imageInfo fills a slot the webview did not know about; after a crop, each of these follows the first file's tupleAdded (docs/crop-and-pptx.md: post-crop-message-order).
    return { currentTupleIndex, message: { type: 'fileRestored', tupleIndex: plan.tupleIndex, modalityIndex: plan.modalityIndex, imageInfo } };
  }

  const newTuple = { name: plan.name, images: [image] };
  scan.tuples.splice(plan.insertIndex, 0, newTuple);
  // Insertion shifts winner keys up in lockstep with the splice (docs/file-watching.md: reindex-in-lockstep).
  const entries = [...winners];
  winners.clear();
  for (const [t, m] of entries) {
    winners.set(t >= plan.insertIndex ? t + 1 : t, m);
  }
  // The >= guard shifts the current index with the splice (docs/file-watching.md: mutation-never-strands-view).
  const shiftedCurrent = currentTupleIndex >= plan.insertIndex ? currentTupleIndex + 1 : currentTupleIndex;
  // A *sparse* tupleAdded — dense over ALL modalities, only this file's slot filled — opens the post-crop canon sequence (docs/crop-and-pptx.md: post-crop-message-order).
  return {
    currentTupleIndex: shiftedCurrent,
    message: { type: 'tupleAdded', tuple: denseTupleInfo(newTuple, plan.insertIndex, scan.modalities), tupleIndex: plan.insertIndex },
  };
}
