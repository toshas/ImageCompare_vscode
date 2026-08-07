/** Pure (vscode-free, unit-testable) helpers for the file-watching subsystem — see docs/file-watching.md. */

export interface DeletedEntry {
  dir: string;
  filename: string;
}

/**
 * Rename disambiguation: index into `deleted` that the new file renames from, or -1 unless the
 * match is unambiguous. Rules and rationale: docs/file-watching.md ("Claiming a pending delete").
 */
export function matchDeletedFile(
  deleted: DeletedEntry[],
  newDir: string,
  newFilename: string,
  isMultiTuple: boolean
): number {
  const sameDir = deleted
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.dir === newDir);
  if (sameDir.length === 1) return sameDir[0].i;
  if (sameDir.length > 1) return -1;

  if (isMultiTuple) {
    const parentOf = (p: string) => p.substring(0, p.lastIndexOf('/'));
    const newParent = parentOf(newDir);
    const siblings = deleted
      .map((d, i) => ({ d, i }))
      .filter((x) => parentOf(x.d.dir) === newParent && x.d.filename === newFilename);
    if (siblings.length === 1) return siblings[0].i;
  }

  return -1;
}

/** New index after `removed` is spliced out: null if it was that element, else shifted down when after it. */
export function shiftIndexAfterRemoval(index: number, removed: number): number | null {
  if (index === removed) return null;
  return index > removed ? index - 1 : index;
}

/** The one natural-order comparator: scan-time row sort and watcher-time row insertion must agree (docs/file-watching.md: rows-insert-in-order). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Insert position keeping rows natural-sorted by name: a crop lands right after its parent wherever the user is (docs/file-watching.md: rows-insert-in-order). */
export function tupleInsertIndex(existingNames: readonly string[], name: string): number {
  for (let i = 0; i < existingNames.length; i++) {
    if (naturalCompare(name, existingNames[i]) < 0) return i;
  }
  return existingNames.length;
}

/** Insert position for a new modality: the caller's slot when ranked in `callerOrder`, else alphabetical (docs/file-watching.md). */
export function modalityInsertIndex(
  existing: readonly string[],
  name: string,
  callerOrder?: readonly string[]
): number {
  const rank = callerOrder ? callerOrder.indexOf(name) : -1;
  if (rank !== -1 && callerOrder) {
    for (let i = 0; i < existing.length; i++) {
      const r = callerOrder.indexOf(existing[i]);
      if (r === -1 || r > rank) return i;
    }
    return existing.length;
  }
  for (let i = 0; i < existing.length; i++) {
    if (name.localeCompare(existing[i]) < 0) return i;
  }
  return existing.length;
}
