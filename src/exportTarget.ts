/** Pure (no vscode): where a generated file lands, decided by what the comparison is rooted in (docs/session-files.md: exports-land-beside-the-images). */
import * as path from 'path';

export interface ExportRoots {
  /** Mode 1's base directory, the one the user selected. */
  baseDir?: string;
  /** Mode 2's modality directories, in scan order; the export goes to the first one's parent. */
  modalityDirs: readonly string[];
  /** The first image of the first tuple — a file list's only anchor, since it owns no directory. */
  firstImagePath?: string;
}

/** The first root the comparison actually has, in preference order (docs/session-files.md: exports-land-beside-the-images). */
export function exportOutputDir(roots: ExportRoots): string | undefined {
  if (roots.baseDir) return roots.baseDir;
  if (roots.modalityDirs.length > 0) return path.dirname(roots.modalityDirs[0]);
  return roots.firstImagePath ? path.dirname(roots.firstImagePath) : undefined;
}
