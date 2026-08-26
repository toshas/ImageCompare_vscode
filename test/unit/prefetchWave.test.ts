import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
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
    sweepAim: newSweepAimPolicy(),
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

/** Drive the real trigger: `tupleFullyLoaded` carrying the strip the webview is showing. */
async function sendFullyLoaded(
  provider: ImageCompareProvider,
  state: Record<string, unknown>,
  tupleIndex: number,
  displayIndex: number,
  over: { hidden?: number[]; order?: number[] } = {}
): Promise<void> {
  const mods = (state.scanResult as { modalities: string[] }).modalities;
  await (provider as unknown as { handlePanelMessage(s: unknown, m: unknown): Promise<void> }).handlePanelMessage(state, {
    type: 'tupleFullyLoaded',
    tupleIndex,
    modalityOrder: over.order ?? mods.map((_, i) => i),
    currentDisplayIndex: displayIndex,
    hiddenModalities: over.hidden ?? []
  });
}

async function runWave(present: string[]): Promise<string[]> {
  const provider = makeProvider();
  const state = makeState(present);
  // Three modalities: the on-screen column plus its nearest two siblings is the whole tuple, so the slot counts below are the same numbers this suite always pinned.
  await sendFullyLoaded(provider, state, 0, 1);
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
    await sendFullyLoaded(provider, state, 0, 1);
    await new Promise(r => setTimeout(r, 100));
    expect(prefetchLines()).toEqual([]);
    expect((state.prefetchWaves as Map<string, unknown>).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prefetch scope (the executed backlog item; the measurements live in docs/loading-architecture.md, "Prefetch"). A wave used to load every neighbour's every
// modality: measured on the field's shape (10 modalities, prefetchCount 3) that is 69 slots /
// 164.5MB per wave, of which a browsing trace displayed 4%. Worse, it defeated its own purpose —
// the visible modality of the +1 tuple sat behind the centre tuple's other nine columns, so the
// first step to a neighbour was a cache MISS (measured 1022ms, against a 741ms idle cold load).
// (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column)

const WIDE = Array.from({ length: 10 }, (_, i) => `mod${i}`);

/** A 5-tuple x 10-modality grid, dense, with the panel parked on `center`. */
function makeWideState(center: number): Record<string, unknown> {
  const state = makeState(MODALITIES) as Record<string, unknown>;
  const tuples = Array.from({ length: 5 }, (_, t) => ({
    name: `f${t}`,
    images: WIDE.map(m => ({ uri: Uri.file(`/imgs/${m}/f${t}.png`), name: `f${t}.png`, modality: m }))
  }));
  state.scanResult = { modalities: [...WIDE], tuples, mode: 2, roots: [], isMultiTupleMode: true };
  state.currentTupleIndex = center;
  return state;
}

/** The wave the webview really triggers: `tupleFullyLoaded` carrying the on-screen column. */
async function runWideWave(
  center: number,
  displayIndex: number,
  over: { hidden?: number[]; order?: number[] } = {}
): Promise<{ state: Record<string, unknown>; lines: string[] }> {
  const provider = makeProvider();
  const state = makeWideState(center);
  await sendFullyLoaded(provider, state, center, displayIndex, over);
  await waitForRollup(8000);
  return { state, lines: prefetchLines() };
}

const cached = (state: Record<string, unknown>): string[] =>
  [...(state.loadedImages as Map<string, unknown>).keys()].sort();

describe('prefetch scope: a neighbour gets the column on screen, not the whole tuple', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    // The field shape, narrowed to one neighbour each way so every slot is nameable.
    __setConfig('prefetchCount', 1);
    initDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('issues the visible column and its nearest siblings, not every modality of every neighbour', async () => {
    const { lines } = await runWideWave(2, 3);
    // 3 tuples x (visible + nearest two siblings) = 9. All ten columns would be 30.
    expect(lines[0]).toMatch(/center=2 slots=9 /);
  });

  it('caches the on-screen column of both neighbours — what prefetch is for', async () => {
    const { state } = await runWideWave(2, 3);
    expect(cached(state)).toContain('1-3');
    expect(cached(state)).toContain('3-3');
  });

  it('never speculates on a neighbour column the user is nowhere near', async () => {
    const { state } = await runWideWave(2, 3);
    // Columns 2,3,4 only: display distance 0 and 1 from the on-screen column.
    expect(cached(state)).toEqual(['1-2', '1-3', '1-4', '2-2', '2-3', '2-4', '3-2', '3-3', '3-4']);
  });

  it('measures the column distance over the display order, not raw modality ids', async () => {
    // Display order puts original 9 on screen, with 0 and 7 either side of it.
    const order = [1, 2, 3, 4, 5, 6, 0, 9, 7, 8];
    const { state } = await runWideWave(2, 7, { order });
    expect(cached(state)).toEqual(['1-0', '1-7', '1-9', '2-0', '2-7', '2-9', '3-0', '3-7', '3-9']);
  });

  it('never speculates on a hidden column', async () => {
    // Display order is identity; 4 is hidden, so the forward sibling is 5.
    const { state } = await runWideWave(2, 3, { hidden: [4] });
    expect(cached(state)).toEqual(['1-2', '1-3', '1-5', '2-2', '2-3', '2-5', '3-2', '3-3', '3-5']);
  });

  it('still rolls the wave up on the debug channel', async () => {
    const { lines } = await runWideWave(2, 3);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/done \d+ms slots=9 loaded=/);
  });
});
