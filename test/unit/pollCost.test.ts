import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { Priority, WorkPool } from '../../src/workPool';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL existence sweep, because the defect is what one cycle COSTS. Reported live from a
// 746-tuple x 10-modality comparison on NFS: `queued=[...,7407,...]` — one pooled fs.access task per
// tracked file, every 10s, while ~6000 thumbnails waited behind them. The same cycle already reads
// every directory, so the deletion candidates are derivable from the listing it has in hand.
// (docs/file-watching.md: sweep-derives-deletions-from-listings)

// Hoisted above the imports, so the provider's `import * as fs from 'node:fs'` resolves to this. Only
// `promises.access` is replaced, and only for the paths a test has explicitly listed as lying: every
// other fs call in the module — this file's own mkdtemp/symlink/rm included — stays real.
//
// The lie IS the platform. On Windows the probe behind `fs.access` (GetFileAttributesW) reports the
// attributes of a *symbolic link itself*, so a tracked file replaced by a dangling link reads as
// PRESENT there while its bytes are unreachable; POSIX rejects `access` and `stat` alike for such a
// link, which is exactly why C3b above passes on Linux against code that fails on Windows CI. Faking
// the probe's verdict — not the filesystem, which stays real, symlink and all — is the only way this
// runner can tell a probe that follows the link from one that does not.
// (docs/file-watching.md: existence-probes-follow-the-link)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const g = globalThis as unknown as { __icAccessLies: Set<string> };
  g.__icAccessLies = new Set<string>();
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      access: async (p: Parameters<typeof actual.promises.access>[0], mode?: number): Promise<void> => {
        if (g.__icAccessLies.has(String(p))) return;
        return actual.promises.access(p, mode);
      },
    },
  };
});

/** Paths whose `fs.access` resolves though the bytes are gone — the Windows verdict on a dangling symlink. */
const accessLies = (): Set<string> => (globalThis as unknown as { __icAccessLies: Set<string> }).__icAccessLies;

const CHANNEL = 'ImageCompare';
const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

// Two spaces meet in this bed and they are NOT the same string on Windows. `watchedDirs` and every
// tracked `img.uri.path` are URI paths (`/C:/Users/.../mod0`), which is what the provider builds them
// from; `path.join` and the debug log's `uri.fsPath` are filesystem paths (`c:/Users/.../mod0`). A bed
// that hand-built `watchedDirs` from `path.join` made every tracked file a *stray* on Windows, and the
// sweep silently degraded to one pooled task per FILE — the exact flood this suite exists to forbid,
// invisible because the bed lied rather than because the provider did.
const uriPath = (nativePath: string): string => Uri.file(nativePath).path;
/** A tracked file as the delete log names it: the provider prints `uri.fsPath`, so the test must too. */
const asLogged = (nativePath: string): string => Uri.file(nativePath).fsPath;

interface Bed {
  provider: ImageCompareProvider;
  state: Record<string, unknown>;
  base: string;
  dirs: string[];
  files: string[];
  /** Everything the sweep posted to this panel's webview, in order. */
  posts: Array<{ type: string; [k: string]: unknown }>;
}

/** A mode-1 comparison of `tuples` rows over `modalities` columns, every slot filled and known. */
function makeBed(tuples: number, modalities: number): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pollcost-'));
  tmpRoots.push(root);
  const base = path.join(root, 'session');
  const names = Array.from({ length: modalities }, (_, m) => `mod${m}`);
  const dirs = names.map(n => path.join(base, n));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const files: string[] = [];
  const rows = Array.from({ length: tuples }, (_, t) => ({
    name: `img${t}`,
    images: names.map((modality, m) => {
      const file = path.join(dirs[m], `img${t}.png`);
      fs.writeFileSync(file, makeSolidPng(4, 4, [t, m, 0]));
      files.push(file);
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
    baseUri: Uri.file(base),
    barrenDirs: new Map(),
    adoptingDirs: new Set(),
    modalityDirs: new Map(names.map((n, m) => [n, Uri.file(dirs[m])])),
    recentlyDeleted: [],
    winners: new Map(),
    poolKey: `pollcost-${Math.random().toString(36).slice(2)}`,
    webviewReady: true,
    pendingDebugMessages: []
  };
  return { provider, state, base, dirs, files, posts };
}

const runSweep = (bed: Bed) =>
  (bed.provider as unknown as { runDeleteSweep(s: unknown): Promise<void> }).runDeleteSweep(bed.state);

// The pool is a process-wide singleton shared by every panel, so the counter is keyed by the
// panel's pool key — one instrumentation, counted per bed.
const pollTasksByKey = new Map<string, number>();
let instrumented = false;

/** Count the POLL-priority tasks one cycle submits — the number the field log showed at 7407. */
function countPollTasks(bed: Bed): () => number {
  const key = bed.state.poolKey as string;
  if (!instrumented) {
    const pool = (bed.provider as unknown as { pool: WorkPool }).pool;
    const original = pool.submit.bind(pool);
    (pool as unknown as { submit: WorkPool['submit'] }).submit = <T>(fn: () => Promise<T>, opts: { priority: Priority; key?: string }) => {
      if (opts.priority === Priority.POLL && opts.key) pollTasksByKey.set(opts.key, (pollTasksByKey.get(opts.key) ?? 0) + 1);
      return original(fn, opts);
    };
    instrumented = true;
  }
  pollTasksByKey.set(key, 0);
  return () => pollTasksByKey.get(key) ?? 0;
}

function finish(bed: Bed): void {
  (bed.state as { disposed: boolean }).disposed = true; // the 500ms rename window must not outlive the test
  bed.provider.dispose();
}

/** The root-existence edges this panel posted — the only messages that name the comparison's folder. */
function rootPosts(bed: Bed): Array<{ type: string; [k: string]: unknown }> {
  return bed.posts.filter(m => m.type === 'rootMissing');
}

function deleteLines(): string[] {
  return __channelLines(CHANNEL).filter(l => l.includes('poll delete detected'));
}

describe('existence-sweep cost (real ImageCompareProvider)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    initDebugLog();
  });

  afterEach(() => {
    accessLies().clear();
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('a steady-state cycle costs one pooled task per watched directory, not one per file', async () => {
    const bed = makeBed(8, 3); // 24 files across 3 modality dirs
    const tasks = countPollTasks(bed);
    await runSweep(bed);
    // 1 base-dir sweep + one listing per modality dir; nothing vanished, so nothing is re-verified.
    expect(tasks()).toBe(4);
    finish(bed);
  });

  it('the cycle cost does not grow with the number of files (the 7407-task flood)', async () => {
    const small = makeBed(2, 3);
    const large = makeBed(40, 3); // 120 files in the same 3 dirs
    const smallTasks = countPollTasks(small);
    const largeTasks = countPollTasks(large);
    await runSweep(small);
    await runSweep(large);
    expect(largeTasks()).toBe(smallTasks());
    finish(small);
    finish(large);
  });

  it('a real deletion is still detected, and only for the file that went', async () => {
    const bed = makeBed(4, 2);
    await runSweep(bed);
    fs.rmSync(bed.files[3]);
    await runSweep(bed);
    expect(deleteLines()).toHaveLength(1);
    expect(deleteLines()[0]).toContain(asLogged(bed.files[3]));
    finish(bed);
  });

  it('a modality directory that cannot be listed still reports its files gone (C3a)', async () => {
    const bed = makeBed(3, 2);
    await runSweep(bed);
    fs.rmSync(bed.dirs[1], { recursive: true, force: true });
    await runSweep(bed);
    const lines = deleteLines();
    expect(lines).toHaveLength(3);
    for (const f of bed.files.filter(f => f.startsWith(bed.dirs[1] + path.sep))) {
      expect(lines.some(l => l.includes(asLogged(f)))).toBe(true);
    }
    finish(bed);
  });

  it('an unlistable directory whose files are all still there reports nothing, and falls back per file', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const bed = makeBed(3, 2);
    await runSweep(bed);
    fs.chmodSync(bed.dirs[1], 0o300); // traversable (access works) but not readable (readdir fails)
    try {
      fs.readdirSync(bed.dirs[1]);
      fs.chmodSync(bed.dirs[1], 0o755);
      finish(bed);
      return; // running with an override that ignores mode bits (root/CI container): nothing to pin
    } catch { /* as intended: the listing fails while the files remain reachable */ }
    const tasks = countPollTasks(bed);
    await runSweep(bed);
    fs.chmodSync(bed.dirs[1], 0o755);
    // Exactly that directory's three files fall back to their own check; the other dir stays at one.
    expect(tasks()).toBe(1 + 2 + 3);
    expect(deleteLines()).toHaveLength(0);
    finish(bed);
  });

  it('a tracked file under no listed directory keeps its own existence check', async () => {
    const bed = makeBed(2, 1);
    // No listing pass covers this dir, so the per-file fallback is the only thing that can see it.
    (bed.state.watchedDirs as Set<string>).delete(uriPath(bed.dirs[0]));
    await runSweep(bed);
    fs.rmSync(bed.files[0]);
    await runSweep(bed);
    expect(deleteLines().some(l => l.includes(asLogged(bed.files[0])))).toBe(true);
    finish(bed);
  });

  it('a tracked file that became a dangling symlink is reported gone, though its name is still listed (C3b)', async () => {
    const bed = makeBed(2, 1);
    await runSweep(bed);
    const victim = bed.files[1];
    const target = path.join(path.dirname(victim), 'target-that-goes-away.png');
    fs.writeFileSync(target, makeSolidPng(4, 4, [9, 9, 9]));
    fs.rmSync(victim);
    fs.symlinkSync(target, victim);
    fs.rmSync(target); // the link survives in the listing; only its target is gone
    expect(fs.readdirSync(path.dirname(victim))).toContain(path.basename(victim));
    await runSweep(bed);
    expect(deleteLines().some(l => l.includes(asLogged(victim)))).toBe(true);
    finish(bed);
  });

  // C3b as Windows runs it. Same real dangling symlink; the only fake is the probe's verdict, which
  // there reports the link and not its target. Without that the sweep's existence checks are
  // indistinguishable on this runner — `access` and `stat` both reject — and the deletion goes
  // unreported on Windows only. The other direction (a candidate that is really still there must NOT
  // be reported) is pinned by the two tests above, which run under this same mock with nothing lying.
  it('a dangling symlink whose existence probe reports the link, not its target (Windows), is still reported gone', async () => {
    const bed = makeBed(2, 1);
    await runSweep(bed);
    const victim = bed.files[1];
    const target = path.join(path.dirname(victim), 'target-that-goes-away.png');
    fs.writeFileSync(target, makeSolidPng(4, 4, [9, 9, 9]));
    fs.rmSync(victim);
    fs.symlinkSync(target, victim);
    fs.rmSync(target);
    // Exactly what the provider probes: the tracked URI's fsPath.
    accessLies().add(Uri.file(victim).fsPath);
    await runSweep(bed);
    expect(deleteLines().some(l => l.includes(asLogged(victim)))).toBe(true);
    // The survivor of the same directory is untouched: a probe that follows the link still finds it.
    expect(deleteLines().some(l => l.includes(asLogged(bed.files[0])))).toBe(false);
    finish(bed);
  });

  // The reported bug: `rm -rf` on the comparison's root produced only N per-file deletions, so nothing
  // could tell the user WHICH fact had happened — the folder is gone, not merely emptied.
  it('the comparison root going away is reported by name, once, not once per cycle', async () => {
    const bed = makeBed(2, 2);
    await runSweep(bed);
    expect(rootPosts(bed)).toHaveLength(0);

    fs.rmSync(bed.base, { recursive: true, force: true });
    await runSweep(bed);
    expect(rootPosts(bed)).toEqual([{ type: 'rootMissing', path: Uri.file(bed.base).fsPath }]);

    // An edge, not a heartbeat: the panel is already showing the notice.
    await runSweep(bed);
    expect(rootPosts(bed)).toHaveLength(1);
    finish(bed);
  });

  // These directories are experiment outputs; they come back, and the base dir stays watched
  // (docs/file-watching.md: watchers-released-with-modality), so the notice must clear itself.
  it('the root coming back clears the notice, before any content is re-adopted', async () => {
    const bed = makeBed(2, 2);
    await runSweep(bed);
    fs.rmSync(bed.base, { recursive: true, force: true });
    await runSweep(bed);
    expect(rootPosts(bed)).toHaveLength(1);

    fs.mkdirSync(bed.base, { recursive: true }); // back, still empty: nothing to adopt yet
    await runSweep(bed);
    expect(rootPosts(bed).map(m => m.path)).toEqual([Uri.file(bed.base).fsPath, null]);
    finish(bed);
  });

  it('a root that merely cannot be listed reports nothing — unreadable is not gone', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const bed = makeBed(2, 2);
    await runSweep(bed);
    fs.chmodSync(bed.base, 0o300); // traversable, so stat still resolves; not readable, so the listing fails
    try {
      fs.readdirSync(bed.base);
      fs.chmodSync(bed.base, 0o755);
      finish(bed);
      return; // running with an override that ignores mode bits (root/CI container): nothing to pin
    } catch { /* as intended: the listing fails while the directory is plainly still there */ }
    await runSweep(bed);
    fs.chmodSync(bed.base, 0o755);
    expect(rootPosts(bed)).toHaveLength(0);
    finish(bed);
  });
});
