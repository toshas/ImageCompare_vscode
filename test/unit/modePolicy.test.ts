import { describe, it, expect } from 'vitest';
import { MODES, ModeBehaviour } from '../../src/modePolicy';

// Layer 1 for the one table the selection shape's behaviour lives in
// (docs/session-files.md: mode-behaviour-is-a-table). Both hosts read it, so a wrong cell is a
// divergence between the extension and the standalone — which is how it was found: the same
// questions were being asked with a magic number at fourteen sites, and two of them had drifted.
//
// Pinned against the mode table as WRITTEN DOWN in docs/session-files.md, not against the
// implementation. Mode 1 is "one directory whose subdirectories are the columns", mode 2 "several
// directories, each a column, named by the caller", mode 3 "one row whose columns are unrelated
// files" — every cell below follows from one of those three sentences, and the test says which.

describe('the mode table (modePolicy.ts, real code)', () => {
  it('says what the roots are, which is what a host builds its state from', () => {
    expect(MODES[1].roots).toBe('base-dir');
    expect(MODES[2].roots).toBe('modality-dirs');
    expect(MODES[3].roots).toBe('files');
  });

  it('knows a column is a file only where the columns ARE files', () => {
    expect(MODES[1].columnIsFile).toBe(false);
    expect(MODES[2].columnIsFile).toBe(false);
    expect(MODES[3].columnIsFile).toBe(true);
  });

  // The premise of per-column directory watching and of adopting a new column: true only where the
  // columns are, by definition, the subdirectories of one root. Mode 2's dirs are unrelated paths.
  it('knows only one shape has the root s subdirectories as its columns', () => {
    expect(MODES[1].rootSubdirsAreColumns).toBe(true);
    expect(MODES[2].rootSubdirsAreColumns).toBe(false);
    expect(MODES[3].rootSubdirsAreColumns).toBe(false);
  });

  // Discovered columns may number one — a comparison runs at one column. Named ones may not: the
  // caller asked for those directories, so one yielding nothing is a mistake worth reporting.
  it('floors the discovered shape at one column and the named ones at two', () => {
    expect(MODES[1].minColumns).toBe(1);
    expect(MODES[2].minColumns).toBe(2);
    expect(MODES[3].minColumns).toBe(2);
  });

  // labels/colors are keyed by the URI of the listed path, so they resolve only where the listed
  // paths ARE the columns. In mode 1 the listed path is their parent; in mode 3 there are no dirs.
  it('resolves session-file labels only where the listed paths are the columns', () => {
    expect(MODES[1].labelsApply).toBe(false);
    expect(MODES[2].labelsApply).toBe(true);
    expect(MODES[3].labelsApply).toBe(false);
  });

  it('lets the directory shapes gain files and holds a file list to what was enumerated', () => {
    expect(MODES[1].grows).toBe(true);
    expect(MODES[2].grows).toBe(true);
    expect(MODES[3].grows).toBe(false);
  });

  it('offers voting in the directory shapes and withholds it from a file list', () => {
    expect(MODES[1].voting).toBe(true);
    expect(MODES[2].voting).toBe(true);
    expect(MODES[3].voting).toBe(false);
  });

  it('makes Del take one image in a file list and the whole row everywhere else', () => {
    expect(MODES[1].deleteUnit).toBe('tuple');
    expect(MODES[2].deleteUnit).toBe('tuple');
    expect(MODES[3].deleteUnit).toBe('image');
  });

  // A tuple-wide crop name is what re-groups the columns into one row — and is one path written N
  // times where those columns share a directory, which only a file list's can.
  it('names crops per tuple where the columns are directories, and per image where they are files', () => {
    expect(MODES[1].cropNaming).toBe('tuple');
    expect(MODES[2].cropNaming).toBe('tuple');
    expect(MODES[3].cropNaming).toBe('per-image');
  });

  it('lets a crop join only a comparison that grows at all', () => {
    for (const mode of [1, 2, 3] as const) {
      expect(MODES[mode].cropsJoin).toBe(MODES[mode].grows);
    }
  });

  // The properties that hold ACROSS the table, so a new mode cannot be added incoherently.
  it('answers every question for every mode, with no cell left undefined', () => {
    const fields: Array<keyof ModeBehaviour> = [
      'roots', 'columnIsFile', 'rootSubdirsAreColumns', 'minColumns',
      'labelsApply', 'grows', 'voting', 'deleteUnit', 'cropNaming', 'cropsJoin',
    ];
    for (const mode of [1, 2, 3] as const) {
      for (const field of fields) {
        expect(MODES[mode][field], `${mode}.${field}`).toBeDefined();
      }
    }
  });

  it('gives every mode a distinct roots meaning, so no two shapes are the same shape', () => {
    expect(new Set([MODES[1].roots, MODES[2].roots, MODES[3].roots]).size).toBe(3);
  });

  // The shape that cannot be ranked is the shape whose columns are unrelated files, which is the
  // same shape that deletes one of them and does not grow. One sentence, four cells.
  it('agrees with itself: the file-list shape is unvotable, image-deleting, non-growing and file-columned', () => {
    for (const mode of [1, 2, 3] as const) {
      const isFileList = MODES[mode].columnIsFile;
      expect(MODES[mode].voting).toBe(!isFileList);
      expect(MODES[mode].deleteUnit).toBe(isFileList ? 'image' : 'tuple');
      expect(MODES[mode].grows).toBe(!isFileList);
      expect(MODES[mode].cropNaming).toBe(isFileList ? 'per-image' : 'tuple');
    }
  });
});
