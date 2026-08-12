import { describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import {
  disambiguateDirectoryNames,
  findDifferingParts,
  matchTuplesWithTrie,
} from '../../src/fileService';

/**
 * Cross-platform LOGIC tests. These run on macOS but feed Windows-style inputs
 * (backslashes, drive letters, UNC) to prove the path/parsing layer behaves
 * identically regardless of OS. The native/runtime risks (Sharp binaries, FS
 * watcher) are covered by the 3-OS CI matrix, not here.
 */

describe('disambiguateDirectoryNames — POSIX vs Windows parity', () => {
  it('Windows drive-letter paths disambiguate by parent dir', () => {
    const uris = [Uri.file('C:\\data\\exp1\\GT'), Uri.file('C:\\data\\exp2\\GT')];
    const out = disambiguateDirectoryNames(uris);
    expect(out.map((o) => o.name)).toEqual(['exp1/GT', 'exp2/GT']);
  });

  it('produces the same display names for equivalent POSIX paths', () => {
    const win = disambiguateDirectoryNames([
      Uri.file('C:\\data\\exp1\\GT'),
      Uri.file('C:\\data\\exp2\\GT'),
    ]).map((o) => o.name);
    const posix = disambiguateDirectoryNames([
      Uri.file('/data/exp1/GT'),
      Uri.file('/data/exp2/GT'),
    ]).map((o) => o.name);
    expect(win).toEqual(posix);
  });

  it('distinct basenames need no disambiguation on either OS', () => {
    const out = disambiguateDirectoryNames([
      Uri.file('C:\\a\\GT'),
      Uri.file('D:\\b\\PRED'),
    ]);
    expect(out.map((o) => o.name)).toEqual(['GT', 'PRED']);
  });

  it('UNC paths split cleanly (no empty leading segments)', () => {
    const out = disambiguateDirectoryNames([
      Uri.file('\\\\server\\share\\runA\\GT'),
      Uri.file('\\\\server\\share\\runB\\GT'),
    ]);
    expect(out.map((o) => o.name)).toEqual(['runA/GT', 'runB/GT']);
  });
});

describe('findDifferingParts is separator- and OS-independent', () => {
  it('extracts the differing middle regardless of platform', () => {
    expect(findDifferingParts(['img_001_gt.png', 'img_001_pred.png'])).toEqual(['gt', 'pred']);
  });
});

describe('matchTuplesWithTrie case behavior is explicit', () => {
  it('identical basenames match across modalities (exact pass)', () => {
    const files = new Map<string, Array<{ name: string; uri: Uri }>>();
    files.set('GT', [{ name: 'frame01.png', uri: Uri.file('C:\\m\\GT\\frame01.png') }]);
    files.set('RGB', [{ name: 'frame01.png', uri: Uri.file('C:\\m\\RGB\\frame01.png') }]);
    const tuples = matchTuplesWithTrie(files as never, ['GT', 'RGB']);
    expect(tuples).toHaveLength(1);
    expect(tuples[0].files.size).toBe(2);
  });

  it('case-different basenames are treated as distinct (Linux is case-sensitive)', () => {
    // Documents real behavior: on a case-sensitive FS (Linux) these are two
    // different files; matching compares raw basenames, so they do NOT collapse.
    const files = new Map<string, Array<{ name: string; uri: Uri }>>();
    files.set('GT', [
      { name: 'Frame01.png', uri: Uri.file('/m/GT/Frame01.png') },
      { name: 'frame01.png', uri: Uri.file('/m/GT/frame01.png') },
    ]);
    files.set('RGB', [{ name: 'frame01.png', uri: Uri.file('/m/RGB/frame01.png') }]);
    const tuples = matchTuplesWithTrie(files as never, ['GT', 'RGB']);
    // Two reference files => two tuples; the RGB lowercase file matches exactly one.
    expect(tuples).toHaveLength(2);
  });
});
