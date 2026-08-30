import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import type { ImageCompareProvider } from '../../src/imageCompareProvider';

// Shutting a real provider down inside a unit bed, so nothing it started outlives the test that
// started it. Written for the Windows leg: `provider.dispose()` is synchronous by contract and only
// *starts* the pack write (src/thumbnailService.ts, docs/image-backends.md: thumb-pack-survives-close)
// — `deactivate` is what awaits it, through `flush()`. A bed that skipped that await left two temp
// files being renamed into `globalStorage/thumbnail-cache` while afterAll was rmdir'ing it: harmless
// on POSIX, ENOTEMPTY on Windows. `flush()` now settles the per-entry `.jpg` writes too, so awaiting
// it — not any window this file could pick — is what makes teardown causal. See docs/testing.md
// (Findings) for both halves and for what the drain below does and does not cover. `settleServices`
// is the same rule one level down, for a bed holding a bare ThumbnailService rather than a provider.

/** How long the tree must hold still for teardown to count as quiet — a backstop on the awaits above, never the mechanism. */
const QUIET_MS = 250;
const QUIET_SAMPLES = 10;

/** How long a drain may wait for the shared pool before the bed is declared stuck. */
const DRAIN_DEADLINE_MS = 10_000;

/** The shared work pool every provider schedules through; private in production, and idleness is exactly what a bed must observe. */
function poolOf(provider: ImageCompareProvider): { pending: number; running: number } {
  return (provider as unknown as { pool: { pending: number; running: number } }).pool;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** What a bed needs of a ThumbnailService to settle it; the beds hold it dynamically imported, so this is structural. */
export interface FlushableService {
  flush(): Promise<void>;
}

/**
 * Settle every cache write these services started, before the temp roots they wrote into are
 * removed. The one call that covers both halves — the pack and the per-entry `.jpg` — is `flush()`;
 * a bed that removes its root without it can have a file land inside the `rmSync`.
 */
export async function settleServices(services: readonly FlushableService[]): Promise<void> {
  for (const svc of services) await svc.flush();
}

/** Every path under `root`, with file sizes — the set afterAll's recursive rm walks. */
export function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const here = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.push(`${here}/`); walk(full, here); continue; }
      let size = -1;
      try { size = fs.statSync(full).size; } catch { /* raced away between the listing and the stat */ }
      out.push(`${here}:${size}`);
    }
  };
  walk(root, '');
  return out;
}

/** Resolve once the shared pool has no task queued or running; throws rather than hanging a suite. */
export async function drainWorkPool(provider: ImageCompareProvider): Promise<void> {
  const pool = poolOf(provider);
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  while (pool.pending > 0 || pool.running > 0) {
    if (Date.now() > deadline) {
      throw new Error(`work pool never drained: pending=${pool.pending} running=${pool.running}`);
    }
    await sleep(5);
  }
}

/**
 * Shut `provider` down the way `deactivate` does and assert nothing under `root` moves afterwards.
 * The assertion is the Windows leg's stand-in: a write still in flight here is the ENOTEMPTY there.
 */
export async function tearDownProvider(provider: ImageCompareProvider, root: string): Promise<void> {
  // Drain first, for the one thing a flush cannot reach backwards in time: a generate still running
  // would re-dirty the pack and register a new cache write *after* the flush had settled.
  await drainWorkPool(provider);
  // Then the shutdown order `deactivate` uses (src/extension.ts): flush, dispose. The trailing flush
  // awaits the write dispose() itself queued — the packWrite chain is what makes a later flush wait.
  await provider.flush();
  provider.dispose();
  await provider.flush();

  const settled = treeSnapshot(root);
  for (let i = 0; i < QUIET_SAMPLES; i++) {
    await sleep(QUIET_MS / QUIET_SAMPLES);
    expect(treeSnapshot(root), 'work outlived teardown: the tree changed after the provider was shut down').toEqual(settled);
  }
}
