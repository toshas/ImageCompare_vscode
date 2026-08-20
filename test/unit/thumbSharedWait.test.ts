import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, workspace, __channelLines, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL ThumbnailService and the REAL provider sweep, because the defect is an accounting one that
// only exists under concurrency: every caller that arrives while `ensurePackLoaded` is reading
// thumbs.pack awaits the SAME promise, and each used to charge its whole wall wait to its own tier.
// A field capture of a 9x10 session reported pack=83/385.1KB/8118ms for a sweep that took 658ms wall
// — one ~600ms NFS read printed 83 times. Nothing but the real service can reproduce that: a fake
// has no shared in-flight promise to double-count.
// The pack read is slowed here through the vscode mock (not through the service), so the shared load
// is an external, test-owned number the assertions are pinned against.
// (docs/loading-architecture.md: shared-waits-are-not-per-item-work)

const READ_DELAY_MS = 80;
/** thumbs.idx then thumbs.pack — the two reads every waiter is blocked behind. */
const SHARED_LOAD_MS = 2 * READ_DELAY_MS;
const CHANNEL = 'ImageCompare';

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const realReadFile = workspace.fs.readFile;

function delayPackReads(): void {
  workspace.fs.readFile = async (uri: Uri): Promise<Uint8Array> => {
    if (/thumbs\.(pack|idx)$/.test(uri.fsPath)) await new Promise(r => setTimeout(r, READ_DELAY_MS));
    return realReadFile(uri);
  };
}

const asUri = (u: Uri) => u as unknown as import('vscode').Uri;

interface Bed { storage: string; images: Uri[] }

/**
 * A cache dir holding a published pack whose entries cover the FIRST `warmed` images, and no
 * per-entry JPEGs at all — so a later service answers `warmed` images from the pack and must
 * generate the rest, both of them behind the one shared pack load.
 */
async function makeBed(imageCount: number, warmed: number, size = 64): Promise<Bed> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sharedwait-'));
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

  const seed = newService(storage);
  for (const u of images.slice(0, warmed)) await seed.getThumbnail(asUri(u), size);
  await seed.flush();
  seed.dispose();
  await seed.flush();
  for (const name of fs.readdirSync(cacheDir)) {
    if (name.endsWith('.jpg')) fs.rmSync(path.join(cacheDir, name));
  }
  return { storage, images };
}

function newService(storage: string): ThumbnailService {
  return new ThumbnailService({ globalStorageUri: Uri.file(storage) } as unknown as import('vscode').ExtensionContext);
}

/** One tuple per image, one modality — the sweep shape a session of N files produces. */
function makeState(images: Uri[]): Record<string, unknown> {
  return {
    panel: { webview: { postMessage: () => undefined } },
    scanResult: {
      modalities: ['imgs'],
      tuples: images.map((u, i) => ({ name: `img${i}`, images: [{ uri: u, name: path.basename(u.fsPath), modality: 'imgs' }] })),
      mode: 1,
      roots: [],
      isMultiTupleMode: true
    },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    poolKey: `sharedwait-${Math.random().toString(36).slice(2)}`,
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(undefined, undefined))
  };
}

function sweepLines(): string[] {
  return __channelLines(CHANNEL).filter(l => l.includes('[IC-SWEEP]'));
}

async function waitForSweepDone(timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = sweepLines().find(l => l.includes(' done '));
    if (done) return done;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error('sweep rollup never landed');
}

/**
 * These assertions count how many sweep items sit on the one shared pack read at once, which is the
 * work pool's width minus the foreground reservation — a host property (`os.availableParallelism()`)
 * unless pinned. `maxConcurrentReads` is that pin; set before the first provider/service reaches the
 * process-wide pool, so the counts below are the test's, not the runner's core count.
 * (docs/loading-architecture.md: pool-width-hides-latency)
 */
const POOL_WIDTH = 16;

describe('shared pack-load accounting (real ThumbnailService)', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig('maxConcurrentReads', POOL_WIDTH);
    __resetChannels();
    disposeDebugLog();
  });

  afterEach(() => {
    workspace.fs.readFile = realReadFile;
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('six concurrent pack hits report their own work, not six copies of the one shared pack read', async () => {
    const bed = await makeBed(6, 6);
    __setConfig('debug', true);
    const sub = initDebugLog();
    delayPackReads();
    const svc = newService(bed.storage);

    const startedAt = Date.now();
    await Promise.all(bed.images.map(u => svc.getThumbnail(asUri(u), 64)));
    const wall = Date.now() - startedAt;

    const stats = svc.thumbTierStats();
    expect(stats.pack.count).toBe(6);
    // The load really was shared: six serial loads could not fit in this wall time.
    expect(wall).toBeLessThan(6 * SHARED_LOAD_MS);
    // ...so no single item, let alone all six, may report the shared load as its own tier work.
    expect(stats.pack.ms).toBeLessThan(SHARED_LOAD_MS);

    sub.dispose();
    await svc.flush();
    svc.dispose();
  });

  it('the one-off pack read is reported once, with the count and the summed wait it caused', async () => {
    const bed = await makeBed(6, 6);
    __setConfig('debug', true);
    const sub = initDebugLog();
    delayPackReads();
    const svc = newService(bed.storage);

    await Promise.all(bed.images.map(u => svc.getThumbnail(asUri(u), 64)));

    const load = svc.thumbPackLoadStat();
    expect(load.count).toBe(1);
    expect(load.ms).toBeGreaterThanOrEqual(SHARED_LOAD_MS - 5);
    expect(load.bytes).toBeGreaterThan(0);
    expect(load.blocked).toBe(6);
    // Every waiter was blocked for most of the one load, so the sum is several loads' worth.
    expect(load.waitedMs).toBeGreaterThan(3 * SHARED_LOAD_MS);

    sub.dispose();
    await svc.flush();
    svc.dispose();
  });

  it('the verbose per-thumbnail line separates the item ms from the wait it queued behind', async () => {
    const bed = await makeBed(6, 6);
    __setConfig('debug', true);
    __setConfig('debugVerbose', true);
    const sub = initDebugLog();
    delayPackReads();
    const svc = newService(bed.storage);

    await Promise.all(bed.images.map(u => svc.getThumbnail(asUri(u), 64)));

    const thumbLines = __channelLines(CHANNEL).filter(l => l.includes('[IC-THUMB] pack '));
    expect(thumbLines).toHaveLength(6);
    for (const line of thumbLines) {
      const parsed = /\[IC-THUMB] pack (\d+)ms \+(\d+)ms packLoad wait /.exec(line);
      expect(parsed, `unreadable thumb line: ${line}`).not.toBeNull();
      expect(Number(parsed![1])).toBeLessThan(SHARED_LOAD_MS);
      expect(Number(parsed![2])).toBeGreaterThan(0);
    }

    sub.dispose();
    await svc.flush();
    svc.dispose();
  });

  it('the tiers BELOW the pack inherit the same shared wait, and must not book it either', async () => {
    // Two entries in the pack, six requests that miss it: every one generates behind the same load.
    const bed = await makeBed(8, 2);
    __setConfig('debug', true);
    const sub = initDebugLog();
    delayPackReads();
    const svc = newService(bed.storage);

    const startedAt = Date.now();
    await Promise.all(bed.images.slice(2).map(u => svc.getThumbnail(asUri(u), 64)));
    const wall = Date.now() - startedAt;

    const stats = svc.thumbTierStats();
    const load = svc.thumbPackLoadStat();
    expect(stats.generated.count).toBe(6);
    expect(load.blocked).toBe(6);
    expect(wall).toBeLessThan(6 * SHARED_LOAD_MS);
    // Decoding six 8x8 PNGs cannot outweigh six waits on a 160ms read — unless the wait is booked twice,
    // which is what the old code did (it charged each item the wait AND left it in the tier).
    expect(stats.generated.ms).toBeLessThan(load.waitedMs);

    sub.dispose();
    await svc.flush();
    svc.dispose();
  });

  it('the sweep rollup prints the shared read once and the tier as per-item work', async () => {
    // Seeded at the size the sweep asks for (`thumbnailSize` 100 x 2), or every slot would miss the pack.
    const bed = await makeBed(6, 6, 200);
    __setConfig('debug', true);
    const sub = initDebugLog();
    delayPackReads();
    const provider = new ImageCompareProvider(
      { globalStorageUri: Uri.file(bed.storage) } as unknown as import('vscode').ExtensionContext
    );
    const state = makeState(bed.images);

    (provider as unknown as { generateAllThumbnails(s: unknown): void }).generateAllThumbnails(state);
    const done = await waitForSweepDone();

    // `pack=<n>/<bytes>/<ms>` is per-item work now: six map lookups cannot cost a whole pack read.
    const tier = /pack=6\/[^/]+\/(\d+)ms/.exec(done);
    expect(tier, `no pack tier term in: ${done}`).not.toBeNull();
    expect(Number(tier![1])).toBeLessThan(SHARED_LOAD_MS);
    // ...and the shared read is reported on its own, once, with the waiting it caused.
    expect(done).toMatch(/packLoad=1x\d+ms\/[\d.]+\w+ blocked=6\/\d+ms/);

    sub.dispose();
    await (provider as unknown as { thumbnailService: ThumbnailService }).thumbnailService.flush();
    provider.dispose();
  });
});
