#!/usr/bin/env node
/**
 * Local alpha builds, one command, one version source (CLAUDE.md: Install Locally).
 *
 * `node scripts/local-alpha.mjs <N>` sets package.json's version to `<next-patch>-alpha<N>`
 * and builds EVERYTHING that stamps a version from it — the extension VSIX (vsce) and the
 * standalone page — so the pair can never disagree about what is being tested. The bump is
 * left IN package.json (uncommitted) so later test-driven rebuilds keep the same stamp;
 * `--restore` reverts to the base version before committing. CI fails on a committed
 * prerelease version (.github/workflows/test.yml gates job), so forgetting cannot ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
// Alphas are <next-patch>-alphaN, so with a suffix present the COMMITTED base is patch minus one; re-runs must not re-bump.
const alreadyAlpha = pkg.version.includes('-');
const [bMaj, bMin, bPat] = pkg.version.split('-')[0].split('.').map(Number);
const base = alreadyAlpha ? `${bMaj}.${bMin}.${bPat - 1}` : pkg.version;

function setVersion(v) {
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(`"version": "${pkg.version}"`, `"version": "${v}"`));
  console.log(`package.json version: ${pkg.version} -> ${v}`);
}

const arg = process.argv[2];
if (arg === '--restore') {
  setVersion(base);
  process.exit(0);
}
const n = Number(arg);
if (!Number.isInteger(n) || n < 1) {
  console.error('usage: node scripts/local-alpha.mjs <N>   (builds <next-patch>-alphaN)\n       node scripts/local-alpha.mjs --restore');
  process.exit(1);
}
const [maj, min, pat] = base.split('.').map(Number);
const alpha = `${maj}.${min}.${pat + 1}-alpha${n}`;
setVersion(alpha);
// Standalone first: vsce packs dist/, so packaging first shipped the previous build's copy.
execSync('npm run build:standalone', { cwd: root, stdio: 'inherit' });
execSync('npx vsce package', { cwd: root, stdio: 'inherit' });
console.log(`\nBuilt image-compare-${alpha}.vsix + dist/standalone/image_compare.html (both stamped ${alpha}).`);
console.log('package.json keeps the alpha version until `--restore` (never commit it; CI guards).');
