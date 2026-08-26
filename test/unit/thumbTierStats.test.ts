import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __fireConfigChange, __resetConfig, __resetChannels, __setConfig } from '../mocks/vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { THUMB_TIERS } from '../../src/debugLog';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL ThumbnailService against real files, because the thing under test is which cache tier
// answered — a number Round 2 of the perf work will reason about. Attribution can only be wrong in a
// way a fake would hide: memory, pack and disk all return byte-identical JPEGs, so only driving the
// real code through a real cache directory can tell them apart.
// (docs/loading-architecture.md: debug-off-costs-nothing)

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function makeBed(imageCount: number): { svc: ThumbnailService; cacheDir: string; storage: string; images: Uri[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-tierstats-'));
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
  const svc = new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
  return { svc, cacheDir, storage, images };
}

const asUri = (u: Uri) => u as unknown as import('vscode').Uri;

// The per-entry cache write is fire-and-forget by design (`saveToDiskCache`, deliberately not
// awaited: the caller must never block on a cache fill). A test that reads the disk tier therefore
// has to wait for that write instead of racing it — under whole-suite IO contention it lands after
// the assertion roughly 13% of the time. Deadline stays under Vitest's 5s so this error, not a bare
// timeout, names what failed; a write that never lands still fails the test.
async function waitForCachedJpeg(cacheDir: string, deadlineMs = 4000): Promise<string> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.endsWith('.jpg') && fs.statSync(path.join(cacheDir, name)).size > 0) return name;
    }
    if (Date.now() >= until) throw new Error(`no per-entry .jpg landed in ${cacheDir} within ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function totalCount(stats: ReturnType<ThumbnailService['thumbTierStats']>): number {
  return THUMB_TIERS.reduce((n, tier) => n + stats[tier].count, 0);
}

describe('thumbnail tier accounting (real ThumbnailService)', () => {
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

  it('debug off: serving thumbnails updates no counter at all', async () => {
    const { svc, images } = makeBed(2);
    __setConfig('debug', false);
    const sub = initDebugLog();

    for (const u of images) await svc.getThumbnail(asUri(u), 64);
    await svc.getThumbnail(asUri(images[0]), 64); // a memory hit too

    expect(totalCount(svc.thumbTierStats())).toBe(0);
    sub.dispose();
    await svc.flush(); // no pending pack write may outlive the temp dir
    svc.dispose();
  });

  it('debug on: a cold read counts as generated, the repeat as memory, each with real bytes', async () => {
    const { svc, images } = makeBed(1);
    __setConfig('debug', true);
    const sub = initDebugLog();

    await svc.getThumbnail(asUri(images[0]), 64);
    const cold = svc.thumbTierStats();
    expect(cold.generated.count).toBe(1);
    expect(cold.generated.bytes).toBeGreaterThan(0);
    expect(cold.memory.count).toBe(0);

    await svc.getThumbnail(asUri(images[0]), 64);
    const warm = svc.thumbTierStats();
    expect(warm.memory.count).toBe(1);
    expect(warm.generated.count).toBe(1);

    sub.dispose();
    await svc.flush();
    svc.dispose();
  });

  it('debug on: a fresh service reading the published pack counts as pack, not disk or generated', async () => {
    const { svc, cacheDir, storage, images } = makeBed(2);
    __setConfig('debug', true);
    const sub = initDebugLog();

    for (const u of images) await svc.getThumbnail(asUri(u), 64);
    await svc.flush();
    svc.dispose();

    // Only the pack can answer now — the per-entry JPEGs are gone, so a miss would show as generated.
    for (const name of fs.readdirSync(cacheDir)) {
      if (name.endsWith('.jpg')) fs.rmSync(path.join(cacheDir, name));
    }
    const next = new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
    for (const u of images) await next.getThumbnail(asUri(u), 64);

    const stats = next.thumbTierStats();
    expect(stats.pack.count).toBe(2);
    expect(stats.pack.bytes).toBeGreaterThan(0);
    expect(stats.generated.count).toBe(0);
    expect(stats.disk.count).toBe(0);

    sub.dispose();
    await next.flush();
    next.dispose();
  });

  it('debug on: a per-entry JPEG with no pack counts as disk', async () => {
    const { svc, cacheDir, storage, images } = makeBed(1);
    __setConfig('debug', true);
    const sub = initDebugLog();

    await svc.getThumbnail(asUri(images[0]), 64); // writes the per-entry .jpg, publishes no pack
    await waitForCachedJpeg(cacheDir); // the unawaited write is what the disk tier below reads
    svc.clearMemoryCache();
    svc.dispose();

    const next = new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
    await next.getThumbnail(asUri(images[0]), 64);

    const stats = next.thumbTierStats();
    expect(stats.disk.count).toBe(1);
    expect(stats.pack.count).toBe(0);
    expect(stats.generated.count).toBe(0);

    sub.dispose();
    await next.flush();
    next.dispose();
  });

  it('turning debug off at runtime stops the counters mid-session', async () => {
    const { svc, images } = makeBed(2);
    __setConfig('debug', true);
    const sub = initDebugLog();

    await svc.getThumbnail(asUri(images[0]), 64);
    const afterOne = totalCount(svc.thumbTierStats());
    expect(afterOne).toBe(1);

    __setConfig('debug', false);
    __fireConfigChange();
    await svc.getThumbnail(asUri(images[1]), 64);

    expect(totalCount(svc.thumbTierStats())).toBe(1);
    sub.dispose();
    await svc.flush();
    svc.dispose();
  });
});
