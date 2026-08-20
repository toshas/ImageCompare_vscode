// Layer 1 for the open-path rollup: the pure formatter (src/debugLog.ts) and the REAL provider's
// emission of it (src/imageCompareProvider.ts), both imported, never copied.
//
// The bug this exists for is not a crash: a 746x10 open left the window blank for ~20 s and the
// channel could only show a 6.96 s hole between the matcher's last line and the sweep's first, with
// an idle pool. Every span in that hole (watchers, the html assignment, the webview's boot, the init
// payload, the hand-off to the sweep) is now attributed, and whatever is still unaccounted for shows
// up as `other` rather than disappearing.
// (docs/loading-architecture.md: open-spans-account-for-the-whole-open)
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig, workspace } from '../mocks/vscode';
import { beginOpenMarks, formatOpenRollup, OpenMarks } from '../../src/debugLog';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { scanForImages } from '../../src/fileService';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';

const CHANNEL = 'ImageCompare';

/** Marks laid out so every span is a distinct, hand-checkable number (ms since an arbitrary epoch). */
function marksFixture(): OpenMarks {
  const t0 = 1_000_000;
  return {
    ...beginOpenMarks(t0),
    scanDoneAt: t0 + 8420,        // scan   = 8420
    watchersAt: t0 + 8500,        // 80 ms of unmarked panel-state building
    watchersDoneAt: t0 + 8590,    // watchers = 90
    htmlAt: t0 + 8600,
    readyAt: t0 + 8910,           // boot   = 310
    initAt: t0 + 8920,
    initPostedAt: t0 + 14120,     // init   = 5200
    sweepAt: t0 + 21080,          // toSweep = 6960, total = 21080, other = 21080-21060 = 20+80 = 100
    scanFiles: 7460,
    matchMs: 6510,
    watchedDirs: 11,
    initBytes: 3 * 1024 * 1024,   // 3.0MB
    initSizingMs: 180,
    tuples: 746,
    modalities: 10
  };
}

describe('open rollup — the formatter (src/debugLog.ts)', () => {
  // Every number here is computed by hand from marksFixture(), not read back from the code.
  it('renders one line whose spans are the differences between consecutive marks', () => {
    expect(formatOpenRollup(marksFixture())).toBe(
      'open 21080ms scan=8420ms/7460f(match=6510ms) watchers=90ms/11dirs boot=310ms'
      + ' init=5200ms(sizing 180ms)/3.0MB grid=746x10 toSweep=6960ms other=100ms'
    );
  });

  // The point of the line: a step nobody marked must still be visible. 80 ms of panel-state building
  // plus 10 ms + 10 ms of gaps around the html assignment and the ready hand-off = 100 ms of `other`.
  it('time between marked spans is reported as `other`, never absorbed into a neighbour', () => {
    const marks = marksFixture();
    // 5 s of work nobody marked, wedged in after the scan: every span keeps its length, the total grows.
    const slower: OpenMarks = { ...marks };
    for (const k of ['watchersAt', 'watchersDoneAt', 'htmlAt', 'readyAt', 'initAt', 'initPostedAt', 'sweepAt'] as const) {
      slower[k] = marks[k] + 5000;
    }
    expect(formatOpenRollup(slower)).toContain('other=5100ms');
    expect(formatOpenRollup(slower)).toContain('toSweep=6960ms');
    expect(formatOpenRollup(slower)).toContain('scan=8420ms');
    expect(formatOpenRollup(slower)).toContain('open 26080ms');
  });

  it('a fully accounted open reports other=0ms', () => {
    const t0 = 500;
    const marks: OpenMarks = {
      ...beginOpenMarks(t0),
      scanDoneAt: t0 + 100,
      watchersAt: t0 + 100,
      watchersDoneAt: t0 + 110,
      htmlAt: t0 + 110,
      readyAt: t0 + 140,
      initAt: t0 + 140,
      initPostedAt: t0 + 160,
      sweepAt: t0 + 165,
      scanFiles: 4,
      matchMs: 3,
      watchedDirs: 2,
      initBytes: 1536,
      initSizingMs: 1,
      tuples: 2,
      modalities: 2
    };
    expect(formatOpenRollup(marks)).toBe(
      'open 165ms scan=100ms/4f(match=3ms) watchers=10ms/2dirs boot=30ms'
      + ' init=20ms(sizing 1ms)/1.5KB grid=2x2 toSweep=5ms other=0ms'
    );
  });

  it('beginOpenMarks starts every mark at the open time, so a rollup before any mark is all zeros', () => {
    expect(formatOpenRollup(beginOpenMarks(42))).toBe(
      'open 0ms scan=0ms/0f(match=0ms) watchers=0ms/0dirs boot=0ms'
      + ' init=0ms(sizing 0ms)/0B grid=0x0 toSweep=0ms other=0ms'
    );
  });
});

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function makeProvider(): ImageCompareProvider {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-open-'));
  tmpRoots.push(root);
  const provider = new ImageCompareProvider({
    globalStorageUri: Uri.file(root),
    // The shell's script URI is built from it; only the open-path tests below get that far.
    extensionUri: Uri.file(root),
    extension: { packageJSON: { version: '9.9.9' } }
  } as unknown as import('vscode').ExtensionContext);
  // Only the pixels are stubbed; init assembly, sizing, posting and the rollup are the real code.
  (provider as unknown as { thumbnailService: unknown }).thumbnailService = {
    getThumbnail: async () => new Uint8Array(16),
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    }),
    thumbPackLoadStat: () => ({ count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 })
  };
  return provider;
}

const MODALITIES = ['gt', 'ours'];

function makeState(marks: OpenMarks | undefined, posted: unknown[]): Record<string, unknown> {
  const tuples = ['a', 'b', 'c'].map(name => ({
    name,
    images: MODALITIES.map(m => ({ uri: Uri.file(`/imgs/${m}/${name}.png`), name: `${name}.png`, modality: m }))
  }));
  return {
    panel: { webview: { postMessage: (msg: unknown) => { posted.push(msg); } } },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    modalityDirs: new Map(),
    winners: new Map(),
    votingEnabled: false,
    labelsExplicit: false,
    disposed: false,
    visible: true,
    poolKey: `open-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(undefined, undefined)),
    openMarks: marks
  };
}

function openLines(): string[] {
  return __channelLines(CHANNEL).filter(l => l.includes('[IC-OPEN]'));
}

async function sendInit(provider: ImageCompareProvider, state: Record<string, unknown>): Promise<void> {
  await (provider as unknown as { sendInitData(s: unknown): Promise<void> }).sendInitData(state);
}

describe('open rollup — the real provider emits it (src/imageCompareProvider.ts)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    initDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('sendInitData closes the trace and logs exactly one [IC-OPEN] line, ahead of the sweep', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const marks = beginOpenMarks(Date.now() - 1234);
    const state = makeState(marks, posted);
    await sendInit(provider, state);
    expect(openLines()).toHaveLength(1);
    expect(openLines()[0]).toMatch(
      /\[IC-OPEN] open \d+ms scan=\d+ms\/0f\(match=0ms\) watchers=\d+ms\/0dirs boot=\d+ms init=\d+ms\(sizing \d+ms\)\/\d/
    );
    expect(openLines()[0]).toMatch(/grid=3x2 toSweep=\d+ms other=\d+ms$/);
    const sweepIndex = __channelLines(CHANNEL).findIndex(l => l.includes('[IC-SWEEP] start'));
    const openIndex = __channelLines(CHANNEL).findIndex(l => l.includes('[IC-OPEN]'));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(sweepIndex).toBeGreaterThan(openIndex);
    expect(state.openMarks).toBeUndefined();
  });

  // The size is the reason the line exists at all for a 7460-slot open; it must be the payload's own
  // size, so it is pinned against a JSON.stringify of the message the provider actually posted.
  it('reports the serialized init payload size, measured on the payload that was posted', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const state = makeState(beginOpenMarks(Date.now()), posted);
    await sendInit(provider, state);
    const init = posted.find(m => (m as { type?: string }).type === 'init');
    expect(init).toBeDefined();
    const expected = Buffer.byteLength(JSON.stringify(init));
    // Same units the log uses: bytes under 1 KB print bare, otherwise KB at one decimal.
    const shown = /init=\d+ms\(sizing \d+ms\)\/(\S+) grid=/.exec(openLines()[0])?.[1];
    expect(shown).toBe(expected < 1024 ? `${expected}B` : `${(expected / 1024).toFixed(1)}KB`);
    expect(expected).toBeGreaterThan(200);
  });

  it('a second sweep on the same panel does not re-emit the open rollup', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const state = makeState(beginOpenMarks(Date.now()), posted);
    await sendInit(provider, state);
    await sendInit(provider, state);
    expect(openLines()).toHaveLength(1);
  });

  it('debug off: no trace, no line, and no payload is ever serialized to size it', async () => {
    __setConfig('debug', false);
    initDebugLog();
    const provider = makeProvider();
    const posted: unknown[] = [];
    const state = makeState(undefined, posted);
    await sendInit(provider, state);
    expect(openLines()).toEqual([]);
    expect(state.openMarks).toBeUndefined();
  });
});

// Where each mark is TAKEN, not how the formatter subtracts them. The formatter cannot tell a mark
// at the wrong site from a mark at the right one — every span is correct by construction there — so
// these drive the real provider and burn measurable wall time inside a step no mark brackets. The
// burn must surface in `other` and must NOT be absorbed by the neighbouring span, which is exactly
// what moving a mark does. (docs/loading-architecture.md: open-spans-account-for-the-whole-open)
const BURN_MS = 120;
// Half the burn: enough to separate "absorbed the burn" from "did not", loose enough for a busy CI box.
const SPAN_FLOOR_MS = 60;

/** Hold the extension host for `ms` the way a slow synchronous open step does. */
function burn(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin: the open path is synchronous here, so sleeping would not do */ }
}

/** One `<name>=<n>ms` span out of an emitted rollup line. */
function span(line: string, name: string): number {
  const m = new RegExp(`\\b${name}=(-?\\d+)ms`).exec(line);
  if (!m) throw new Error(`no ${name}= span in: ${line}`);
  return Number(m[1]);
}

function imageFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-openpath-'));
  tmpRoots.push(root);
  for (const mod of ['gt', 'pred']) {
    fs.mkdirSync(path.join(root, mod));
    for (const n of ['a.png', 'b.png']) fs.writeFileSync(path.join(root, mod, n), '');
  }
  return root;
}

/**
 * A panel the real `openCompare` can drive. Attaching the message listener is a real open step that
 * sits after the watchers mark and before the html mark, so the burn there is unmarked open work.
 */
function fakePanel(posted: unknown[], burnOnSubscribe: number) {
  const disposeListeners: Array<() => void> = [];
  let deliver: ((m: unknown) => unknown) | undefined;
  const panel = {
    visible: true,
    webview: {
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u: unknown) => u,
      postMessage: (msg: unknown) => { posted.push(msg); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (m: unknown) => unknown) => {
        burn(burnOnSubscribe);
        deliver = listener;
        return { dispose: () => undefined };
      }
    },
    onDidDispose: (l: () => void) => { disposeListeners.push(l); return { dispose: () => undefined }; },
    onDidChangeViewState: (_l: unknown) => ({ dispose: () => undefined })
  };
  return {
    panel: panel as unknown as import('vscode').WebviewPanel,
    ready: async (): Promise<void> => { await deliver?.({ type: 'ready' }); },
    close: (): void => { for (const l of disposeListeners) l(); }
  };
}

describe('open rollup — where the marks are taken (src/imageCompareProvider.ts)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    initDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('the html mark sits at the html assignment: panel construction shows as `other`, never as boot', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const p = fakePanel(posted, BURN_MS);
    await provider.openCompare([Uri.file(imageFixture())] as never, p.panel);
    await p.ready();
    p.close();
    const line = openLines()[0];
    expect(line, 'the open emitted its rollup').toBeDefined();
    expect(span(line, 'other'), 'the unmarked panel construction is reported').toBeGreaterThanOrEqual(SPAN_FLOOR_MS);
    expect(span(line, 'boot'), 'boot is the webview boot only').toBeLessThan(SPAN_FLOOR_MS);
  });

  it('the ready mark sits at the top of the ready handler: the pending-debug flush shows as `other`, never as boot', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const marks = beginOpenMarks(Date.now());
    const state = makeState(marks, posted);
    state.webviewReady = false;
    state.pendingDebugMessages = ['queued while the webview was booting'];
    const webview = (state.panel as { webview: { postMessage: (m: unknown) => void } }).webview;
    webview.postMessage = (msg: unknown) => {
      if ((msg as { type?: string }).type === '_debug') burn(BURN_MS);
      posted.push(msg);
    };
    marks.htmlAt = Date.now();
    await (provider as unknown as { handlePanelMessage(s: unknown, m: unknown): Promise<void> })
      .handlePanelMessage(state, { type: 'ready' });
    const line = openLines()[0];
    expect(line, 'the ready handler emitted the rollup').toBeDefined();
    expect(span(line, 'other'), 'the flush the boot span must not own is reported').toBeGreaterThanOrEqual(SPAN_FLOOR_MS);
    expect(span(line, 'boot'), 'boot ends at the ready message, not at the end of its handler').toBeLessThan(SPAN_FLOOR_MS);
  });

  // C2: taken at the top of generateAllThumbnails, `toSweep` was one `if` plus one call — structurally
  // ~0 — and the config read plus the plan build fell between the two rollups, inside neither.
  it('the sweep mark sits at the sweep\'s own clock, so the hand-off carries the plan it pays for', async () => {
    const provider = makeProvider();
    const posted: unknown[] = [];
    const state = makeState(beginOpenMarks(Date.now()), posted);
    const realGetConfiguration = workspace.getConfiguration;
    workspace.getConfiguration = ((section?: string) => {
      burn(BURN_MS);
      return realGetConfiguration(section);
    }) as typeof workspace.getConfiguration;
    try {
      await sendInit(provider, state);
    } finally {
      workspace.getConfiguration = realGetConfiguration;
    }
    const line = openLines()[0];
    expect(line, 'the sweep emitted the rollup').toBeDefined();
    expect(span(line, 'toSweep'), 'the sweep prologue is inside the hand-off span').toBeGreaterThanOrEqual(SPAN_FLOOR_MS);
  });
});

// The two numbers only the scan can report, produced by the REAL scanForImages over real temp dirs.
describe('the scan reports its own numbers for the rollup (src/fileService.ts)', () => {
  function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-openscan-'));
    tmpRoots.push(root);
    for (const mod of ['gt', 'pred']) {
      fs.mkdirSync(path.join(root, mod));
      for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(root, mod, n), '');
    }
    // Not an image: it must not inflate the file count the rollup prints.
    fs.writeFileSync(path.join(root, 'gt', 'notes.txt'), '');
    return root;
  }

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

  it('counts the image files handed to the matcher, and times the matcher inside the scan', async () => {
    __setConfig('debug', true);
    initDebugLog();
    const result = await scanForImages([Uri.file(fixture())] as never);
    expect(result.tuples).toHaveLength(3);
    // 2 modalities x 3 images; the .txt is not one of them.
    expect(result.stats?.files).toBe(6);
    expect(result.stats?.matchMs).toBeGreaterThanOrEqual(0);
    expect(result.stats?.matchMs).toBeLessThan(60_000);
  });

  it('a file list reports its own file count and no matcher time', async () => {
    __setConfig('debug', true);
    initDebugLog();
    const root = fixture();
    const result = await scanForImages([
      Uri.file(path.join(root, 'gt', 'a.png')),
      Uri.file(path.join(root, 'pred', 'a.png'))
    ] as never);
    expect(result.mode).toBe(3);
    expect(result.stats).toEqual({ files: 2, matchMs: 0 });
  });

  it('debug off: the scan carries no stats at all', async () => {
    __setConfig('debug', false);
    initDebugLog();
    const result = await scanForImages([Uri.file(fixture())] as never);
    expect(result.tuples).toHaveLength(3);
    expect(result.stats).toBeUndefined();
  });
});

// A source-shape gate, the same kind the matcher trace has: nothing observable at runtime
// distinguishes "sized the payload and threw the number away" from "never sized it", so the real
// file's shape is the only thing a test can hold. (docs/loading-architecture.md: debug-off-costs-nothing)
describe('the open trace is created and used only behind the debug flag', () => {
  const src = readFileSync(resolve(__dirname, '../../src/imageCompareProvider.ts'), 'utf8');
  const lines = src.split('\n');

  /** Line indices that sit inside an `if (marks) {` / `if (openMarks) {` block. */
  function gatedLines(): Set<number> {
    const inside = new Set<number>();
    let depth = 0;
    lines.forEach((line, i) => {
      if (depth > 0) {
        inside.add(i);
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        return;
      }
      if (/if \((marks|openMarks|state\.openMarks)\)\s*\{\s*$/.test(line)) depth = 1;
    });
    return inside;
  }

  it('the trace object is allocated only when debugEnabled() says so', () => {
    const allocations = lines.filter(l => l.includes('beginOpenMarks('));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatch(/debugEnabled\(\)\s*\?\s*beginOpenMarks\(/);
  });

  it('the init payload is serialized for its size only inside the trace gate', () => {
    const sizingSites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('JSON.stringify(initMessage)'));
    expect(sizingSites, 'the payload size is still measured').toHaveLength(1);
    expect(gatedLines().has(sizingSites[0].i), 'JSON.stringify(initMessage) must sit inside if (marks) {').toBe(true);
  });

  it('every open mark is written behind a trace guard', () => {
    const gated = gatedLines();
    const offenders: string[] = [];
    let marksWrites = 0;
    lines.forEach((line, i) => {
      if (!/\b(marks|openMarks|state\.openMarks)\.\w+\s*=[^=]/.test(line)) return;
      marksWrites++;
      if (!gated.has(i) && !/^\s*if \((marks|openMarks|state\.openMarks)\)\s/.test(line)) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(marksWrites, 'the open path still records its marks').toBeGreaterThanOrEqual(8);
    expect(offenders, 'ungated open-mark writes').toEqual([]);
  });
});
