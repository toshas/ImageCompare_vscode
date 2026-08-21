#!/usr/bin/env node
// Fails if a forbidden identifier appears in any non-ignored file. Substring, case-insensitive.
// Terms come from .words-to-check.txt (gitignored, one per line, # comments allowed) plus the
// runtime user and group names and this machine's home/checkout PREFIXES (never a bare '/home/':
// fixtures assert on invented absolute paths, and flagging those teaches --no-verify on day one).
// Run by .githooks/pre-commit (install: npm run hooks:install).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const WORDS_FILE = '.words-to-check.txt';
// A short or generic runtime name would match ordinary source ("root" is in repoRoot, rootDir, …).
const MIN_RUNTIME_LEN = 4;
// '/home' or 'C:\' names no machine; two segments is the shortest prefix that identifies one, and
// 8 chars keeps a degenerate '/home/u' from swallowing the fixture path '/home/u/data/results'.
const MIN_PREFIX_SEGMENTS = 2;
const MIN_PREFIX_LEN = 8;
const GENERIC = new Set(['root', 'user', 'users', 'admin', 'ubuntu', 'node', 'runner', 'build', 'test', 'home', 'staff', 'wheel', 'docker']);

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const wordsPath = join(repoRoot, WORDS_FILE);

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (!existsSync(wordsPath)) {
  die(`BLOCKED: ${WORDS_FILE} does not exist.

Create it at the repo root, one term per line, listing anything that must never reach a
public repo — employer or host names, internal project code names, private hostnames.
Lines starting with # are comments. The file is gitignored, so it stays yours.

    printf 'acme-corp\\ninternal-host\\n' > ${WORDS_FILE}

The current user and group names are added automatically; you do not need to list them.`);
}

const fileTerms = readFileSync(wordsPath, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

if (fileTerms.length === 0) {
  die(`BLOCKED: ${WORDS_FILE} is empty (or only comments).

Add at least one term, or delete the file and decide deliberately not to run this check.
An empty list is indistinguishable from a forgotten one, so it is treated as unconfigured.`);
}

function runtimeGroup() {
  try {
    return execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GROUP || '';
  }
}

const skipped = [];
const runtimeTerms = [userInfo().username, runtimeGroup()].filter(Boolean).filter(t => {
  if (t.length < MIN_RUNTIME_LEN || GENERIC.has(t.toLowerCase())) {
    skipped.push(t);
    return false;
  }
  return true;
});

/** This machine's home dir and checkout root, as literal prefixes (both separator spellings). */
function machinePrefixes(paths) {
  const out = [];
  for (const p of paths) {
    const norm = (p || '').replace(/[\\/]+$/, '');
    const segs = norm.split(/[\\/]/).filter(Boolean);
    // Deliberately NOT the word filters above: a prefix is specific because it is a path, so
    // '/home/bob' must survive even though 'bob' is too short to be a term on its own.
    if (segs.length < MIN_PREFIX_SEGMENTS || norm.length < MIN_PREFIX_LEN) {
      if (norm) skipped.push(norm);
      continue;
    }
    out.push(norm);
    if (norm.includes('\\')) out.push(norm.replace(/\\/g, '/'));
  }
  return out;
}

const prefixTerms = machinePrefixes([homedir(), repoRoot]);

const terms = [...new Set([...fileTerms, ...runtimeTerms, ...prefixTerms].map(t => t.toLowerCase()))];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024
}).toString('utf8').split('\0').filter(Boolean);

const hits = [];
for (const rel of files) {
  let buf;
  try {
    buf = readFileSync(join(repoRoot, rel));
  } catch {
    continue; // deleted between listing and read
  }
  // Binary files carry no reviewable text; a NUL in the head is the usual tell.
  if (buf.subarray(0, 8000).includes(0)) continue;
  const text = buf.toString('utf8');
  const lower = text.toLowerCase();
  if (!terms.some(t => lower.includes(t))) continue;

  text.split('\n').forEach((line, i) => {
    const low = line.toLowerCase();
    for (const t of terms) {
      if (low.includes(t)) hits.push({ rel, line: i + 1, term: t, text: line.trim().slice(0, 120) });
    }
  });
}

const note = skipped.length ? ` (skipped as too short or generic: ${skipped.join(', ')})` : '';
if (hits.length === 0) {
  console.log(`OK: ${terms.length} term(s) (${prefixTerms.length} machine prefix) absent from ${files.length} non-ignored files${note}.`);
  process.exit(0);
}

console.error(`\nBLOCKED: ${hits.length} forbidden reference(s) in files a commit would carry.\n`);
for (const h of hits.slice(0, 40)) {
  console.error(`  ${h.rel}:${h.line}  [${h.term}]  ${h.text}`);
}
if (hits.length > 40) console.error(`  … and ${hits.length - 40} more`);
console.error(`
Fix by removing the reference, or gitignore the file if it is generated output.
If a term legitimately belongs in the text, narrow the rule in ${WORDS_FILE} rather
than deleting it wholesale — a term dropped to unblock one commit protects nothing after.
To bypass once, and only with a reason: git commit --no-verify
`);
process.exit(1);
