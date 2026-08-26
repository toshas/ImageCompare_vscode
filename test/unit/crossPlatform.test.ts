import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { FileType, Uri, workspace } from '../mocks/vscode';
import {
  disambiguateDirectoryNames,
  findDifferingParts,
  matchTuplesWithTrie,
} from '../../src/fileService';
import { ImageCompareProvider } from '../../src/imageCompareProvider';

/**
 * Cross-platform LOGIC tests. These run on macOS but feed Windows-style inputs
 * (backslashes, drive letters, UNC) to prove the path/parsing layer behaves
 * identically regardless of OS. The native/runtime risks (Sharp binaries, FS
 * watcher) are covered by the 3-OS CI matrix, not here.
 */

describe('disambiguateDirectoryNames — POSIX vs Windows parity', () => {
  it('Windows drive-letter paths disambiguate by parent dir', () => {
    const uris = [Uri.file('C:\\data\\exp1\\GT'), Uri.file('C:\\data\\exp2\\GT')];
    const out = disambiguateDirectoryNames(uris);
    expect(out.map((o) => o.name)).toEqual(['exp1/GT', 'exp2/GT']);
  });

  it('produces the same display names for equivalent POSIX paths', () => {
    const win = disambiguateDirectoryNames([
      Uri.file('C:\\data\\exp1\\GT'),
      Uri.file('C:\\data\\exp2\\GT'),
    ]).map((o) => o.name);
    const posix = disambiguateDirectoryNames([
      Uri.file('/data/exp1/GT'),
      Uri.file('/data/exp2/GT'),
    ]).map((o) => o.name);
    expect(win).toEqual(posix);
  });

  it('distinct basenames need no disambiguation on either OS', () => {
    const out = disambiguateDirectoryNames([
      Uri.file('C:\\a\\GT'),
      Uri.file('D:\\b\\PRED'),
    ]);
    expect(out.map((o) => o.name)).toEqual(['GT', 'PRED']);
  });

  it('UNC paths split cleanly (no empty leading segments)', () => {
    const out = disambiguateDirectoryNames([
      Uri.file('\\\\server\\share\\runA\\GT'),
      Uri.file('\\\\server\\share\\runB\\GT'),
    ]);
    expect(out.map((o) => o.name)).toEqual(['runA/GT', 'runB/GT']);
  });
});

describe('findDifferingParts is separator- and OS-independent', () => {
  it('extracts the differing middle regardless of platform', () => {
    expect(findDifferingParts(['img_001_gt.png', 'img_001_pred.png'])).toEqual(['gt', 'pred']);
  });
});

describe('matchTuplesWithTrie case behavior is explicit', () => {
  it('identical basenames match across modalities (exact pass)', () => {
    const files = new Map<string, Array<{ name: string; uri: Uri }>>();
    files.set('GT', [{ name: 'frame01.png', uri: Uri.file('C:\\m\\GT\\frame01.png') }]);
    files.set('RGB', [{ name: 'frame01.png', uri: Uri.file('C:\\m\\RGB\\frame01.png') }]);
    const tuples = matchTuplesWithTrie(files as never, ['GT', 'RGB']);
    expect(tuples).toHaveLength(1);
    expect(tuples[0].files.size).toBe(2);
  });

  it('case-different basenames are treated as distinct (Linux is case-sensitive)', () => {
    // Documents real behavior: on a case-sensitive FS (Linux) these are two
    // different files; matching compares raw basenames, so they do NOT collapse.
    const files = new Map<string, Array<{ name: string; uri: Uri }>>();
    files.set('GT', [
      { name: 'Frame01.png', uri: Uri.file('/m/GT/Frame01.png') },
      { name: 'frame01.png', uri: Uri.file('/m/GT/frame01.png') },
    ]);
    files.set('RGB', [{ name: 'frame01.png', uri: Uri.file('/m/RGB/frame01.png') }]);
    const tuples = matchTuplesWithTrie(files as never, ['GT', 'RGB']);
    // Two reference files => two tuples; the RGB lowercase file matches exactly one.
    expect(tuples).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The hole this file used to have: everything above is naming and matching, so
// `watchedDirs` — URI paths, `/C:/data/exp1/GT` — could be handed straight to node's
// fs on Windows and nothing here would notice. It was: `fs.watch('/C:/...')` resolves
// against the current drive root, making `C:` a path COMPONENT, which NTFS cannot
// hold, so the call threw for every watched dir and the delete backup never armed on
// any Windows release. The census in test/unit/openRollup.test.ts read 0 handles there
// and 3 here, which is the same bug seen from the other end.
//
// Drive letters only, deliberately. A UNC path is NOT pinned here: real vscode puts the server in the
// URI's *authority*, which `watchedDirs` (built from `uri.path`) never carries and this mock's Uri has
// no field for, so a green UNC assertion here would say nothing about a real `\\server\share` tree.
// That gap predates this fix and is wider than the fs seam — `Uri.file(dir).with({scheme})` drops the
// authority for the VS Code watcher's RelativePattern too. See docs/testing.md, Findings.
// (docs/file-watching.md: watched-dirs-are-uri-paths)

// Hoisted above the imports, so the provider's `import * as fs from 'node:fs'` resolves to this.
// Only `watch` and `promises.access` are replaced; every other fs call in the module stays real, and
// `access` lies only for the paths a test has listed.
//
// The second fake platform behaviour in this file, and the same class of trap as the first: a
// `node:fs` call whose verdict differs on Windows. On Windows the probe behind `fs.access`
// (GetFileAttributesW) reports the attributes of a *symbolic link itself*, so a name that is now a
// dangling link reads as PRESENT there; POSIX rejects `access` and `stat` alike for such a name, so
// nothing a Linux runner can put on disk distinguishes a probe that follows the link from one that
// does not. Faking the verdict is the only way to test the difference here.
// (docs/file-watching.md: existence-probes-follow-the-link)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const g = globalThis as unknown as {
    __icWatchCalls: Array<{ path: string; cb: (e: string, f: string) => void }>;
    __icAccessLies: Set<string>;
  };
  g.__icWatchCalls = [];
  g.__icAccessLies = new Set<string>();
  return {
    ...actual,
    default: actual,
    watch: (p: unknown, cb: (e: string, f: string) => void) => {
      g.__icWatchCalls.push({ path: String(p), cb });
      return { on: () => undefined, close: () => undefined };
    },
    promises: {
      ...actual.promises,
      access: async (p: Parameters<typeof actual.promises.access>[0], mode?: number): Promise<void> => {
        if (g.__icAccessLies.has(String(p))) return;
        return actual.promises.access(p, mode);
      },
    },
  };
});

const watchCalls = (): Array<{ path: string; cb: (e: string, f: string) => void }> =>
  (globalThis as unknown as { __icWatchCalls: Array<{ path: string; cb: (e: string, f: string) => void }> }).__icWatchCalls;

/** Paths whose `fs.access` resolves though the bytes are gone — the Windows verdict on a dangling symlink. */
const accessLies = (): Set<string> =>
  (globalThis as unknown as { __icAccessLies: Set<string> }).__icAccessLies;

/** The provider's own `watchDirectory`, plus the panel state it needs and the deletes it reports. */
function watcherBed() {
  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file('/tmp/ic-xplat') } as never);
  const deleted: string[] = [];
  (provider as never as { handleFileDeleted(s: unknown, u: Uri): void }).handleFileDeleted = (_s, u) => { deleted.push(u.path); };
  const state = {
    disposed: false,
    fileWatchers: [] as unknown[],
    nodeWatchers: [] as unknown[],
    watchersByDir: new Map<string, unknown>(),
    webviewReady: true,
    pendingDebugMessages: [] as unknown[],
    panel: { webview: { postMessage: () => undefined } },
  };
  watchCalls().length = 0;
  const watch = (dir: string): void =>
    (provider as never as { watchDirectory(s: unknown, d: string, sc: string, leaf: boolean): void })
      .watchDirectory(state, dir, 'file', true);
  const done = (): void => {
    state.disposed = true;
    provider.dispose();
  };
  return { state, deleted, watch, done };
}

describe('the fs.watch delete backup is fed filesystem paths, not URI paths', () => {
  it('a Windows watched dir reaches node as a drive-rooted path', () => {
    const bed = watcherBed();
    // Exactly what setupFileWatcher iterates: `watchedDirs` holds `img.uri.path`, never a native path.
    bed.watch(Uri.file('C:\\data\\exp1\\GT').path);
    expect(watchCalls()).toHaveLength(1);
    // Node's own Windows path rules applied to the string node was handed: it must name that
    // directory. '/C:/data/exp1/GT' resolves to '\C:\data\exp1\GT' instead, which is what threw.
    expect(path.win32.resolve(watchCalls()[0].path).toLowerCase()).toBe('c:\\data\\exp1\\gt');
    bed.done();
  });

  it('a POSIX watched dir is handed through byte for byte', () => {
    const bed = watcherBed();
    bed.watch('/data/exp1/GT');
    expect(watchCalls()[0].path).toBe('/data/exp1/GT');
    bed.done();
  });

  it('a name that became a dangling link still lands as a delete, though the probe calls it present (Windows)', async () => {
    const bed = watcherBed();
    const dir = Uri.file('C:\\data\\exp1\\GT').path;
    bed.watch(dir);
    // Exactly the string the backup probes: path.join(Uri.file(dir).fsPath, filename).
    accessLies().add(path.join(Uri.file(dir).fsPath, 'frame01.png'));
    try {
      watchCalls()[0].cb('rename', 'frame01.png');
      await new Promise(r => setTimeout(r, 200));
      // A probe that stops at the link takes the *appeared* branch here and the delete is never
      // reported — on Windows only, which is why this file fakes the verdict rather than the disk.
      expect(bed.deleted).toEqual([`${dir}/frame01.png`]);
    } finally {
      accessLies().clear();
      bed.done();
    }
  });

  it('a delete it reports carries the tracked URI, drive-letter case included', async () => {
    const bed = watcherBed();
    const dir = Uri.file('C:\\data\\exp1\\GT').path;
    bed.watch(dir);
    // 'rename' with no such file on disk = the vanish branch, which is what this backup exists for.
    watchCalls()[0].cb('rename', 'frame01.png');
    await new Promise(r => setTimeout(r, 200));
    // NOT a round-trip through fsPath: vscode lowercases the drive letter there, so
    // Uri.file(path.join(dir.fsPath, name)) would report a URI no tracked image URI equals.
    expect(bed.deleted).toEqual([`${dir}/frame01.png`]);
    bed.done();
  });
});

// The other half of the same trap, and the one that shipped to users. `watchedDirs` is keyed in URI
// space and the sweep looks its tracked files up by `img.uri.path.substring(0, lastIndexOf('/'))`.
// Nothing on a POSIX runner can tell those two apart from `path.join`/`fsPath` strings, so a producer
// drifting into filesystem space would miss every lookup, turn every tracked file into a STRAY, and
// put the sweep back on one pooled existence check per FILE — the 7407-task flood test/unit/pollCost
// forbids, degraded silently on Windows only. Windows-shaped URIs make the two spaces differ here.
// (docs/file-watching.md: watched-dirs-are-uri-paths, sweep-derives-deletions-from-listings)

const WIN_BASE = 'C:\\data\\exp1';
const WIN_MODS = ['GT', 'PRED'];
const WIN_ROWS = ['frame01.png', 'frame02.png', 'frame03.png', 'frame04.png'];

/** A sweep bed rooted at a Windows drive letter, with the listings such a tree would return. */
function sweepBed() {
  const baseUri = Uri.file(WIN_BASE);
  const modUris = WIN_MODS.map(m => Uri.file(`${WIN_BASE}\\${m}`));
  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file('/tmp/ic-xplat') } as never);
  const key = `xplat-${Math.random().toString(36).slice(2)}`;
  let pollTasks = 0;
  const pool = (provider as never as { pool: { submit: unknown } }).pool;
  const beforeInstrumentation = pool.submit;
  const original = (pool.submit as (...a: never[]) => unknown).bind(pool);
  (pool as { submit: unknown }).submit = (fn: unknown, opts: { priority: number; key?: string }) => {
    if (opts.key === key) pollTasks++;
    return (original as (...a: unknown[]) => unknown)(fn, opts);
  };

  // The listing a real Windows tree would give, served through the seam the sweep actually calls.
  // No Linux filesystem can hold `C:\...`, so this is the only way to drive the grouping here.
  const listings = new Map<string, Array<[string, FileType]>>([
    [baseUri.path, WIN_MODS.map((m): [string, FileType] => [m, FileType.Directory])],
    ...modUris.map((u): [string, Array<[string, FileType]>] =>
      [u.path, WIN_ROWS.map((n): [string, FileType] => [n, FileType.File])]),
  ]);
  const realReadDirectory = workspace.fs.readDirectory;
  (workspace.fs as { readDirectory: unknown }).readDirectory = async (uri: Uri) => {
    const found = listings.get(uri.path);
    if (!found) throw new Error(`ENOENT ${uri.path}`);
    return found;
  };

  const state = {
    panel: { webview: { postMessage: () => undefined } },
    scanResult: {
      modalities: [...WIN_MODS],
      tuples: WIN_ROWS.map(n => ({
        name: n.replace('.png', ''),
        images: WIN_MODS.map((m, i) => ({ uri: Uri.file(`${WIN_BASE}\\${m}\\${n}`), name: n, modality: WIN_MODS[i] })),
      })),
      mode: 1,
      roots: [baseUri],
      isMultiTupleMode: true,
    },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    deleteSweepRunning: false,
    // Exactly as the provider builds it at open: `baseUri.path` and `img.uri.path`, never a native path.
    watchedDirs: new Set([baseUri.path, ...modUris.map(u => u.path)]),
    baseUri,
    barrenDirs: new Map(),
    adoptingDirs: new Set(),
    modalityDirs: new Map(WIN_MODS.map((m, i) => [m, modUris[i]])),
    recentlyDeleted: [],
    winners: new Map(),
    poolKey: key,
    webviewReady: true,
    pendingDebugMessages: [],
  };
  return {
    state,
    tasks: () => pollTasks,
    sweep: () => (provider as never as { runDeleteSweep(s: unknown): Promise<void> }).runDeleteSweep(state),
    done: () => {
      state.disposed = true;
      (workspace.fs as { readDirectory: unknown }).readDirectory = realReadDirectory;
      (pool as { submit: unknown }).submit = beforeInstrumentation;
      provider.dispose();
    },
  };
}

describe('the existence sweep groups Windows-shaped tracked files by directory', () => {
  it('costs one pooled task per watched dir, not one per file', async () => {
    const bed = sweepBed();
    try {
      await bed.sweep();
      // 1 new-modality-dir sweep + one listing per modality dir. Under a URI-vs-filesystem space
      // mismatch the listings still run and every tracked file ALSO gets its own check: 1 + 2 + 8 = 11
      // here (measured, not guessed — that is what the mutation reports), and 7407 in the field.
      expect(bed.tasks()).toBe(1 + WIN_MODS.length);
    } finally {
      bed.done();
    }
  });
});
