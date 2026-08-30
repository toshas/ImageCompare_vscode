import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __resetChannels, __resetConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { TransportBudget } from '../../src/transportBudget';
import { makeSolidPng } from '../fixtures/synthetic';
import { tearDownProvider } from '../helpers/providerQuiesce';

// The contract's own repro, driven end to end on the real provider: `rm -rf` the root of a mode-1
// comparison, let every per-file deletion commit (the scan empties in place), then recreate the
// directory with images. The notice the webview shows is terminal only if this re-adoption really
// happens — the messages asserted here are exactly the ones test/webview/empty-comparison.spec.ts
// feeds the bundle to prove the notice clears, so the two halves meet at this wire.

const tmpRoots: string[] = [];
afterAll(() => { for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true }); });

/** watchedDirs and watchersByDir are keyed in URI-path space (docs/file-watching.md: watched-dirs-are-uri-paths). */
const uriPath = (nativePath: string): string => Uri.file(nativePath).path;

interface Bed {
  provider: ImageCompareProvider;
  state: Record<string, unknown>;
  /** The temp dir afterAll removes: the session tree AND the provider's globalStorage live under it. */
  root: string;
  base: string;
  posts: Array<{ type: string; [k: string]: unknown }>;
}

/** A mode-1 comparison of `tuples` rows over `modalities` columns, every slot filled and watched. */
function makeBed(tuples: number, modalities: number): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-readopt-'));
  tmpRoots.push(root);
  const base = path.join(root, 'session');
  const names = Array.from({ length: modalities }, (_, m) => `mod${m}`);
  const dirs = names.map(n => path.join(base, n));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'globalStorage', 'thumbnail-cache'), { recursive: true });
  const rows = Array.from({ length: tuples }, (_, t) => ({
    name: `img${t}`,
    images: names.map((modality, m) => {
      const file = path.join(dirs[m], `img${t}.png`);
      fs.writeFileSync(file, makeSolidPng(4, 4, [t, m, 0]));
      return { uri: Uri.file(file), name: `img${t}.png`, modality };
    }),
  }));
  const provider = new ImageCompareProvider(
    { globalStorageUri: Uri.file(path.join(root, 'globalStorage')) } as unknown as import('vscode').ExtensionContext
  );
  const posts: Array<{ type: string; [k: string]: unknown }> = [];
  const state = {
    panel: { webview: { postMessage: (m: { type: string }) => { posts.push(m); } } },
    scanResult: { modalities: names, tuples: rows, mode: 1, roots: [Uri.file(base)], isMultiTupleMode: true },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    deleteSweepRunning: false,
    watchedDirs: new Set([base, ...dirs].map(uriPath)),
    // Real records, because their ABSENCE is what makes unwatchModalityDir return before it drops the
    // dir from watchedDirs: a bed without them keeps the leaf listing alive and re-adopts through a
    // route production does not have, which is how this whole scenario reads healthy when it is not.
    watchersByDir: new Map(dirs.map(d => [uriPath(d), { fsw: { dispose() { /* nothing real to release */ } } }])),
    fileWatchers: [],
    nodeWatchers: [],
    baseUri: Uri.file(base),
    barrenDirs: new Map(),
    adoptingDirs: new Set(),
    modalityDirs: new Map(),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    poolKey: `readopt-${Math.random().toString(36).slice(2)}`,
    webviewReady: true,
    pendingDebugMessages: [],
    imageLoadKeys: new Set(),
    heldImagePosts: new Map(),
    lastTupleSwitchAt: 0,
    transport: new TransportBudget(8 * 1024 * 1024),
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
  };
  return { provider, state, root, base, posts };
}

const runSweep = (bed: Bed) =>
  (bed.provider as unknown as { runDeleteSweep(s: unknown): Promise<void> }).runDeleteSweep(bed.state);

/** Past the 500ms rename window, so every pending delete has committed. */
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));

const scanOf = (bed: Bed) => bed.state.scanResult as { tuples: Array<{ name: string; images: unknown[] }>; modalities: string[] };
const types = (bed: Bed): string[] => bed.posts.filter(p => p.type !== '_debug').map(p => p.type);

// This bed is the only unit bed that gives the provider a real `thumbnail-cache` directory, so it is
// the only one whose shutdown write has somewhere to land — which is why the Windows leg failed here
// and nowhere else. tearDownProvider asserts the write is already done when it returns.
async function finish(bed: Bed): Promise<void> {
  (bed.state as { disposed: boolean }).disposed = true;
  await tearDownProvider(bed.provider, bed.root);
}

/** Delete the root and let every per-file removal commit, which empties the scan in place. */
async function emptyByDeletingRoot(bed: Bed): Promise<void> {
  await runSweep(bed);
  fs.rmSync(bed.base, { recursive: true, force: true });
  await runSweep(bed);
  await settle();
}

/** Recreate the root with `modalities` dirs of `files` images each — the job's next run. */
function recreate(bed: Bed, modalities: number, files: number): void {
  for (let m = 0; m < modalities; m++) {
    const dir = path.join(bed.base, `mod${m}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < files; f++) {
      fs.writeFileSync(path.join(dir, `img${f}.png`), makeSolidPng(4, 4, [f + 9, m, 3]));
    }
  }
}

describe('a mode-1 root deleted and recreated (real ImageCompareProvider)', () => {
  beforeEach(() => { __resetConfig(); __resetChannels(); });
  afterEach(() => { __resetConfig(); __resetChannels(); });

  it('empties the scan when its root goes, then re-adopts the column and rows when it comes back', async () => {
    const bed = makeBed(2, 1);
    await emptyByDeletingRoot(bed);
    expect(scanOf(bed).tuples).toHaveLength(0);
    expect(scanOf(bed).modalities).toHaveLength(0);

    bed.posts.length = 0;
    recreate(bed, 1, 2);
    await runSweep(bed);
    await settle(300);

    // The scan is live again...
    expect(scanOf(bed).modalities).toEqual(['mod0']);
    expect(scanOf(bed).tuples.map(t => t.name)).toEqual(['img0', 'img1']);
    // ...and the webview was told, in the order its handlers need: the column, then its rows.
    expect(types(bed).filter(t => t === 'modalityAdded' || t === 'tupleAdded'))
      .toEqual(['modalityAdded', 'tupleAdded', 'tupleAdded']);
    // The root's return edge precedes the content, so the notice never re-raises behind it.
    expect(types(bed).indexOf('rootMissing')).toBeLessThan(types(bed).indexOf('modalityAdded'));
    expect(bed.posts.find(p => p.type === 'rootMissing')).toEqual({ type: 'rootMissing', path: null });
    await finish(bed);
  });

  it('re-arms a watcher for every re-adopted directory', async () => {
    const bed = makeBed(2, 2);
    await emptyByDeletingRoot(bed);
    const watched = bed.state.watchedDirs as Set<string>;
    expect([...watched]).toEqual([uriPath(bed.base)]); // only the base survives (watchers-released-with-modality)

    recreate(bed, 2, 1);
    await runSweep(bed);
    await settle(300);

    expect(scanOf(bed).modalities).toEqual(['mod0', 'mod1']);
    // A column with no watcher is deaf until the panel is reopened (docs/file-watching.md: watched-dirs-have-watchers).
    for (const m of ['mod0', 'mod1']) expect(watched.has(uriPath(path.join(bed.base, m)))).toBe(true);
    await finish(bed);
  });

  it('adds nothing a second time when the next sweep sees the same recreated tree', async () => {
    const bed = makeBed(1, 1);
    await emptyByDeletingRoot(bed);
    recreate(bed, 1, 1);
    await runSweep(bed);
    await settle(300);
    bed.posts.length = 0;

    await runSweep(bed);
    await settle(300);

    expect(types(bed)).not.toContain('modalityAdded');
    expect(types(bed)).not.toContain('tupleAdded');
    expect(scanOf(bed).modalities).toEqual(['mod0']);
    expect(scanOf(bed).tuples).toHaveLength(1);
    await finish(bed);
  });
});
