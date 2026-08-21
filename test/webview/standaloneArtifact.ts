/**
 * The standalone browser artifact (`dist/standalone/image_compare.html`) as the webview layer sees
 * it: one freshness rule, one build, shared by the Playwright `globalSetup` and the spec that
 * serves the page.
 *
 * Building it inside the spec's `beforeAll` meant every parallel worker ran its own
 * `scripts/build-standalone.mjs` over the SAME output path, so a worker could serve a page another
 * worker was mid-write on. The build therefore happens once, in `globalSetup`, before any worker
 * exists; the spec only asserts. Freshness is a completeness check plus an mtime rule against the
 * build's real inputs, not an `existsSync` — see docs/testing.md, "The standalone artifact".
 *
 * Every function takes the repo root as an argument (defaulting to the real one) so the rule itself
 * can be exercised on a synthetic tree in test/unit/standaloneArtifact.test.ts.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** The single output path every standalone spec serves. */
export const STANDALONE_ARTIFACT = artifactPath(ROOT);

/** What a human must run to produce it by hand. */
export const BUILD_COMMAND = 'npm run build:standalone';

// The files the composed page is built FROM; test/ is deliberately absent (docs/testing.md).
const INPUT_FILES = [
  'scripts/build-standalone.mjs',
  'tsconfig.standalone.json',
  'package.json',
  path.join('dist', 'webview.js'),
];
const INPUT_TREES: Array<{ dir: string; exts: string[] }> = [
  { dir: 'src', exts: ['.ts'] },
  { dir: 'standalone', exts: ['.ts', '.mjs'] },
];

/** Where the build writes, under `root`. */
export function artifactPath(root: string): string {
  return path.join(root, 'dist', 'standalone', 'image_compare.html');
}

/** Collects matching files under `dir`; returns the first directory that could not be listed. */
function walk(dir: string, exts: string[], out: string[]): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return dir;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const bad = walk(full, exts, out);
      if (bad) return bad;
    } else if (exts.some(x => e.name.endsWith(x))) out.push(full);
  }
  return null;
}

/** The input set, plus whatever part of it could not be enumerated (docs/testing.md). */
function scanInputs(root: string): { files: string[]; unreadable: string | null } {
  const files: string[] = [];
  let unreadable: string | null = null;
  for (const rel of INPUT_FILES) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) files.push(full);
  }
  for (const t of INPUT_TREES) {
    const bad = walk(path.join(root, t.dir), t.exts, files);
    if (bad && !unreadable) unreadable = path.relative(root, bad) || t.dir;
  }
  return { files, unreadable };
}

/** Every existing file the artifact is built from, absolute, unordered. */
export function standaloneInputFiles(root: string = ROOT): string[] {
  return scanInputs(root).files;
}

/** The newest build input, or null when none of them exist. */
function newestInput(root: string): { file: string; mtimeMs: number } | null {
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const file of standaloneInputFiles(root)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
  }
  return newest;
}

/** The page's last bytes (standalone/compose.mjs); no partial write can end with them. */
const BUILD_SENTINEL = '</html>';
const SENTINEL_WINDOW = 64;

/** Why the file on disk cannot be a page a build finished writing, or null when nothing says so. */
function artifactDamage(file: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    return `it could not be read (${(err as Error).message})`;
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - SENTINEL_WINDOW)).toString('utf8');
  if (!tail.includes(BUILD_SENTINEL)) {
    return `${bytes.length} bytes not ending in \`${BUILD_SENTINEL}\` — the build that wrote it did not finish`;
  }
  return null;
}

export type ArtifactState =
  | { state: 'missing' }
  | { state: 'corrupt'; detail: string }
  | { state: 'unverifiable'; detail: string }
  | { state: 'stale'; newerInput: string }
  | { state: 'fresh' };

/**
 * Missing, corrupt (present but not a finished page), unverifiable (the inputs cannot be
 * enumerated, so nothing about the artifact is known), stale (some build input is at least as new
 * as the artifact), or fresh.
 *
 * `>=` not `>`: a build reads its inputs before it writes, so an input sharing the artifact's
 * mtime was edited after it. The cost of the tie is one redundant build, never a stale page.
 */
export function standaloneArtifactState(root: string = ROOT): ArtifactState {
  let artifact: fs.Stats;
  try {
    artifact = fs.statSync(artifactPath(root));
  } catch {
    return { state: 'missing' };
  }
  const damage = artifactDamage(artifactPath(root));
  if (damage) return { state: 'corrupt', detail: damage };
  const { unreadable } = scanInputs(root);
  if (unreadable) return { state: 'unverifiable', detail: `${unreadable} could not be listed` };
  const newest = newestInput(root);
  if (newest && newest.mtimeMs >= artifact.mtimeMs) {
    return { state: 'stale', newerInput: path.relative(root, newest.file) };
  }
  if (!newest) return { state: 'unverifiable', detail: 'no build input was found' };
  return { state: 'fresh' };
}

/** Why the artifact cannot be trusted, with the command that fixes it — or null when it can. */
export function describeProblem(status: ArtifactState, artifact: string = STANDALONE_ARTIFACT): string | null {
  let what: string;
  switch (status.state) {
    case 'fresh': return null;
    case 'missing': what = `Standalone artifact missing at ${artifact}.`; break;
    case 'corrupt': what = `Standalone artifact at ${artifact} is CORRUPT: ${status.detail}.`; break;
    case 'unverifiable': what = `Standalone artifact at ${artifact} cannot be verified: ${status.detail}.`; break;
    default: what = `Standalone artifact at ${artifact} is STALE: ${status.newerInput} is newer than it.`;
  }
  return `${what} Run \`${BUILD_COMMAND}\` (the webview globalSetup builds it automatically — this run did not go through it).`;
}

/** The one-clause reason `globalSetup` prints before it rebuilds. */
function shortReason(status: ArtifactState): string {
  switch (status.state) {
    case 'missing': return 'missing';
    case 'corrupt': return `corrupt (${status.detail})`;
    case 'unverifiable': return `unverifiable (${status.detail})`;
    case 'stale': return `stale (${status.newerInput} is newer)`;
    default: return status.state;
  }
}

/**
 * Build the artifact unless it is fresh. Called from `globalSetup`, in the Playwright main
 * process, before any worker starts — the one place a build cannot race a read.
 */
export function ensureStandaloneArtifact(): void {
  const status = standaloneArtifactState();
  if (status.state === 'fresh') return;
  console.log(`[webview globalSetup] standalone artifact ${shortReason(status)} — running \`${BUILD_COMMAND}\``);
  try {
    execSync('node scripts/build-standalone.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    // Reported, not fatal: throwing here would abort the whole webview run (docs/testing.md).
    console.error(`[webview globalSetup] \`${BUILD_COMMAND}\` FAILED (output above) — the standalone specs will fail, naming the missing, corrupt or stale artifact; the rest of the webview layer continues.`);
  }
}

/** Throw with an actionable message unless the artifact on disk is current. Never builds. */
export function assertStandaloneArtifactFresh(): void {
  const problem = describeProblem(standaloneArtifactState());
  if (problem) throw new Error(problem);
}
