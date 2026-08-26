import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { parsePack } from '../../src/thumbPack';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL ThumbnailService against real files, because the bug is in what the key can *see*: an
// in-place overwrite that restores mtime and keeps the byte count (cp -p, rsync --times, tar -p, a
// training loop rewriting its outputs) used to hash to the same key and serve the previous image
// forever. makeSolidPng emits stored (uncompressed) zlib blocks, so two colours of the same
// dimensions are byte-length-identical — that is what makes the collision reproducible here.
// (docs/image-backends.md: thumb-key-sees-overwrite)

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const asUri = (u: Uri) => u as unknown as import('vscode').Uri;

interface Bed {
  svc: ThumbnailService;
  storage: string;
  cacheDir: string;
  imgDir: string;
}

function makeBed(prefix: string): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  const imgDir = path.join(root, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const storage = path.join(root, 'globalStorage');
  const cacheDir = path.join(storage, 'thumbnail-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { svc: newService(storage), storage, cacheDir, imgDir };
}

function newService(storage: string): ThumbnailService {
  return new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
}

/** Overwrite with different pixels while restoring mtime and keeping size — the copy-tool signature. */
function overwritePreservingStat(file: string, bytes: Buffer, before: fs.Stats): void {
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, before.atime, before.mtime);
  // Inode change time must actually advance for the fix to have anything to see; on a filesystem
  // whose ctime resolution is coarse, re-touch until it does rather than assert on a tie.
  const deadline = Date.now() + 2000;
  while (fs.statSync(file).ctimeMs === before.ctimeMs && Date.now() < deadline) {
    fs.utimesSync(file, before.atime, before.mtime);
  }
}

/** A whole-millisecond mtime: utimes truncates sub-ms precision, so a stat before and after agree exactly. */
const FIXED_MTIME = new Date(1_700_000_000_000);

function writeImage(file: string, rgb: [number, number, number]): void {
  fs.writeFileSync(file, makeSolidPng(8, 8, rgb));
  fs.utimesSync(file, FIXED_MTIME, FIXED_MTIME);
}

function jpgNames(cacheDir: string): string[] {
  return fs.readdirSync(cacheDir).filter(n => n.endsWith('.jpg')).sort();
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('thumbnail cache keying (real ThumbnailService, real files)', () => {
  it('an in-place overwrite with identical mtime and size serves the new pixels, not the cached ones', async () => {
    const { svc, imgDir } = makeBed('ic-cachekey-');
    const file = path.join(imgDir, 'a.png');
    writeImage(file, [220, 20, 20]);
    const uri = Uri.file(file);

    const before = await svc.getThumbnail(asUri(uri), 64);

    const st1 = fs.statSync(file);
    overwritePreservingStat(file, makeSolidPng(8, 8, [20, 220, 20]), st1);
    const st2 = fs.statSync(file);
    // Without these three the test would be vacuous — it must be the *ctime* that differs.
    expect(st2.mtimeMs).toBe(st1.mtimeMs);
    expect(st2.size).toBe(st1.size);
    expect(st2.ctimeMs).not.toBe(st1.ctimeMs);

    const after = await svc.getThumbnail(asUri(uri), 64);

    // Pinned against the bytes the new content really produces, not merely "something changed".
    const ref = makeBed('ic-cachekey-ref-');
    const refFile = path.join(ref.imgDir, 'ref.png');
    writeImage(refFile, [20, 220, 20]);
    const expected = await ref.svc.getThumbnail(asUri(Uri.file(refFile)), 64);

    expect(after.equals(expected)).toBe(true);
    expect(after.equals(before)).toBe(false);

    await svc.flush();
    svc.dispose();
    await ref.svc.flush();
    ref.svc.dispose();
  });

  it('the stale entry does not outlive the session either: a fresh service re-reads the overwritten file', async () => {
    const { svc, storage, cacheDir, imgDir } = makeBed('ic-cachekey-cold-');
    const file = path.join(imgDir, 'b.png');
    writeImage(file, [10, 10, 200]);
    const uri = Uri.file(file);

    const before = await svc.getThumbnail(asUri(uri), 64);
    await svc.flush(); // publish the pack: the next session's first tier
    svc.dispose();
    expect(fs.existsSync(path.join(cacheDir, 'thumbs.pack'))).toBe(true);

    const st1 = fs.statSync(file);
    overwritePreservingStat(file, makeSolidPng(8, 8, [200, 200, 10]), st1);
    expect(fs.statSync(file).mtimeMs).toBe(st1.mtimeMs);
    expect(fs.statSync(file).size).toBe(st1.size);

    const next = newService(storage);
    const after = await next.getThumbnail(asUri(uri), 64);
    expect(after.equals(before)).toBe(false);

    await next.flush();
    next.dispose();
  });

  it('a superseded key is evicted rather than accumulating a dead per-entry file and pack slot', async () => {
    const { svc, cacheDir, imgDir } = makeBed('ic-cachekey-evict-');
    const file = path.join(imgDir, 'c.png');
    writeImage(file, [5, 5, 5]);
    const uri = Uri.file(file);

    await svc.getThumbnail(asUri(uri), 64);
    await waitFor(() => jpgNames(cacheDir).length === 1);
    expect(jpgNames(cacheDir).length).toBe(1);

    // An ordinary rewrite (new mtime): the old key is dead the moment the new one is computed.
    fs.writeFileSync(file, makeSolidPng(8, 8, [250, 250, 5]));
    fs.utimesSync(file, new Date(1_700_000_500_000), new Date(1_700_000_500_000));
    await svc.getThumbnail(asUri(uri), 64);

    await waitFor(() => jpgNames(cacheDir).length === 1);
    expect(jpgNames(cacheDir).length).toBe(1);

    await svc.flush();
    const map = parsePack(
      fs.readFileSync(path.join(cacheDir, 'thumbs.idx'), 'utf8'),
      fs.readFileSync(path.join(cacheDir, 'thumbs.pack'))
    );
    expect(map).not.toBeNull();
    expect(map!.size).toBe(1);
    svc.dispose();
  });
});
