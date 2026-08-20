import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL ThumbnailService against a real cache directory, because the bug is about *when* files
// die: the sweep prunes by mtime, and a fully warm session rewrites nothing, so the pack that is
// serving every thumbnail aged out from under an active user — one brutal cold open per week, worst
// on the network mounts this cache exists for. Backdating the cache dir is the only honest way to
// reach a week-old cache in a test. (docs/image-backends.md: thumb-cache-expires-by-use)

const tmpRoots: string[] = [];
afterAll(async () => {
  // Same reason as thumbPackFlush: an un-awaited `dispose()` may still be checking the cache dir.
  await new Promise(r => setTimeout(r, 100));
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const asUri = (u: Uri) => u as unknown as import('vscode').Uri;
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

interface Bed {
  storage: string;
  cacheDir: string;
  images: Uri[];
}

function makeBed(imageCount: number): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cacheexpiry-'));
  tmpRoots.push(root);
  const imgDir = path.join(root, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const images: Uri[] = [];
  for (let i = 0; i < imageCount; i++) {
    const file = path.join(imgDir, `img${i}.png`);
    fs.writeFileSync(file, makeSolidPng(8, 8, [10 * i, 255 - 10 * i, 128]));
    images.push(Uri.file(file));
  }
  const storage = path.join(root, 'globalStorage');
  const cacheDir = path.join(storage, 'thumbnail-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { storage, cacheDir, images };
}

function newService(storage: string): ThumbnailService {
  return new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
}

function backdateCache(cacheDir: string): void {
  for (const name of fs.readdirSync(cacheDir)) {
    fs.utimesSync(path.join(cacheDir, name), THIRTY_DAYS_AGO, THIRTY_DAYS_AGO);
  }
}

const packExists = (cacheDir: string): boolean =>
  fs.existsSync(path.join(cacheDir, 'thumbs.pack')) && fs.existsSync(path.join(cacheDir, 'thumbs.idx'));

const jpgNames = (cacheDir: string): string[] =>
  fs.readdirSync(cacheDir).filter(n => n.endsWith('.jpg'));

/** Populate the cache and publish the pack, exactly as a session that ends normally does. */
async function seedCache(storage: string, images: Uri[]): Promise<void> {
  const svc = newService(storage);
  for (const u of images) await svc.getThumbnail(asUri(u), 64);
  await svc.flush();
  svc.dispose();
}

describe('thumbnail cache expiry (real ThumbnailService, real cache dir)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('a week-old pack that is serving this session survives the sweep', async () => {
    const { storage, cacheDir, images } = makeBed(3);
    await seedCache(storage, images);
    expect(packExists(cacheDir)).toBe(true);
    backdateCache(cacheDir);

    const svc = newService(storage);
    for (const u of images) await svc.getThumbnail(asUri(u), 64);
    await svc.cleanupOldCache();

    expect(packExists(cacheDir)).toBe(true);
    // The redundant per-entry files are still pruned by age — the pack carries their bytes.
    expect(jpgNames(cacheDir)).toEqual([]);
    await svc.flush();
    svc.dispose();

    // The next open must still be a warm one: served from the pack, nothing regenerated.
    __setConfig('debug', true);
    const sub = initDebugLog();
    const next = newService(storage);
    for (const u of images) await next.getThumbnail(asUri(u), 64);
    const stats = next.thumbTierStats();
    expect(stats.pack.count).toBe(3);
    expect(stats.generated.count).toBe(0);
    sub.dispose();
    await next.flush();
    next.dispose();
  });

  it('a pack deleted under a live session is republished by the close', async () => {
    const { storage, cacheDir, images } = makeBed(3);
    await seedCache(storage, images);

    // A fully warm session: every thumbnail is answered from the pack, so nothing it does would
    // ordinarily mark the cache dirty — which is exactly why the vanished pack went unnoticed.
    const svc = newService(storage);
    const served: Buffer[] = [];
    for (const u of images) served.push(await svc.getThumbnail(asUri(u), 64));

    // Another window's sweep (or a manual cache clear) empties the directory mid-session.
    for (const name of fs.readdirSync(cacheDir)) {
      fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
    }
    expect(packExists(cacheDir)).toBe(false);
    // The in-memory map keeps serving regardless — that half already worked.
    expect(await svc.getThumbnail(asUri(images[0]), 64)).toEqual(served[0]);

    await svc.flush();
    svc.dispose();
    expect(packExists(cacheDir)).toBe(true);

    // And the pack it restored is a real one: the next open is warm, with nothing regenerated.
    __setConfig('debug', true);
    const sub = initDebugLog();
    const next = newService(storage);
    const after: Buffer[] = [];
    for (const u of images) after.push(await next.getThumbnail(asUri(u), 64));
    const stats = next.thumbTierStats();
    expect(stats.pack.count).toBe(3);
    expect(stats.generated.count).toBe(0);
    expect(after).toEqual(served);
    sub.dispose();
    await next.flush();
    next.dispose();
  });

  it('a week-old pack nobody opened still expires', async () => {
    const { storage, cacheDir, images } = makeBed(2);
    await seedCache(storage, images);
    backdateCache(cacheDir);

    const svc = newService(storage);
    await svc.cleanupOldCache();

    expect(packExists(cacheDir)).toBe(false);
    expect(jpgNames(cacheDir)).toEqual([]);
    svc.dispose();
  });
});
