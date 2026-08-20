/**
 * The debug sink both products log through: cached flags, an injected line sink, and lines stamped
 * with ms since the clock was reset. No vscode and no node imports — the extension wires a
 * `vscode.OutputChannel` in `debugChannel.ts`, the standalone wires the browser console.
 * See docs/testing.md ("Debug logging") and docs/standalone.md.
 */

/** Receives one already-formatted line (prefix, tag and text included). */
export type DebugSink = (line: string) => void;

/** Which cache tier answered a `getThumbnail` call — the rollup histogram's key space. */
export type ThumbTier = 'memory' | 'pack' | 'disk' | 'generated';

export interface TierStat {
  count: number;
  ms: number;
  bytes: number;
}

export type TierStats = Record<ThumbTier, TierStat>;

/** The one-off packfile read every concurrent `getThumbnail` shares, and the waiting it caused. */
export interface PackLoadStat {
  /** Shared reads performed (at most one per service instance). */
  count: number;
  /** Wall ms of those reads, measured where the file is actually read. */
  ms: number;
  bytes: number;
  /** Callers that were blocked behind a read already in flight. */
  blocked: number;
  /** Their summed wait — the figure that used to be smeared across the tiers. */
  waitedMs: number;
}

export const THUMB_TIERS: readonly ThumbTier[] = ['memory', 'pack', 'disk', 'generated'];

/** Marks the open path records; timestamps are `Date.now()`, everything else a count or ms (docs/loading-architecture.md: open-spans-account-for-the-whole-open). */
export interface OpenMarks {
  startedAt: number;
  scanDoneAt: number;
  watchersAt: number;
  watchersDoneAt: number;
  htmlAt: number;
  readyAt: number;
  initAt: number;
  initPostedAt: number;
  sweepAt: number;
  /** Image files the scan handed the matcher. */
  scanFiles: number;
  /** Wall ms inside the matcher — the nested part of the scan span. */
  matchMs: number;
  watchedDirs: number;
  /** Serialized `init` payload size, and what measuring it cost (debug-only overhead inside the init span). */
  initBytes: number;
  initSizingMs: number;
  tuples: number;
  modalities: number;
}

/** A trace with only its first mark taken; the open fills the rest in order. */
export function beginOpenMarks(startedAt: number): OpenMarks {
  return {
    startedAt,
    scanDoneAt: startedAt,
    watchersAt: startedAt,
    watchersDoneAt: startedAt,
    htmlAt: startedAt,
    readyAt: startedAt,
    initAt: startedAt,
    initPostedAt: startedAt,
    sweepAt: startedAt,
    scanFiles: 0,
    matchMs: 0,
    watchedDirs: 0,
    initBytes: 0,
    initSizingMs: 0,
    tuples: 0,
    modalities: 0
  };
}

/** One-line open rollup; `other` is the wall time no marked span claims (docs/loading-architecture.md: open-spans-account-for-the-whole-open). */
export function formatOpenRollup(m: OpenMarks): string {
  const scanMs = m.scanDoneAt - m.startedAt;
  const watchersMs = m.watchersDoneAt - m.watchersAt;
  const bootMs = m.readyAt - m.htmlAt;
  const initMs = m.initPostedAt - m.initAt;
  const toSweepMs = m.sweepAt - m.initPostedAt;
  const totalMs = m.sweepAt - m.startedAt;
  const otherMs = totalMs - (scanMs + watchersMs + bootMs + initMs + toSweepMs);
  const ms = (n: number): number => Math.round(n);
  return `open ${ms(totalMs)}ms`
    + ` scan=${ms(scanMs)}ms/${m.scanFiles}f(match=${ms(m.matchMs)}ms)`
    + ` watchers=${ms(watchersMs)}ms/${m.watchedDirs}dirs`
    + ` boot=${ms(bootMs)}ms`
    + ` init=${ms(initMs)}ms(sizing ${ms(m.initSizingMs)}ms)/${formatBytes(m.initBytes)}`
    + ` grid=${m.tuples}x${m.modalities}`
    + ` toSweep=${ms(toSweepMs)}ms`
    + ` other=${ms(otherMs)}ms`;
}

let enabled = false;
let verbose = false;
let sink: DebugSink | undefined;
let originMs = Date.now();

/** Point every later elapsed stamp at now — the host calls this once, at activation/boot. */
export function resetDebugClock(): void {
  originMs = Date.now();
}

/** Install (or clear) the flags and sink; the host re-applies this whenever the setting changes. */
export function configureDebugLog(opts: { enabled: boolean; verbose?: boolean; sink?: DebugSink }): void {
  enabled = opts.enabled === true;
  verbose = enabled && opts.verbose === true;
  sink = enabled ? opts.sink : undefined;
}

/** The one flag every instrumentation site checks before doing any work at all. */
export function debugEnabled(): boolean {
  return enabled;
}

/** Per-item detail (one line per thumbnail, per message); rollups log at `debugEnabled` instead. */
export function debugVerboseEnabled(): boolean {
  return verbose;
}

/** `+12345ms` — ms since the clock was reset, the prefix on every debug line. */
export function formatElapsed(ms: number): string {
  return `+${Math.max(0, Math.round(ms))}ms`;
}

/** Compact byte size for log lines: B under 1 KB, then KB/MB/GB at one decimal. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0B';
  const n = Math.max(0, bytes);
  if (n < 1024) return `${Math.round(n)}B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

function write(tag: string, text: string): void {
  sink?.(`${formatElapsed(Date.now() - originMs)} ${tag} ${text}`);
}

/** Log a line, building its text only when debug is on (docs/loading-architecture.md: debug-off-costs-nothing). */
export function debug(tag: string, build: () => string): void {
  if (!enabled) return;
  write(tag, build());
}

/** Like `debug`, but only at verbose level — the per-item firehose. */
export function debugVerbose(tag: string, build: () => string): void {
  if (!verbose) return;
  write(tag, build());
}

/** A diagnostic must never be the thing that throws: BigInt and cycles fall back to String(). */
function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/** The variadic console-shaped form kept for `fileService`'s matcher trace; joins args with spaces. */
export function debugWrite(tag: string, args: readonly unknown[]): void {
  if (!enabled) return;
  write(tag, args.map(formatArg).join(' '));
}

export function emptyTierStats(): TierStats {
  return {
    memory: { count: 0, ms: 0, bytes: 0 },
    pack: { count: 0, ms: 0, bytes: 0 },
    disk: { count: 0, ms: 0, bytes: 0 },
    generated: { count: 0, ms: 0, bytes: 0 }
  };
}

/** Per-tier delta between two cumulative snapshots — how a sweep reports only its own thumbnails. */
export function diffTierStats(before: TierStats, after: TierStats): TierStats {
  const out = emptyTierStats();
  for (const tier of THUMB_TIERS) {
    out[tier] = {
      count: after[tier].count - before[tier].count,
      ms: after[tier].ms - before[tier].ms,
      bytes: after[tier].bytes - before[tier].bytes
    };
  }
  return out;
}

export function emptyPackLoadStat(): PackLoadStat {
  return { count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 };
}

/** Delta between two cumulative snapshots, so a second sweep does not re-report the first one's read. */
export function diffPackLoadStat(before: PackLoadStat, after: PackLoadStat): PackLoadStat {
  return {
    count: after.count - before.count,
    ms: after.ms - before.ms,
    bytes: after.bytes - before.bytes,
    blocked: after.blocked - before.blocked,
    waitedMs: after.waitedMs - before.waitedMs
  };
}

/** `packLoad=1x612ms/1.4MB blocked=83/8118ms` — one shared read, told apart from 83 slow ones (docs/loading-architecture.md: shared-waits-are-not-per-item-work). */
export function formatPackLoad(stat: PackLoadStat): string {
  if (stat.count === 0) return 'packLoad=0';
  return `packLoad=${stat.count}x${Math.round(stat.ms)}ms/${formatBytes(stat.bytes)} blocked=${stat.blocked}/${Math.round(stat.waitedMs)}ms`;
}

/** One-line tier histogram: `memory=0 pack=180/1.4MB/210ms disk=2/9.0KB/8ms generated=48/…`; each `ms` is per-item work only (docs/loading-architecture.md: shared-waits-are-not-per-item-work). */
export function formatTierStats(stats: TierStats): string {
  return THUMB_TIERS
    .map(tier => {
      const s = stats[tier];
      return s.count === 0 ? `${tier}=0` : `${tier}=${s.count}/${formatBytes(s.bytes)}/${Math.round(s.ms)}ms`;
    })
    .join(' ');
}

/** Throughput for a sweep rollup; zero-length sweeps report 0 rather than Infinity. */
export function itemsPerSecond(items: number, ms: number): string {
  if (ms <= 0) return '0.0';
  return (items / (ms / 1000)).toFixed(1);
}
