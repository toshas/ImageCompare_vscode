#!/usr/bin/env node
/**
 * Fails if running a generator writes anywhere git would notice, or if it did not run at all.
 * Placement and liveness, and the leak this was written for: docs/testing.md, "The generated-output rule".
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, WEBVIEW_CMD, webviewEnv } from '../test/dashboard/suiteCommands.mjs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const PROBE = join(RESULTS, 'generated-output-probe.json');

// Each generator in its fastest path-equivalent mode, with `writes` naming the artifact that proves it ran.
const GENERATORS = [
  {
    name: 'dashboard (--reuse)',
    cmd: 'node test/dashboard/generate.mjs --reuse',
    env: {},
    writes: join(repoRoot, 'test', 'dashboard', 'dashboard.html'),
  },
  {
    name: 'webview JSON report (--list)',
    cmd: `${WEBVIEW_CMD} --list --workers=4`,
    env: webviewEnv(PROBE),
    writes: PROBE,
  },
];

/** size:mtime of a repo-relative path, or '-' when absent — makes a rewrite of an already-modified file visible. */
function stamp(rel) {
  try {
    const st = statSync(join(repoRoot, rel));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** Paths git currently reports as changed or untracked, each with its status code and stamp (ignored files are never listed). */
function snapshot() {
  const out = execSync('git status --porcelain --untracked-files=all', {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const rel = line.slice(3);
    map.set(rel, `${line.slice(0, 2)}|${stamp(rel)}`);
  }
  return map;
}

function isIgnored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

mkdirSync(RESULTS, { recursive: true });
// The filesystem's own clock, not this process's: an NFS server may disagree with the local one.
const epochFile = join(RESULTS, '.generated-output-epoch');
writeFileSync(epochFile, '');
const epochMs = statSync(epochFile).mtimeMs;
const before = snapshot();

for (const g of GENERATORS) {
  console.log(`\n$ ${g.cmd}`);
  try {
    execSync(g.cmd, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...g.env } });
  } catch {
    console.log(`  (${g.name} exited non-zero — its output paths are still what we check)`);
  }
}

const after = snapshot();
const leaked = [...after.entries()].filter(([rel, st]) => before.get(rel) !== st);

const idle = [];
for (const g of GENERATORS) {
  let mtimeMs = null;
  try {
    mtimeMs = statSync(g.writes).mtimeMs;
  } catch {
    idle.push(`${g.name}: never wrote ${g.writes}`);
    continue;
  }
  if (mtimeMs < epochMs) idle.push(`${g.name}: ${g.writes} was not rewritten by this run (stale)`);
}

rmSync(PROBE, { force: true });
rmSync(epochFile, { force: true });

if (leaked.length === 0 && idle.length === 0) {
  console.log(`\nOK: ${GENERATORS.length} generator(s) ran and wrote nothing outside an ignored directory.`);
  process.exit(0);
}

if (idle.length > 0) {
  console.error(`\nBLOCKED: ${idle.length} generator(s) produced no fresh output — a run that did not happen proves nothing.\n`);
  for (const line of idle) console.error(`  ${line}`);
  console.error(`
A generator that dies before writing leaves the git listing untouched, so the placement check
below would pass vacuously. Fix the generator, or update its \`writes\` path here if the artifact
legitimately moved. A suite that RUNS AND FAILS is fine — it still emits its report.
`);
}

if (leaked.length > 0) {
  console.error(`\nBLOCKED: ${leaked.length} path(s) a generator created or modified are NOT ignored.\n`);
  for (const [rel, st] of leaked) {
    console.error(`  [${st.slice(0, 2)}] ${rel}${isIgnored(rel) ? '  (ignored — status raced?)' : ''}`);
  }
  console.error(`
A generator must write only where .gitignore already covers, or a \`git add .\` publishes its
output — that is how a Playwright JSON report carrying absolute paths nearly got committed.
Fix the generator's output path (absolute, inside an ignored dir), not the symptom. If the
path is genuinely a deliverable, add it to .gitignore deliberately and say why. See docs/testing.md.
`);
}

process.exit(1);
