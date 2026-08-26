#!/usr/bin/env node
/**
 * Feature-coverage dashboard generator.
 *
 * Runs the three test suites with JSON reporters, correlates each result with
 * the feature catalog (features.json), and emits:
 *   - test/dashboard/dashboard.html  (colored, grouped, with a summary)
 *
 * Status per feature:
 *   green  = covered and ALL mapped tests pass
 *   red    = covered but a mapped test FAILS
 *   gray   = no test mapped yet (an honest gap)
 *   yellow = mapped to a test title that wasn't found (stale mapping)
 *
 * Usage:
 *   node test/dashboard/generate.mjs           # run suites, then generate
 *   node test/dashboard/generate.mjs --reuse   # reuse existing test-results/*.json
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Paths + the webview command live in suiteCommands.mjs so the generated-output checker
// probes this exact wiring rather than a copy of it (assertAbsolute runs on import).
import { ROOT, RESULTS, UNIT_JSON, WEBVIEW_JSON, INTEGRATION_JSON, WEBVIEW_CMD, webviewEnv } from './suiteCommands.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reuse = process.argv.includes('--reuse');

mkdirSync(RESULTS, { recursive: true });

function run(cmd, env = {}) {
  console.log(`\n$ ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  } catch {
    // Test failures are expected to surface in the report; keep going.
    console.log('  (suite reported failures — captured in JSON)');
  }
}

/** Run a command and write its stdout to `outFile` (used for vitest, whose
 *  --outputFile is unreliable under execSync). stderr is inherited for logs. */
function runCaptureStdout(cmd, outFile, env = {}) {
  console.log(`\n$ ${cmd}`);
  let out = '';
  try {
    out = execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch (e) {
    // Non-zero exit (failing tests) still produces JSON on stdout.
    out = (e.stdout || '').toString();
  }
  if (out.trim()) writeFileSync(outFile, out);
}

if (!reuse) {
  run('npm run compile');
  // Start clean so a suite that fails to emit JSON is obvious (not a stale file).
  for (const p of [UNIT_JSON, WEBVIEW_JSON, INTEGRATION_JSON]) {
    if (existsSync(p)) rmSync(p);
  }
  const checked = (label, p) => {
    if (!existsSync(p)) console.log(`  ⚠️  ${label}: no JSON written at ${p}`);
  };
  runCaptureStdout('npx vitest run --config test/vitest.config.ts --reporter=json', UNIT_JSON);
  checked('unit', UNIT_JSON);
  run(WEBVIEW_CMD, webviewEnv(WEBVIEW_JSON));
  checked('webview', WEBVIEW_JSON);
  run('npm run test:integration', { IC_JSON_OUT: INTEGRATION_JSON });
  checked('integration', INTEGRATION_JSON);
}

// --- parse each suite's JSON into a list of { title, ok } ------------------

function safeRead(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Vitest (jest-style) json → flat results. */
function parseVitest(json) {
  const out = [];
  if (!json?.testResults) return out;
  for (const file of json.testResults) {
    for (const a of file.assertionResults || []) {
      out.push({ title: a.fullName || a.title, ok: a.status === 'passed' });
    }
  }
  return out;
}

/** Playwright json → flat results (walk nested suites). */
function parsePlaywright(json) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      out.push({ title: spec.title, ok: !!spec.ok });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const s of json?.suites || []) walk(s);
  return out;
}

/** Mocha json → flat results. */
function parseMocha(json) {
  const out = [];
  for (const t of json?.passes || []) out.push({ title: t.fullTitle || t.title, ok: true });
  for (const t of json?.failures || []) out.push({ title: t.fullTitle || t.title, ok: false });
  return out;
}

const suites = {
  unit: { results: parseVitest(safeRead(UNIT_JSON)), present: !!safeRead(UNIT_JSON) },
  webview: { results: parsePlaywright(safeRead(WEBVIEW_JSON)), present: !!safeRead(WEBVIEW_JSON) },
  integration: { results: parseMocha(safeRead(INTEGRATION_JSON)), present: !!safeRead(INTEGRATION_JSON) },
};

// --- correlate features with results ---------------------------------------

function lookup(suite, match) {
  const s = suites[suite];
  // "missing" (suite emitted no JSON — incomplete run) is not "stale" (suite ran, title gone).
  if (!s || !s.present) return { found: false, ok: false, missing: true };
  const hit = s.results.find((r) => r.title && r.title.includes(match));
  return hit ? { found: true, ok: hit.ok } : { found: false, ok: false };
}

const catalog = JSON.parse(readFileSync(join(__dirname, 'features.json'), 'utf8'));

const counts = { green: 0, red: 0, gray: 0, yellow: 0 };
const staleRows = [];
const areas = catalog.areas.map((area) => {
  const features = area.features.map((f) => {
    let status;
    const detail = [];
    if (!f.tests || f.tests.length === 0) {
      status = 'gray';
    } else {
      const looked = f.tests.map((t) => ({ ...t, ...lookup(t.suite, t.match) }));
      detail.push(...looked);
      if (looked.some((l) => !l.found)) status = 'yellow';
      else if (looked.every((l) => l.ok)) status = 'green';
      else status = 'red';
      // A mapping whose suite RAN but whose title is gone is registry rot — fail the build on it.
      for (const l of looked) {
        if (!l.found && !l.missing) staleRows.push(`${f.id}: ${l.suite} "${l.match}"`);
      }
    }
    counts[status]++;
    return { ...f, status, detail };
  });
  return { area: area.area, features };
});

const total = counts.green + counts.red + counts.gray + counts.yellow;
const pct = total ? Math.round((counts.green / total) * 100) : 0;

// --- render HTML ------------------------------------------------------------

const COLOR = { green: '#1f9d55', red: '#e3342f', gray: '#8a8a8a', yellow: '#caa023' };
const ICON = { green: '●', red: '●', gray: '○', yellow: '◐' };
const LABEL = { green: 'tested', red: 'FAILING', gray: 'no test', yellow: 'stale map' };

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const generatedAt = process.env.IC_DASHBOARD_TIME || '(run-time)';
const missingSuites = Object.entries(suites)
  .filter(([, s]) => !s.present)
  .map(([k]) => k);

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>ImageCompare — Feature Coverage</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 20px 28px; border-bottom: 1px solid #262a33; position: sticky; top: 0; background: #0f1115; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  .sub { color: #9aa0aa; font-size: 13px; }
  .bar { height: 10px; border-radius: 5px; background: #262a33; overflow: hidden; margin: 12px 0 4px; max-width: 520px; }
  .bar > i { display: block; height: 100%; background: ${COLOR.green}; width: ${pct}%; }
  .legend { display: flex; gap: 16px; font-size: 13px; margin-top: 8px; flex-wrap: wrap; }
  .legend span::before { content: '● '; }
  main { padding: 20px 28px; }
  .area { margin-bottom: 26px; }
  .area h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .6px; color: #9aa0aa; border-bottom: 1px solid #262a33; padding-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 8px; margin-top: 10px; }
  .card { border: 1px solid #262a33; border-radius: 8px; padding: 10px 12px; background: #151821; }
  .card .top { display: flex; align-items: center; gap: 8px; }
  .dot { font-size: 13px; }
  .name { font-size: 13px; }
  .tag { margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; opacity: .8; }
  .tests { margin: 6px 0 0; font-size: 11px; color: #8a909a; }
  code { background: #1d212b; padding: 1px 4px; border-radius: 3px; }
</style></head>
<body>
<header>
  <h1>ImageCompare — Feature Coverage Dashboard</h1>
  <div class="sub">${counts.green}/${total} features tested &middot; generated ${esc(generatedAt)}${missingSuites.length ? ` &middot; <span style="color:${COLOR.yellow}">missing suite JSON: ${missingSuites.join(', ')}</span>` : ''}</div>
  <div class="bar"><i></i></div>
  <div class="legend">
    <span style="color:${COLOR.green}">tested ${counts.green}</span>
    <span style="color:${COLOR.red}">failing ${counts.red}</span>
    <span style="color:${COLOR.gray}">no test ${counts.gray}</span>
    <span style="color:${COLOR.yellow}">stale ${counts.yellow}</span>
  </div>
</header>
<main>
${areas
  .map(
    (a) => `<section class="area"><h2>${esc(a.area)}</h2><div class="grid">
${a.features
  .map(
    (f) => `<div class="card">
  <div class="top">
    <span class="dot" style="color:${COLOR[f.status]}">${ICON[f.status]}</span>
    <span class="name">${esc(f.name)}</span>
    <span class="tag" style="color:${COLOR[f.status]}">${LABEL[f.status]}</span>
  </div>
  ${f.tests && f.tests.length ? `<div class="tests">${f.tests.map((t) => `<code>${esc(t.suite)}</code> ${esc(t.match)}`).join('<br>')}</div>` : ''}
</div>`,
  )
  .join('\n')}
</div></section>`,
  )
  .join('\n')}
</main></body></html>`;

writeFileSync(join(__dirname, 'dashboard.html'), html);



console.log(`\n✔ Dashboard: ${counts.green} tested, ${counts.red} failing, ${counts.gray} no-test, ${counts.yellow} stale (of ${total}).`);
console.log('  → test/dashboard/dashboard.html');
if (staleRows.length > 0) {
  console.error(`\n✘ ${staleRows.length} stale mapping(s) — features.json points at test titles that no longer exist:`);
  for (const r of staleRows) console.error(`    ${r}`);
  console.error('  Fix the match string (or the row) in test/dashboard/features.json.');
}
if (counts.red > 0 || staleRows.length > 0) process.exitCode = 1;
