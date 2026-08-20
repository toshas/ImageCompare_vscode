import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import { scanForImages } from '../../src/fileService';

// Real symlinks on disk, scanned by the REAL scanForImages through the fs-backed
// `vscode` mock, whose FileType mirrors vscode's bitmask (symlinked dir = 66,
// symlinked file = 65, dangling = 64). Reported live: a symlinked modality dir
// produced no column and a symlinked image no tuple, because the open-time
// scanner compared the type with `===` while the adoption/poll paths already
// used `&` — same symlink, visible or not depending on WHEN it appeared.
// (docs/tuple-matching.md: entry-type-is-a-bitmask)

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-symlink-'));
  tmpRoots.push(root);
  return root;
}

function mkImages(dir: string, names: string[]): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), '');
  return dir;
}

// 'dir' rather than a Windows junction: junctions cannot point at a missing
// target, and the dangling-link case needs one that can.
function linkDir(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, 'dir');
}

// Windows needs SeCreateSymbolicLinkPrivilege (or Developer Mode) for file
// symlinks; where it is unavailable the suite skips rather than fails. Linux and
// macOS CI plus the mutation gate (ubuntu) keep the rule pinned.
function canSymlink(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'a'), '');
    fs.mkdirSync(path.join(probe, 'd'));
    fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'a-link'), 'file');
    linkDir(path.join(probe, 'd'), path.join(probe, 'd-link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

describe.skipIf(!canSymlink())('scanForImages follows symlinks (open-time scanner)', () => {
  it('mode 2: a symlinked modality directory becomes a modality column', async () => {
    const root = mkTmp();
    const gt = mkImages(path.join(root, 'gt'), ['img_1_gt.png', 'img_2_gt.png']);
    const elsewhere = mkImages(path.join(root, 'elsewhere'), ['img_1_pred.png', 'img_2_pred.png']);
    const link = path.join(root, 'pred');
    linkDir(elsewhere, link);

    const result = await scanForImages([Uri.file(gt), Uri.file(link)] as never);

    expect(result.modalities).toContain('pred');
    expect(result.tuples.length).toBe(2);
    for (const t of result.tuples) expect(t.images.length).toBe(2);
  });

  it('mode 1: symlinked subdirectories of a root are modalities', async () => {
    const root = mkTmp();
    const store = mkTmp();
    const a = mkImages(path.join(store, 'a'), ['img_1_gt.png']);
    const b = mkImages(path.join(store, 'b'), ['img_1_pred.png']);
    linkDir(a, path.join(root, 'GT'));
    linkDir(b, path.join(root, 'PRED'));

    const result = await scanForImages([Uri.file(root)] as never);

    expect(result.modalities.slice().sort()).toEqual(['GT', 'PRED']);
    expect(result.tuples.length).toBe(1);
    expect(result.tuples[0].images.length).toBe(2);
  });

  it('a symlinked image file inside a modality dir yields a tuple', async () => {
    const root = mkTmp();
    const store = mkImages(path.join(root, 'store'), ['img_2_gt.png']);
    const gt = mkImages(path.join(root, 'gt'), ['img_1_gt.png']);
    const pred = mkImages(path.join(root, 'pred'), ['img_1_pred.png', 'img_2_pred.png']);
    fs.symlinkSync(path.join(store, 'img_2_gt.png'), path.join(gt, 'img_2_gt.png'), 'file');

    const result = await scanForImages([Uri.file(gt), Uri.file(pred)] as never);

    const linked = result.tuples.find(t => t.images.some(i => i.name === 'img_2_gt.png'));
    expect(linked).toBeDefined();
    expect(linked!.images.length).toBe(2);
    expect(result.tuples.length).toBe(2);
  });

  it('mode 3: a symlinked image among selected files is one of the compared images', async () => {
    const root = mkTmp();
    const dir = mkImages(path.join(root, 'files'), ['scene_gt.png', 'target_pred.png']);
    const link = path.join(root, 'scene_link.png');
    fs.symlinkSync(path.join(dir, 'scene_gt.png'), link, 'file');

    const result = await scanForImages([
      Uri.file(path.join(dir, 'target_pred.png')),
      Uri.file(link),
    ] as never);

    expect(result.tuples.length).toBe(1);
    expect(result.tuples[0].images.map(i => i.name).sort()).toEqual(['scene_link.png', 'target_pred.png']);
  });

  it('broken symlinks (type 64: neither File nor Directory) are skipped silently', async () => {
    const root = mkTmp();
    const gt = mkImages(path.join(root, 'gt'), ['img_1_gt.png']);
    const pred = mkImages(path.join(root, 'pred'), ['img_1_pred.png']);
    fs.symlinkSync(path.join(root, 'gone', 'img_9_gt.png'), path.join(gt, 'img_9_gt.png'), 'file');
    linkDir(path.join(root, 'gone-dir'), path.join(root, 'dangling'));

    const byRoot = await scanForImages([Uri.file(root)] as never);
    expect(byRoot.modalities.slice().sort()).toEqual(['gt', 'pred']);
    expect(byRoot.tuples.length).toBe(1);

    const byDirs = await scanForImages([Uri.file(gt), Uri.file(pred)] as never);
    expect(byDirs.tuples.length).toBe(1);
    expect(byDirs.tuples.flatMap(t => t.images.map(i => i.name))).not.toContain('img_9_gt.png');
  });
});
