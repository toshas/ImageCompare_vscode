/** Pure poll-cycle decisions (no vscode): barren-dir listing policy, snapshot diffing and rename pairing, shared by the provider's existence sweep and the standalone poll — see docs/file-watching.md. */

import { DeletedEntry, matchDeletedFile } from './watcherLogic';

/** A base-dir child known to hold no images: its directory mtime plus the sweeps spent skipping it (docs/file-watching.md: barren-dirs-memoized). */
export interface BarrenMemo {
  mtime: number;
  sweeps: number;
}

/**
 * The candidate dirs that must be (re-)listed this cycle. A dir is skipped only while its memo's
 * mtime is unchanged AND its sweep budget holds; each skip spends one unit of that budget, since
 * some mounts never advance a directory's mtime (docs/file-watching.md: barren-dirs-memoized).
 */
export function planSweepDirs(
  candidates: ReadonlyArray<{ dir: string; mtime: number }>,
  memos: Map<string, BarrenMemo>,
  recheckSweeps: number
): string[] {
  const toList: string[] = [];
  for (const { dir, mtime } of candidates) {
    const memo = memos.get(dir);
    if (memo && memo.mtime === mtime && memo.sweeps < recheckSweeps) {
      memo.sweeps++;
      continue;
    }
    toList.push(dir);
  }
  return toList;
}

/** Record a listing's outcome: an image-less dir is memoized at this mtime with a fresh budget; one with images forgets its memo (docs/file-watching.md: barren-dirs-memoized). */
export function recordDirListing(memos: Map<string, BarrenMemo>, dir: string, mtime: number, hasImages: boolean): void {
  if (hasImages) memos.delete(dir);
  else memos.set(dir, { mtime, sweeps: 0 });
}

/** Drop memos for dirs no longer present, so a pipeline rotating scratch dirs cannot grow the memo forever. */
export function pruneBarrenMemos(memos: Map<string, BarrenMemo>, liveDirs: ReadonlySet<string>): void {
  for (const dir of [...memos.keys()]) {
    if (!liveDirs.has(dir)) memos.delete(dir);
  }
}

/** One file's poll observation; the fingerprint fields are optional so IO can defer their per-entry cost (docs/file-watching.md: poll-diff-names-first). */
export interface SnapshotEntry {
  name: string;
  mtime?: number;
  size?: number;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Diff two per-directory snapshots: the name-set diff comes first, and fingerprints are consulted
 * only for names present on both sides — a side missing a fingerprint field never yields 'changed',
 * which is what lets a browser IO fetch per-entry fingerprints lazily, after the name diff and
 * never for removed entries (docs/file-watching.md: poll-diff-names-first).
 */
export function diffSnapshots(prev: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): SnapshotDiff {
  const prevByName = new Map(prev.map(e => [e.name, e]));
  const nextNames = new Set(next.map(e => e.name));
  const added = next.filter(e => !prevByName.has(e.name)).map(e => e.name);
  const removed = prev.filter(e => !nextNames.has(e.name)).map(e => e.name);
  const changed: string[] = [];
  for (const entry of next) {
    const before = prevByName.get(entry.name);
    if (!before) continue;
    const mtimeChanged = before.mtime !== undefined && entry.mtime !== undefined && before.mtime !== entry.mtime;
    const sizeChanged = before.size !== undefined && entry.size !== undefined && before.size !== entry.size;
    if (mtimeChanged || sizeChanged) changed.push(entry.name);
  }
  return { added, removed, changed };
}

/** One listing entry as the sweep sees it: a name plus whether the listing typed it a *file* (docs/file-watching.md: sweep-derives-deletions-from-listings). */
export interface ListedEntry {
  name: string;
  isFile: boolean;
}

/** One watched dir's cycle work: names to place as arrivals, tracked names to re-verify as deletions. */
export interface DirSweepPlan {
  added: string[];
  candidates: string[];
}

/**
 * One directory's sweep decisions from the single listing the cycle already performs: `listed`
 * `undefined` means it could not be listed, so every tracked name falls back to its own existence
 * check, and a listed-but-not-file name (a dangling symlink) stays a candidate
 * (docs/file-watching.md: sweep-derives-deletions-from-listings). Candidates are re-verified by the
 * caller before anything is reported (`sweep-reverifies-before-report`).
 */
export function planDirSweep(known: readonly string[], listed: readonly ListedEntry[] | undefined): DirSweepPlan {
  if (!listed) return { added: [], candidates: [...known] };
  const files = listed.filter(e => e.isFile).map(e => ({ name: e.name }));
  const diff = diffSnapshots(known.map(name => ({ name })), files);
  return { added: diff.added, candidates: diff.removed };
}

/**
 * Whether this cycle's pool snapshot is worth a line: anything running or queued is live signal, and
 * an idle pool is worth saying only when it has changed since the last line
 * (docs/loading-architecture.md: idle-poll-logs-nothing-new).
 */
export function shouldLogPoolSnapshot(snapshot: string, busy: boolean, lastLogged: string | undefined): boolean {
  return busy || snapshot !== lastLogged;
}

/** A polled file observed by directory + name; carriers may extend the shape. */
export interface PollEntry {
  dir: string;
  name: string;
}

export interface RenamePairing<T extends PollEntry> {
  renames: Array<{ from: T; to: T }>;
  removed: T[];
  added: T[];
}

/**
 * Pair one cycle's removed/added entries as renames, added entries claiming sequentially through
 * the provider's disambiguator — ambiguity is never guessed (docs/file-watching.md:
 * rename-never-guessed). The atomic diff stands in for the provider's 500ms window: both sides of
 * a same-cycle rename are visible at once, while a cross-cycle one degrades to delete + add.
 */
export function pairRenames<T extends PollEntry>(
  removed: readonly T[],
  added: readonly T[],
  isMultiTuple: boolean
): RenamePairing<T> {
  const pendingRemoved = [...removed];
  const renames: Array<{ from: T; to: T }> = [];
  const leftoverAdded: T[] = [];
  for (const add of added) {
    const entries: DeletedEntry[] = pendingRemoved.map(r => ({ dir: r.dir, filename: r.name }));
    const idx = matchDeletedFile(entries, add.dir, add.name, isMultiTuple);
    if (idx >= 0) {
      renames.push({ from: pendingRemoved[idx], to: add });
      pendingRemoved.splice(idx, 1);
    } else {
      leftoverAdded.push(add);
    }
  }
  return { renames, removed: pendingRemoved, added: leftoverAdded };
}
