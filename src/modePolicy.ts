/** Pure (no vscode, no DOM): the selection shape's behaviour as a table, so a mode is read by the name of what it decides and never by its number (docs/session-files.md: mode-behaviour-is-a-table). */

/** What Del removes. */
export type DeleteUnit = 'tuple' | 'image';

/** Everything the selection shape alone decides. One field per question some site would otherwise ask with a magic number. */
export interface ModeBehaviour {
  /** What `ScanResult.roots` holds, and so what a host builds its panel state from. */
  roots: 'base-dir' | 'modality-dirs' | 'files';
  /** A column is a file, not a directory — decides what a pill's path names and what Del can take. */
  columnIsFile: boolean;
  /** The root's subdirectories ARE the columns: the premise of per-column directory watching and of adopting a new one. */
  rootSubdirsAreColumns: boolean;
  /** Fewest columns a scan of this shape may yield; below it the scan is an error, not a comparison. */
  minColumns: number;
  /** Session-file `labels`/`colors` are keyed by the listed path, so they resolve only where the listed paths ARE the columns. */
  labelsApply: boolean;
  /** The comparison can gain files after the scan; a file list is enumerated once. */
  grows: boolean;
  /** Columns can be ranked against each other. */
  voting: boolean;
  /** What Del removes. */
  deleteUnit: DeleteUnit;
  /** One crop name for the whole tuple, or one per image — a tuple-wide name is one path where the columns share a directory. */
  cropNaming: 'tuple' | 'per-image';
  /** A written crop joins the comparison it was cut from. */
  cropsJoin: boolean;
}

/**
 * The executable form of the mode table in docs/session-files.md. Adding a mode is a compile error
 * at every site rather than a silent default, and no site restates a mode number
 * (docs/session-files.md: mode-behaviour-is-a-table).
 */
export const MODES: Readonly<Record<1 | 2 | 3, ModeBehaviour>> = {
  // One directory whose subdirectories are the columns.
  1: {
    roots: 'base-dir',
    columnIsFile: false,
    rootSubdirsAreColumns: true,
    // Discovered, not named: finding one is an answer, and a comparison runs at one column.
    minColumns: 1,
    labelsApply: false,
    grows: true,
    voting: true,
    deleteUnit: 'tuple',
    cropNaming: 'tuple',
    cropsJoin: true,
  },
  // Several directories, each a column, named by the caller.
  2: {
    roots: 'modality-dirs',
    columnIsFile: false,
    rootSubdirsAreColumns: false,
    // Named by the caller, so one of them yielding nothing is a mistake worth reporting.
    minColumns: 2,
    labelsApply: true,
    grows: true,
    voting: true,
    deleteUnit: 'tuple',
    cropNaming: 'tuple',
    cropsJoin: true,
  },
  // One row whose columns are unrelated files — selected by hand, or enumerated from a directory.
  3: {
    roots: 'files',
    columnIsFile: true,
    rootSubdirsAreColumns: false,
    minColumns: 2,
    labelsApply: false,
    grows: false,
    voting: false,
    deleteUnit: 'image',
    cropNaming: 'per-image',
    cropsJoin: false,
  },
};
