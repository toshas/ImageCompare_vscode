#!/usr/bin/env node
// Stages a comparison ready to publish next to the standalone page (docs/standalone.md, "The sharing script").
//
//   node scripts/share-comparison.mjs <folder | session.imagecompare> --out <dir> [--host claude-artifact|static] [--title <name>]
//
// Every decision (layout, the regime's limits, thumbs packing, publish batches) is standalone/sharePlan.ts's,
// bundled here in memory with esbuild exactly as scripts/build-standalone.mjs bundles the page; this file only
// parses arguments, builds the page from this checkout, and prints. A refusal prints every violation and exits 1
// with nothing staged (docs/standalone.md: pack-refuses-never-alters).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'dist', 'standalone', 'image_compare.html');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/share-comparison.mjs <folder | session.imagecompare> --out <dir> [--host claude-artifact|static] [--title <name>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { host: 'claude-artifact' };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out' || a === '--host' || a === '--title') {
    if (i + 1 >= args.length) usage(`${a} needs a value`);
    opts[a.slice(2)] = args[++i];
  } else if (a === '-h' || a === '--help') usage();
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) usage('give exactly one input: a folder or a .imagecompare session');
if (!opts.out) usage('--out <dir> is required');

const bundle = await esbuild.build({
  stdin: {
    contents: "export * from './standalone/sharePlan.ts'; export * from './standalone/shareNodeIo.ts'; export * from './standalone/hostRegimes.ts';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  external: ['sharp'],
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, createRequire(join(ROOT, 'package.json')));
const { shareComparison, nodeShareIo, nodeBase64, ShareRefusal, isHostRegimeName, HOST_REGIMES } = mod.exports;

if (!isHostRegimeName(opts.host)) usage(`unknown --host ${opts.host} (known: ${Object.keys(HOST_REGIMES).join(', ')})`);

// Every run, never only when missing: a page left in dist/ by an older checkout may not read the manifest staged beside it.
console.log('Building the page from this checkout (`npm run compile`, then `npm run build:standalone`)...');
for (const cmd of ['npm run compile', 'npm run build:standalone']) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    process.stdout.write(err.stdout ?? '');
    process.stderr.write(err.stderr ?? '');
    console.error(`\`${cmd}\` failed; nothing was staged.`);
    process.exit(1);
  }
}

const out = resolve(opts.out);
try {
  const summary = await shareComparison({
    input: resolve(positional[0]),
    out,
    host: opts.host,
    title: opts.title,
    pageHtml: readFileSync(PAGE, 'utf8'),
    base64: nodeBase64,
  }, nodeShareIo);
  console.log(`Staged "${summary.name}" for ${summary.host} in ${out}`);
  console.log(`  ${summary.images} images (${(summary.imageBytes / 1e6).toFixed(1)} MB), ${summary.thumbsFiles} thumbs file(s), ${(summary.totalBytes / 1e6).toFixed(1)} MB in total`);
  if (summary.thumbless.length > 0) console.log(`  ${summary.thumbless.length} image(s) with no packed thumbnail (decoded in the page instead): ${summary.thumbless.join(', ')}`);
  console.log(`  ${summary.batches} publish batch(es) — see publish-plan.json; every batch carries the page, batch 0 also the manifest and the thumbs`);
} catch (err) {
  if (err instanceof ShareRefusal) {
    console.error(`Refused — nothing was staged in ${out}:`);
    for (const v of err.violations) console.error(`  - ${v}`);
    console.error('A comparison is shared byte for byte or not at all; what to share instead is the sharer\'s decision.');
    process.exit(1);
  }
  throw err;
}
