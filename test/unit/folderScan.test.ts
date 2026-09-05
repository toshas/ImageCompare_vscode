import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import { scanForImages } from '../../src/fileService';

// Layer 1 over the REAL scanForImages on REAL temp dirs (the vscode mock's workspace.fs is node fs),
// for what a *directory* resolves to: structure where there is any, else the loose images as a file
// list (docs/session-files.md: subdir-structure-wins, folder-of-images-is-a-file-list).
//
// Both behaviours here used to be errors, so TEN of the eleven tests in this file fail against the
// pre-change scanner — the two throws they replaced were "This directory contains only image files
// without subdirectory structure" and "Directory must contain 2+ subdirectories with images". The
// eleventh is labelled below: it guards mode 2 against the floor change, so it passes either way.

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

/** A directory tree from a flat spec: `'a.png'` is a file, `'sub/a.png'` a file in a subdir. */
function tree(...entries: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-folderscan-'));
  tmpRoots.push(root);
  for (const entry of entries) {
    const full = path.join(root, entry);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!entry.endsWith('/')) fs.writeFileSync(full, '');
  }
  return root;
}

const scan = (root: string) => scanForImages([Uri.file(root)] as never);
const names = (r: { tuples: Array<{ images: Array<{ name: string }> }> }) =>
  r.tuples[0].images.map(i => i.name);

describe('a directory of loose images opens as the file list it is (fileService.ts, real code)', () => {
  it('is mode 3: one tuple holding every image, in natural name order', async () => {
    const result = await scan(tree('img_2.png', 'img_10.png', 'img_1.png'));
    expect(result.mode).toBe(3);
    expect(result.tuples).toHaveLength(1);
    // Natural, not lexicographic: '10' after '2' is the whole point of naturalSort.
    expect(names(result)).toEqual(['img_1.png', 'img_2.png', 'img_10.png']);
    expect(result.isMultiTupleMode).toBe(false);
  });

  it('drops the junk a folder accumulates, keeping only images', async () => {
    const result = await scan(tree('a.png', 'b.jpg', 'notes.txt', 'results.txt', '.DS_Store'));
    expect(names(result)).toEqual(['a.png', 'b.jpg']);
  });

  it('excludes this app own _cropNN writes, which would otherwise interleave with their parents', async () => {
    const result = await scan(tree('shot.png', 'shot_crop01.png', 'shot_crop02.png', 'other.png'));
    expect(names(result)).toEqual(['other.png', 'shot.png']);
  });

  // The fall-back the exclusion needs so it cannot turn a real folder into a dead end.
  it('shows the crops anyway when excluding them would leave nothing to compare', async () => {
    const result = await scan(tree('shot_crop01.png', 'shot_crop02.png'));
    expect(names(result)).toEqual(['shot_crop01.png', 'shot_crop02.png']);
  });

  it('still refuses a folder holding one image — there is nothing to compare it against', async () => {
    await expect(scan(tree('only.png', 'notes.txt'))).rejects.toThrow(/at least 2/);
  });

  it('still refuses a folder with neither images nor image subdirectories', async () => {
    await expect(scan(tree('notes.txt', 'empty/'))).rejects.toThrow(/must contain images/);
  });

  // The mode is the same one a hand-picked selection produces — that equivalence IS the feature.
  it('reaches the same shape as selecting those files by hand', async () => {
    const root = tree('a.png', 'b.png');
    const fromFolder = await scan(root);
    const fromFiles = await scanForImages([
      Uri.file(path.join(root, 'a.png')),
      Uri.file(path.join(root, 'b.png')),
    ] as never);
    expect(fromFolder.mode).toBe(fromFiles.mode);
    expect(fromFolder.modalities).toEqual(fromFiles.modalities);
    expect(names(fromFolder)).toEqual(names(fromFiles));
  });
});

describe('one subdirectory of images is a comparison, not an error (fileService.ts, real code)', () => {
  it('opens a single image subdir as mode 1 with that one column', async () => {
    const result = await scan(tree('gt/a.png', 'gt/b.png'));
    expect(result.mode).toBe(1);
    expect(result.modalities).toEqual(['gt']);
    expect(result.tuples).toHaveLength(2);
  });

  it('prefers the structure: one imageful subdir wins over the loose images beside it', async () => {
    const result = await scan(tree('gt/a.png', 'loose1.png', 'loose2.png'));
    expect(result.mode).toBe(1);
    expect(result.modalities).toEqual(['gt']);
  });

  it('falls through to the loose images when the subdir holds no images', async () => {
    const result = await scan(tree('logs/run.txt', 'loose1.png', 'loose2.png'));
    expect(result.mode).toBe(3);
    expect(names(result)).toEqual(['loose1.png', 'loose2.png']);
  });

  // REGRESSION GUARD: passes before and after, by design. The floor is a function of the mode, not a
  // constant — mode 2's directories were named by the caller, so one of them yielding nothing is a
  // mistake worth reporting rather than a column count. It is mutation-covered (relaxing the floor
  // to `< 1` kills it), so it is a guard with teeth rather than decoration.
  it('keeps mode 2 at two columns: two selected dirs, one imageless, is still an error', async () => {
    const root = tree('gt/a.png', 'pred/notes.txt');
    await expect(scanForImages([
      Uri.file(path.join(root, 'gt')),
      Uri.file(path.join(root, 'pred')),
    ] as never)).rejects.toThrow(/must each contain images/);
  });
});
