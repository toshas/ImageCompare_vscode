import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';

// The REAL provider's real prefetchAround/loadImageToCache, driven through the vscode mock, because
// the bug this pins is an ordering bug between synchronous and asynchronous settles: a slot whose
// modality has no image settles *inside* the issue loop, and a wave that could roll up mid-issue
// deleted itself before its own issue line was ever printed. Sparse tuples are first-class here
// (docs/tuple-matching.md: sparse-vs-dense-tuples), so a rollup that only survives dense waves is a
// rollup that is missing exactly when a user is diagnosing a real session.
// (docs/loading-architecture.md: debug-off-costs-nothing — the same wave map is debug-gated)

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const CHANNEL = 'ImageCompare';
const MODALITIES = ['gt', 'ours', 'baseline'];
// Distinct sizes so the rolled-up byte total names which slots actually loaded.
const SIZES: Record<string, number> = { gt: 1024, ours: 2048, baseline: 4096 };

function makeProvider(): ImageCompareProvider {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-prefetch-'));
  tmpRoots.push(root);
  const provider = new ImageCompareProvider(
    { globalStorageUri: Uri.file(root) } as unknown as import('vscode').ExtensionContext
  );
  // Only the byte source is stubbed; scheduling, wave accounting and posting are the real code.
  (provider as unknown as { thumbnailService: unknown }).thumbnailService = {
    loadFullImage: async (uri: Uri) => {
      const mod = path.basename(path.dirname(uri.path));
      return { bytes: new Uint8Array(SIZES[mod] ?? 512), mime: 'image/png', width: 4, height: 4 };
    }
  };
  return provider;
}

/** One tuple whose images cover `present` modalities, in the global modality order. */
function makeState(present: string[]): Record<string, unknown> {
  const images = MODALITIES.filter(m => present.includes(m)).map(m => ({
    uri: Uri.file(`/imgs/${m}/frame.png`),
    name: 'frame.png',
    modality: m
  }));
  return {
    panel: { webview: { postMessage: () => undefined } },
    scanResult: { modalities: [...MODALITIES], tuples: [{ name: 'frame', images }], mode: 2, roots: [], isMultiTupleMode: false },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    poolKey: `test-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    wire: { thumbnails: 0, thumbB64Bytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    // A local session: the transport budget is inert, so wave accounting is measured unthrottled.
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(undefined, undefined))
  };
}

function prefetchLines(): string[] {
  return __channelLines(CHANNEL).filter(l => l.includes('[IC-PREFETCH]'));
}

/** The wave settles asynchronously through the shared pool; poll for its rollup. */
async function waitForRollup(timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (prefetchLines().some(l => l.includes(' done '))) return;
    await new Promise(r => setTimeout(r, 15));
  }
}

async function runWave(present: string[]): Promise<string[]> {
  const provider = makeProvider();
  const state = makeState(present);
  await (provider as unknown as { prefetchAround(s: unknown, i: number): Promise<void> }).prefetchAround(state, 0);
  await waitForRollup();
  return prefetchLines();
}

describe('prefetch wave rollup (real ImageCompareProvider)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    // Centre tuple only: the wave is exactly one tuple x three modalities, so slot counts are exact.
    __setConfig('prefetchCount', 0);
    initDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('a dense wave logs issuance and a rollup carrying the loaded bytes', async () => {
    const lines = await runWave(MODALITIES);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[IC-PREFETCH] wave \S+ center=0 slots=3 pool /);
    // 1024 + 2048 + 4096 = 7168 bytes.
    expect(lines[1]).toMatch(/\[IC-PREFETCH] wave \S+ done \d+ms slots=3 loaded=7\.0KB /);
  });

  it('a wave whose FIRST slot has no image still logs both lines (it used to log neither)', async () => {
    const lines = await runWave(['ours', 'baseline']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('slots=3');
    // 2048 + 4096 = 6144: the empty slot settles at zero bytes but still counts toward the wave.
    expect(lines[1]).toMatch(/done \d+ms slots=3 loaded=6\.0KB /);
  });

  it('a wave with a hole in the middle still logs both lines', async () => {
    const lines = await runWave(['gt', 'baseline']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('slots=3');
    expect(lines[1]).toMatch(/done \d+ms slots=3 loaded=5\.0KB /);
  });

  it('a wave with no images at all settles without a rollup rather than hanging or double-logging', async () => {
    const lines = await runWave([]);
    // Every slot settles at zero bytes; the issue line still reports what was attempted.
    expect(lines[0]).toContain('slots=3');
    expect(lines.filter(l => l.includes(' done '))).toHaveLength(1);
    expect(lines[1]).toMatch(/done \d+ms slots=3 loaded=0B /);
  });

  it('debug off: a wave logs nothing and registers no rollup state', async () => {
    __setConfig('debug', false);
    initDebugLog();
    const provider = makeProvider();
    const state = makeState(MODALITIES);
    await (provider as unknown as { prefetchAround(s: unknown, i: number): Promise<void> }).prefetchAround(state, 0);
    await new Promise(r => setTimeout(r, 100));
    expect(prefetchLines()).toEqual([]);
    expect((state.prefetchWaves as Map<string, unknown>).size).toBe(0);
  });
});
