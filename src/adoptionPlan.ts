// Pure modality-adoption decisions (no vscode): which dirs qualify as new modality columns and the column-insert mutations/payload, for the provider's three detectors and the standalone poll alike (docs/standalone.md: adapter-contains-no-logic).
import { ExtensionMessage, MODALITY_COLORS, isImageFile, asOriginal } from './types';
import { modalityInsertIndex } from './watcherLogic';

/** Base-dir children that qualify for adoption: directories only, never dot dirs, never an existing column (docs/file-watching.md: new-modality-dir-adopted). */
export function newModalityDirCandidates(
  entries: ReadonlyArray<{ name: string; isDirectory: boolean }>,
  modalities: readonly string[]
): string[] {
  return entries
    .filter(e => e.isDirectory && !e.name.startsWith('.') && !modalities.includes(e.name))
    .map(e => e.name);
}

/** A candidate listing's image files; empty means the dir is barren and must not become a column (docs/file-watching.md: new-modality-dir-adopted). */
export function adoptableImages(entries: ReadonlyArray<{ name: string; isFile: boolean }>): string[] {
  return entries.filter(e => e.isFile && isImageFile(e.name)).map(e => e.name);
}

/** The minimal scan shape the insert mutates; products pass their full scan objects. */
export interface ModalityInsertScan<TImage extends { modality: string }> {
  tuples: Array<{ images: TImage[] }>;
  modalities: string[];
}

export interface ModalityInsertIo {
  /** The pill-tooltip path for the new column (docs/session-files.md: modality-path-always-real). */
  modalityPath(name: string): string;
  /** Per-column color override (e.g. session-file colors); a falsy return falls back to the positional palette. */
  colorOverride?(modality: string, index: number): string | undefined;
}

/**
 * Execute the shared column-insert mutations — splice at `modalityInsertIndex`, winner up-shift,
 * per-tuple image re-sort — and build the `modalityAdded` wire message. Product-only index-keyed
 * caches re-key off `insertIndex` at the call site (docs/file-watching.md: reindex-in-lockstep).
 */
export function applyModalityInsert<TImage extends { modality: string }>(
  scan: ModalityInsertScan<TImage>,
  winners: Map<number, number>,
  modalityName: string,
  callerOrder: readonly string[] | undefined,
  io: ModalityInsertIo
): { insertIndex: number; message: Extract<ExtensionMessage, { type: 'modalityAdded' }> } {
  const insertIndex = modalityInsertIndex(scan.modalities, modalityName, callerOrder);
  scan.modalities.splice(insertIndex, 0, modalityName);

  // Insertion shifts winner columns up in lockstep with the splice (docs/file-watching.md: reindex-in-lockstep).
  const entries = [...winners];
  winners.clear();
  for (const [t, m] of entries) {
    winners.set(t, m >= insertIndex ? m + 1 : m);
  }

  // Re-sort each tuple's sparse images into the new modality order.
  for (const tuple of scan.tuples) {
    tuple.images.sort((a, b) => scan.modalities.indexOf(a.modality) - scan.modalities.indexOf(b.modality));
  }

  return {
    insertIndex,
    message: {
      type: 'modalityAdded',
      modality: modalityName,
      modalityPath: io.modalityPath(modalityName),
      // Original-order colors over the post-insert set; the webview permutes them into display order.
      modalityColors: scan.modalities.map((mod, i) => io.colorOverride?.(mod, i) || MODALITY_COLORS[i % MODALITY_COLORS.length]),
      // Wire index in global/original space (docs/file-watching.md: modality-index-is-global).
      modalityIndex: asOriginal(insertIndex),
    },
  };
}
