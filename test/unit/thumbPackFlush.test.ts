import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { Uri, workspace } from '../mocks/vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { parsePack } from '../../src/thumbPack';
import { makeSolidPng } from '../fixtures/synthetic';
import { settleServices } from '../helpers/providerQuiesce';

// The REAL ThumbnailService against real files (the fs-backed `vscode` mock), because the bug is a
// lifetime bug, not a format bug: pack writes are 30s idle-debounced, so a window/host that goes
// away inside that window used to drop the snapshot entirely and the next open re-read (or
// regenerated) every thumbnail one file at a time — the "why is a warm open still slow on a network
// mount" report. (docs/image-backends.md: thumb-pack-survives-close)

const tmpRoots: string[] = [];
// Every service these tests built. `dispose()` is fire-and-forget by contract, and the tests that
// exercise it deliberately do not await anything, so the file's own writes — the pack AND the
// per-entry .jpg — are settled here instead: flush() is the one call that waits for both
// (docs/image-backends.md: thumb-pack-survives-close). A write landing inside the rmSync below is
// invisible on POSIX and ENOTEMPTY on Windows (docs/testing.md, Findings).
const services: ThumbnailService[] = [];
afterAll(async () => {
  await settleServices(services);
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

interface Bed {
  svc: ThumbnailService;
  cacheDir: string;
  images: Uri[];
}

function makeBed(imageCount: number): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-packflush-'));
  tmpRoots.push(root);
  const imgDir = path.join(root, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const images: Uri[] = [];
  for (let i = 0; i < imageCount; i++) {
    const file = path.join(imgDir, `img${i}.png`);
    // Distinct colours so distinct JPEG bytes: a wrong-entry pack would show up as equal payloads.
    fs.writeFileSync(file, makeSolidPng(8, 8, [10 * i, 255 - 10 * i, 128]));
    images.push(Uri.file(file));
  }
  const storage = path.join(root, 'globalStorage');
  fs.mkdirSync(storage, { recursive: true });
  const ctx = { globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext;
  const svc = new ThumbnailService(ctx);
  services.push(svc);
  const cacheDir = path.join(storage, 'thumbnail-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { svc, cacheDir, images };
}

function packOnDisk(cacheDir: string): Map<string, Buffer> | null {
  const idxPath = path.join(cacheDir, 'thumbs.idx');
  const packPath = path.join(cacheDir, 'thumbs.pack');
  if (!fs.existsSync(idxPath) || !fs.existsSync(packPath)) return null;
  return parsePack(fs.readFileSync(idxPath, 'utf8'), fs.readFileSync(packPath));
}

/** Poll for a published pack — dispose() is sync, so the write it starts lands shortly after it returns. */
async function waitForPack(cacheDir: string, timeoutMs = 2500): Promise<Map<string, Buffer> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const map = packOnDisk(cacheDir);
    if (map && map.size > 0) return map;
    if (Date.now() > deadline) return map;
    await new Promise(r => setTimeout(r, 25));
  }
}

/**
 * Make every per-entry `.jpg` write take `ms`, at the one seam the service writes through. A real
 * slow disk (or a loaded CI host) is the same shape: `getThumbnail` returns as soon as the bytes
 * exist and the cache copy is written un-awaited, so without this the write always happens to be
 * over before anything looks, and the race is invisible on a fast POSIX box.
 */
function delayJpgWrites(ms: number, onLanded: () => void = () => undefined): () => void {
  const original = workspace.fs.writeFile;
  workspace.fs.writeFile = async (uri: Uri, content: Uint8Array): Promise<void> => {
    if (uri.fsPath.endsWith('.jpg')) await new Promise(r => setTimeout(r, ms));
    await original(uri, content);
    if (uri.fsPath.endsWith('.jpg')) onLanded();
  };
  return () => { workspace.fs.writeFile = original; };
}

const jpgsIn = (cacheDir: string): string[] => fs.readdirSync(cacheDir).filter(n => n.endsWith('.jpg')).sort();

async function cacheAll(svc: ThumbnailService, images: Uri[]): Promise<void> {
  for (const uri of images) {
    await svc.getThumbnail(uri as unknown as import('vscode').Uri, 64);
  }
}

describe('thumbnail packfile survives a close (real ThumbnailService, real files)', () => {
  it('dispose() publishes the pending pack instead of dropping it', async () => {
    const { svc, cacheDir, images } = makeBed(6);
    await cacheAll(svc, images);
    // Still inside the idle debounce: nothing has been published yet.
    expect(packOnDisk(cacheDir)).toBeNull();

    svc.dispose();

    const map = await waitForPack(cacheDir);
    expect(map).not.toBeNull();
    expect(map!.size).toBe(6);
  });

  it('flush() resolves only once the pack and idx are on disk (the deactivate path)', async () => {
    const { svc, cacheDir, images } = makeBed(4);
    await cacheAll(svc, images);

    await svc.flush();

    // No polling: a shutdown that awaits flush() must find the files already published.
    const map = packOnDisk(cacheDir);
    expect(map).not.toBeNull();
    expect(map!.size).toBe(4);
    svc.dispose();
  });

  it('flush() also waits for the per-entry .jpg writes it started, not just the pack', async () => {
    const { svc, cacheDir, images } = makeBed(3);
    const undelay = delayJpgWrites(200);
    try {
      await cacheAll(svc, images);
      // The generate path returns before its cache copy lands, so nothing is on disk yet.
      expect(jpgsIn(cacheDir)).toEqual([]);

      await svc.flush();

      // No polling, no window: everything this session owed the cache is there when flush resolves.
      expect(jpgsIn(cacheDir)).toHaveLength(3);
    } finally {
      undelay();
    }
    svc.dispose();
    await svc.flush();
  });

  it('the shared bed teardown does not return while a cache write is still in flight', async () => {
    // What every bed's afterAll runs before its rmSync. Without it the write below lands *inside* the
    // removal — green on POSIX, ENOTEMPTY on Windows — which is why this asserts the wait, not the file.
    const { svc, images } = makeBed(1);
    let landed = false;
    const undelay = delayJpgWrites(200, () => { landed = true; });
    try {
      await cacheAll(svc, images);
      expect(landed).toBe(false);

      await settleServices([svc]);

      expect(landed).toBe(true);
    } finally {
      undelay();
    }
  });

  it('a clearMemoryCache racing the close never publishes an empty pack over a good one', async () => {
    const { svc, cacheDir, images } = makeBed(4);
    await cacheAll(svc, images.slice(0, 3));
    await svc.flush();
    expect(packOnDisk(cacheDir)!.size).toBe(3);

    await cacheAll(svc, images.slice(3));
    // The provider's shutdown order: dispose() then clearMemoryCache(), both synchronous.
    svc.dispose();
    svc.clearMemoryCache();

    // flush() awaits the write dispose() already queued, so this settles without polling.
    await svc.flush();
    const map = packOnDisk(cacheDir);
    expect(map).not.toBeNull();
    expect(map!.size).toBe(4);
  });

  it('the pack a close left behind serves the next open with no per-entry files', async () => {
    const { svc, cacheDir, images } = makeBed(3);
    await cacheAll(svc, images);
    const before = await Promise.all(
      images.map(u => svc.getThumbnail(u as unknown as import('vscode').Uri, 64))
    );
    svc.dispose();
    await waitForPack(cacheDir);

    // Delete every per-entry .jpg: only the pack can answer now, and a miss would regenerate.
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.endsWith('.jpg')) fs.rmSync(path.join(cacheDir, name));
    }
    const storage = path.dirname(cacheDir);
    const next = new ThumbnailService(
      { globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext
    );
    services.push(next);
    const after = await Promise.all(
      images.map(u => next.getThumbnail(u as unknown as import('vscode').Uri, 64))
    );
    expect(after).toEqual(before);
    expect(fs.readdirSync(cacheDir).filter(n => n.endsWith('.jpg'))).toEqual([]);
    next.dispose();
  });
});
