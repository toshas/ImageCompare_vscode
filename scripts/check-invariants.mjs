// Enforces the CLAUDE.md rule: every docs/ invariant is cited from the CODE that could break it, and
// every citation resolves. Invariants are named (kebab-case keys), not numbered — a key doesn't
// renumber, so deleting one just breaks a link this catches, and the slug is meaningful to a reader.
// Run: node scripts/check-invariants.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DOCS = 'docs';
const SELF = 'scripts/check-invariants.mjs';

// A citation is `docs/<file>.md: <kebab-key>`; section pointers use quoted CapCase or a comma, never that shape, so they never match.
const CITE = /docs\/([a-z0-9-]+\.md):\s*`?([a-z][a-z0-9-]*)`?/gi;
// An invariant is a top-level bullet leading with a backticked bold key in the `## Invariants` section.
const KEY = /^- \*\*`([a-z][a-z0-9-]*)`\*\*/gm;

const isProse = f => f.endsWith('.md') || f.startsWith('scripts/');
// A test cannot break an invariant, so a citation there must never satisfy coverage.
const countsForCoverage = f => !isProse(f) && !f.startsWith('test/');

const defined = new Map();
for (const fn of readdirSync(DOCS).filter(f => f.endsWith('.md'))) {
  const after = readFileSync(join(DOCS, fn), 'utf8').split(/^## Invariants[^\n]*$/m)[1];
  if (!after) continue;
  const body = after.split(/\n## /)[0]; // stop at the next section
  const keys = [...body.matchAll(KEY)].map(m => m[1]);
  if (keys.length) defined.set(fn, keys);
}

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
const citedByCode = new Map();
const dangling = [];
for (const f of files) {
  if (f === SELF || /\.(png|jpg|gif|vsix|ico)$/i.test(f)) continue;
  let text;
  try { if (!statSync(f).isFile()) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CITE)) {
      const doc = m[1].toLowerCase(), key = m[2];
      if (!defined.has(doc)) { dangling.push(`${f}:${i + 1} cites ${doc} — no such doc, or it has no Invariants section`); continue; }
      if (!defined.get(doc).includes(key)) { dangling.push(`${f}:${i + 1} cites ${doc}: ${key} — no such invariant (has: ${defined.get(doc).join(', ')})`); continue; }
      if (countsForCoverage(f)) (citedByCode.get(doc) ?? citedByCode.set(doc, new Set()).get(doc)).add(key);
    }
  });
}

const uncited = [];
const duplicated = [];
for (const [doc, keys] of defined) {
  const dups = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (dups.length) duplicated.push(`${doc}: invariant key(s) reused: ${dups.join(', ')} — keys must be unique within a doc`);
  const seen = citedByCode.get(doc) ?? new Set();
  const missing = [...new Set(keys)].filter(k => !seen.has(k));
  console.log(`  ${doc.padEnd(26)} ${new Set(keys).size - missing.length}/${new Set(keys).size} cited from code`);
  if (missing.length) uncited.push(`${doc}: ${missing.join(', ')} — no citation in code/config (a doc-to-doc mention, or one from a test, does not count)`);
}

if (dangling.length || uncited.length || duplicated.length) {
  console.error('\nInvariant citation check FAILED:');
  for (const d of dangling) console.error(`  DANGLING:  ${d}`);
  for (const u of uncited) console.error(`  UNCITED:   ${u}`);
  for (const d of duplicated) console.error(`  DUPLICATE: ${d}`);
  console.error('\nSee the Documentation Rules in CLAUDE.md. Cite the invariant from the code that could');
  console.error('break it, or merge/rephrase/delete it — an uncited invariant is decoration.');
  process.exit(1);
}
console.log('\nOK: every invariant is cited from code, and every citation resolves.');
