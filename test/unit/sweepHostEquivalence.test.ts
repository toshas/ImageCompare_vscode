import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Uri, workspace, __resetConfig, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { poolWidth, WorkPool } from '../../src/workPool';
import { AIM_DWELL_MS } from '../../src/sweepAimPolicy';

// The leak this file exists to make impossible: commit ff11b92 dwell-gated the sweep's centre in the
// PROVIDER's wiring, so the extension stopped chasing a held key and the standalone kept chasing it.
// The aim is one shared policy now, and the proof is behavioural rather than structural — the SAME
// burst is driven through BOTH real hosts (the real ImageCompareProvider and the real
// standalone/adapter.ts, imported here with the browser globals it needs stubbed), and the traces
// they produce must be identical AND equal to the pinned literal from ff11b92's provider test.
// A host that hand-builds its aim again fails here, whichever host it is.
// (docs/loading-architecture.md: sweep-centre-dwells, docs/standalone.md: adapter-contains-no-logic)

const MODS = ['gt', 'ours'];
const TUPLES = 60;
const OPEN_AT = 0;
/** Rows a held key walks through, all far outside the walk the sweep can reach from OPEN_AT during the burst. */
const BURST = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49];
/** Fake-time gap between keystrokes: a key repeat, comfortably inside the dwell. */
const KEY_GAP_MS = 20;
// The adapter sizes its pool from navigator.hardwareConcurrency when it is imported; pinning that
// here (before the import, below) makes both hosts the same width on every machine, so the two
// traces are comparable slot for slot rather than "the same shape at different cadences".
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true });
/** Both hosts run their pool at this width — the standalone by the line above, the provider by config. */
const POOL_WIDTH = poolWidth(8);

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
  __resetConfig();
});

/** One round of fake time: 1 ms is past every 0 ms timer and flushes the microtasks between them. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
}

const rowOf = (name: string): number => Number(/frame(\d+)/.exec(name)![1]);
const fileName = (t: number): string => `frame${String(t).padStart(2, '0')}.png`;

/** What a host must expose for the burst script to drive it; nothing here is host-specific but the wiring. */
interface Host {
  /** Rows the sweep has asked to read, in dispatch order. */
  asked: number[];
  /** The same reads as `<modality>-<row>`, so the COLUMN the sweep aims at is visible too. */
  askedSlots: string[];
  /** Sweep-key drops, i.e. re-aims (docs/loading-architecture.md: sweep-cancels-on-reaim). */
  reaims(): number;
  /** A webview -> host message, through the host's real message path. */
  send(message: Record<string, unknown>): Promise<void>;
  /** Let `n` outstanding reads finish — the pumps a re-aim would ride, as ff11b92's provider test drives them. */
  finish(n: number): Promise<void>;
  dispose(): void;
}

// ---- Host A: the real extension provider ----

async function providerHost(): Promise<Host> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-equiv-provider-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const asked: number[] = [];
  const askedSlots: string[] = [];
  const resolvers: Array<() => void> = [];

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as never);
  (provider as never as { thumbnailService: unknown }).thumbnailService = {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        asked.push(rowOf(uri.path));
        askedSlots.push(`${/imgs\/([^/]+)\//.exec(uri.path)![1]}-${rowOf(uri.path)}`);
        resolvers.push(() => resolve(Buffer.alloc(4)));
      }),
    loadFullImage: async () => ({ bytes: new Uint8Array(10), mime: 'image/png', width: 4, height: 4 }),
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    }),
    thumbPackLoadStat: () => ({ count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 })
  };

  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: fileName(t).replace('.png', ''),
    images: MODS.map(m => ({ uri: Uri.file(`/imgs/${m}/${fileName(t)}`), name: fileName(t), modality: m }))
  }));
  const state: Record<string, unknown> = {
    panel: { webview: { postMessage: () => Promise.resolve(true) } },
    scanResult: { modalities: [...MODS], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(MODS.map(m => [m, Uri.file(`/imgs/${m}`)])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: OPEN_AT,
    sweepAim: newSweepAimPolicy(),
    disposed: false,
    visible: true,
    poolKey: `equiv-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    watchedDirs: new Set<string>(),
    fileWatchers: [],
    nodeWatchers: [],
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(8, 'ssh-remote'))
  };

  vi.useFakeTimers();
  (provider as never as { generateAllThumbnails(s: unknown): void }).generateAllThumbnails(state);
  await settle();
  const dropsAtOpen = drops.n;

  return {
    asked,
    askedSlots,
    reaims: () => drops.n - dropsAtOpen,
    send: msg => (provider as never as { handlePanelMessage(s: unknown, m: unknown): Promise<void> }).handlePanelMessage(state, msg),
    finish: async n => {
      for (const r of resolvers.splice(0, n)) r();
      await settle(4);
    },
    dispose: () => {
      state.disposed = true;
      for (const r of resolvers.splice(0)) r();
    }
  };
}

// ---- Host B: the real standalone adapter ----

/** A File System Access directory handle over a real temp tree, whose file reads the test releases one by one. */
function gatedHandle(rootName: string, dirPath: string, onRead: (name: string, dir: string) => Promise<void>): unknown {
  const mk = (name: string, p: string): unknown => ({
    kind: 'directory',
    name,
    async getDirectoryHandle(n: string) {
      const c = path.join(p, n);
      if (!fs.existsSync(c) || !fs.statSync(c).isDirectory()) throw new Error(`NotFound ${c}`);
      return mk(n, c);
    },
    async getFileHandle(n: string) {
      const c = path.join(p, n);
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) throw new Error(`NotFound ${c}`);
      return {
        kind: 'file',
        name: n,
        async getFile() {
          return {
            name: n,
            async arrayBuffer() {
              await onRead(n, path.basename(p));
              return fs.readFileSync(c).buffer;
            }
          };
        }
      };
    },
    async *entries() {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        yield [e.name, { kind: e.isDirectory() ? 'directory' : 'file', name: e.name }];
      }
    }
  });
  return mk(rootName, dirPath);
}

/** The browser surface the adapter touches at import and during a sweep; decode is stubbed, every decision is the adapter's. */
function stubBrowser(): { api(): { postMessage(m: unknown): void } } {
  const win: Record<string, unknown> = {
    addEventListener: () => undefined,
    // The webview end of the wire: this test reads the sweep's dispatch order, not its posts.
    dispatchEvent: () => true,
    location: { search: '', hash: '' }
  };
  const el = (): unknown => ({
    addEventListener: () => undefined,
    appendChild: () => undefined,
    classList: { add: () => undefined, remove: () => undefined },
    insertAdjacentHTML: () => undefined,
    style: {},
    setAttribute: () => undefined,
    remove: () => undefined
  });
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.location = win.location;
  g.__IC_VERSION__ = '0.0.0-equivalence';
  g.MessageEvent = class { data: unknown; constructor(_type: string, init: { data: unknown }) { this.data = init.data; } };
  g.createImageBitmap = async () => ({ width: 8, height: 6, close: () => undefined });
  g.Blob = class { constructor(public parts: unknown[], public opts: unknown) {} };
  g.document = {
    head: el(),
    body: el(),
    createElement: (tag: string) =>
      tag === 'canvas'
        ? {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => undefined }),
            toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(8) })
          }
        : el(),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => undefined
  };
  return { api: () => (win as { acquireVsCodeApi(): { postMessage(m: unknown): void } }).acquireVsCodeApi() };
}

async function standaloneHost(): Promise<Host> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-equiv-standalone-'));
  tmpRoots.push(root);
  for (const m of MODS) {
    fs.mkdirSync(path.join(root, m), { recursive: true });
    for (let t = 0; t < TUPLES; t++) fs.writeFileSync(path.join(root, m, fileName(t)), Buffer.alloc(4));
  }

  const asked: number[] = [];
  const askedSlots: string[] = [];
  const resolvers: Array<() => void> = [];
  const browser = stubBrowser();
  // Runtime-computed on purpose: standalone/ compiles under tsconfig.standalone.json (DOM lib, the
  // vscode shim), so a literal specifier would drag it into tsconfig.test.json's program and fail
  // the gates job on errors that are not the test's.
  const adapterModule = '../../standalone/adapter';
  const shimModule = '../../standalone/shims/vscode';
  await import(adapterModule);
  // Vitest's `vscode` alias points src/fileService.ts at test/mocks/vscode.ts, whose workspace.fs
  // reads the REAL filesystem — so the standalone's own scan bypassed its backend here and worked
  // only while the virtual root ('/' + handle name) happened to name a real directory, which is true
  // on POSIX and impossible on Windows (no native path starts with '/C:/'). In the browser that scan
  // goes through the backend, because there `vscode` IS the shim. Point the mock's fs at the shim's
  // for this host's lifetime and it does here too — and the handle name goes back to being a name.
  const shimFs = (await import(shimModule) as { workspace: { fs: Record<string, unknown> } }).workspace.fs;
  const mockFs = { ...(workspace.fs as unknown as Record<string, unknown>) };
  Object.assign(workspace.fs as unknown as Record<string, unknown>, shimFs);
  const api = browser.api();
  const seam = ((globalThis as unknown as { window: { __ic_standalone: { open(h: unknown): Promise<void>; pollIntervalMs: number } } }).window).__ic_standalone;
  // The adapter's own test seam, used to push the external-change poll out of this test's way: it is
  // armed with a REAL timer at open, and a cycle firing mid-burst would read the temp tree from under it.
  seam.pollIntervalMs = 60 * 60 * 1000;

  // The adapter's own reads, gated: the sweep's dispatch order is the order they are asked for.
  // createFsaBackend roots every path at `/<handle name>`, and every path the scan produces resolves
  // back through the handle, so the name is a NAME — a real FSA handle's name is a directory's, never
  // a path, and nothing here may depend on the temp tree's own shape.
  const handle = gatedHandle('ic-equiv-standalone', root, (name, dir) => new Promise<void>(resolve => {
    asked.push(rowOf(name));
    askedSlots.push(`${dir}-${rowOf(name)}`);
    resolvers.push(resolve);
  }));
  await seam.open(handle);

  vi.useFakeTimers();
  api.postMessage({ type: 'ready' });
  await settle();
  const dropsAtOpen = drops.n;

  return {
    asked,
    askedSlots,
    reaims: () => drops.n - dropsAtOpen,
    send: async msg => { api.postMessage(msg); await settle(2); },
    finish: async n => {
      for (const r of resolvers.splice(0, n)) r();
      await settle(4);
    },
    dispose: () => {
      for (const r of resolvers.splice(0)) r();
      // Restore every key we replaced, not the happy-path subset: a throw between splice and
      // dispose would otherwise leave the shared mock's fs pointing at this host's backend.
      for (const k of Object.keys(mockFs)) {
        (workspace.fs as unknown as Record<string, unknown>)[k] = (mockFs as Record<string, unknown>)[k];
      }
    }
  };
}

// Re-aims are counted where both hosts make them: WorkPool.cancel on the sweep's own key.
const drops = { n: 0 };
const realCancel = WorkPool.prototype.cancel;
WorkPool.prototype.cancel = function (key: string) {
  if (key.endsWith('-sweep')) drops.n++;
  return realCancel.call(this, key);
};
afterAll(() => { WorkPool.prototype.cancel = realCancel; });

/** What the burst produced, in terms both hosts can answer: the same script, the same observables. */
interface Trace {
  atOpen: number;
  duringBurst: number[];
  reaimsDuringBurst: number;
  afterDwell: number[];
  reaims: number;
}

/** The field case: a held Down key posts setCurrentTuple per repeat, then the key comes up. */
async function heldKey(host: Host): Promise<Trace> {
  const atOpen = host.asked.length;
  for (const row of BURST) {
    await host.send({ type: 'setCurrentTuple', tupleIndex: row });
    await host.finish(2);
    await vi.advanceTimersByTimeAsync(KEY_GAP_MS);
  }
  const duringBurst = host.asked.slice(atOpen);
  const reaimsDuringBurst = host.reaims();

  // The key comes up. One dwell later the sweep re-aims on its next pump — but a re-aim only drops
  // the dispatches that have NOT started (docs/loading-architecture.md: sweep-cancels-on-reaim), and
  // at this pool width the settles that carry the pump have already promoted a few of the old aim's.
  // Those stragglers are flushed first; what comes after them is the aim.
  await vi.advanceTimersByTimeAsync(AIM_DWELL_MS + 5);
  await host.finish(4);
  const settledAt = host.asked.length;
  await host.finish(4);
  return { atOpen, duringBurst, reaimsDuringBurst, afterDwell: host.asked.slice(settledAt, settledAt + 4), reaims: host.reaims() };
}

// The other half of "where the user is": the COLUMN. It reaches a host only in a report the webview
// sends, so a click that reports nothing leaves the aim on the column it already had — the field
// case, where a tile clicked in the 5th column of an unloaded row watched column 0 fill instead.
// Both products read the same reports, so the same script must move both. The strip is rearranged
// (['ours', 'gt']) so a host that forwards the display index on aims at 'gt' and fails here too.
// (docs/loading-architecture.md: click-reports-its-column, docs/tuple-matching.md: wire-index-is-original)
async function clickedColumn(host: Host): Promise<{ straggled: number; column: string[] }> {
  await host.send({ type: 'setCurrentModality', modalityOrder: [1, 0], currentDisplayIndex: 0, hiddenModalities: [] });
  const from = host.askedSlots.length;
  for (let i = 0; i < 4; i++) await host.finish(4);
  const after = host.askedSlots.slice(from, from + 16);
  // Reads that had already STARTED cannot be dropped (docs/loading-architecture.md: sweep-cancels-on-reaim),
  // so the old column trails the re-aim by a bounded flush; everything after it is the new aim's.
  const straggled = after.findIndex(slot => slot.startsWith('ours-'));
  return { straggled, column: after.slice(straggled) };
}

describe('the sweep aim is one policy: both hosts answer a held key identically', () => {
  it('drives the same burst through the real provider and the real standalone adapter', async () => {
    const provider = await providerHost();
    const providerTrace = await heldKey(provider);
    const providerClick = await clickedColumn(provider);
    provider.dispose();
    await settle(4);
    vi.useRealTimers();

    const standalone = await standaloneHost();
    const standaloneTrace = await heldKey(standalone);
    const standaloneClick = await clickedColumn(standalone);
    standalone.dispose();
    await settle(4);

    // The whole point of the round: not "both are reasonable" but "both are the same".
    expect(standaloneTrace).toEqual(providerTrace);

    // And the same as ff11b92 pinned for the extension: the burst never re-aims, the key-up does it
    // once, and the cross from (49, gt) is the tile, its row's other modality, then rows 50 and 48.
    for (const trace of [providerTrace, standaloneTrace]) {
      // One slot below the pool width: speculation collectively leaves the user's own arrival a slot
      // (docs/loading-architecture.md: visible-never-starved).
      expect(trace.atOpen).toBe(POOL_WIDTH - 1);
      expect(trace.duringBurst.length).toBeGreaterThan(0);
      // Not one tile at the rows the key flew past: the sweep is still filling outward from where
      // the panel opened, and the cross/remainder walk it is on is the OPEN aim's, not the burst's.
      expect(Math.max(...trace.duringBurst)).toBeLessThan(BURST[0]);
      expect(trace.reaimsDuringBurst).toBe(0);
      expect(trace.afterDwell).toEqual([49, 49, 50, 48]);
      expect(trace.reaims).toBe(1);
    }

    // Same policy, same click: the reported column moves the aim in both, and identically.
    expect(standaloneClick).toEqual(providerClick);
    for (const click of [providerClick, standaloneClick]) {
      expect(click.straggled).toBeLessThanOrEqual(POOL_WIDTH);
      // The symptom, inverted: after the click the sweep spends its reads in the column the click
      // named, not in the one it was already filling.
      expect(click.column.length).toBeGreaterThanOrEqual(16 - POOL_WIDTH);
      expect(click.column.every(slot => slot.startsWith('ours-'))).toBe(true);
      // And in the cross's own order within that column: away from the aimed row 49, forward first
      // on the tie (docs/loading-architecture.md: sweep-cross-then-row-major).
      const nearest = ['ours-50', 'ours-48', 'ours-51', 'ours-47'];
      expect(click.column.filter(slot => nearest.includes(slot))).toEqual(nearest);
    }
  });
});
