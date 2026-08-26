// Enforces the one-line-comment rule (CLAUDE.md): two or more consecutive `//` lines are a comment
// BLOCK, i.e. documentation living in a source file where nobody maintains it — it belongs in docs/.
// Scope: src/**/*.ts and scripts/**/*.{mjs,js}. test/ is EXEMPT on its merits, not by oversight — a
// comment explaining why a fixture triggers an edge case is correctly co-located with the fixture,
// and the rule exists to keep *production* code from carrying design prose that belongs in docs/.
// Exempt in both scopes: `// ----`/`// ====` section banners and lint/ts directive comments.
// Exempt in scripts/ ONLY: the leading file-header block — the `//` run that starts at the file's
// first non-shebang, non-blank line and ends at the first line that is not a `//` comment. A gate
// script's header is documentation OF the file, and docs/ describes subsystems, not gate scripts, so
// there is no better home; src/ says the same thing in `/** */` JSDoc, so it needs no such carve-out
// and keeps the plain 2-line threshold. Nothing here is exempt for being merely "near the top".
// KNOWN HOLE, deliberate: this checker never looks inside `/** */`. A block comment of any length is
// invisible to it, so the "state the contract, don't narrate the rationale" half of the rule is
// review-enforced, not gated — adding block-comment detection is a separate, much wider decision.
// Run: node scripts/comment-lint.mjs
import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Scope and exemptions (incl. why test/ is out): this file's header and CLAUDE.md.
const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').filter(f => /^src\/.*\.ts$/.test(f) || /^scripts\/.*\.m?js$/.test(f));

const isComment  = l => /^\s*\/\//.test(l);
const isBanner   = l => /^\s*\/\/\s*[-=]{3,}/.test(l) || /^\s*\/\/\s*[-=]+\s*[\w /()—-]*[-=]+\s*$/.test(l);
const isDirective = l => /^\s*\/\/\s*(eslint-|@ts-|prettier-|istanbul |c8 |biome-|global |globals )/.test(l);

// Exclusive end of the leading header block, or 0 when the file does not open with one.
const headerEnd = lines => {
  let i = /^#!/.test(lines[0] ?? '') ? 1 : 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (!isComment(lines[i] ?? '')) return 0;
  while (i < lines.length && isComment(lines[i])) i++;
  return i;
};

const violations = [];
for (const f of files) {
  let text;
  try { if (!statSync(f).isFile()) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  const exemptBefore = f.startsWith('scripts/') ? headerEnd(lines) : 0;
  let start = -1, run = 0;
  const flush = () => { if (run > 1 && start >= exemptBefore) violations.push({ f, line: start + 1, n: run }); run = 0; start = -1; };
  lines.forEach((l, i) => {
    if (isComment(l) && !isBanner(l) && !isDirective(l)) {
      if (run === 0) start = i;
      run++;
    } else flush();
  });
  flush();
}

if (violations.length) {
  console.error('Comment-length check FAILED. A run of consecutive `//` lines is a comment block —');
  console.error('move the explanation to the relevant docs/ file and leave a one-line pointer (CLAUDE.md).\n');
  for (const v of violations) console.error(`  ${v.f}:${v.line}  — ${v.n} consecutive // lines`);
  process.exit(1);
}
const nSrc = files.filter(f => f.startsWith('src/')).length;
console.log(`OK: no multi-line // comment runs in ${nSrc} src files and ${files.length - nSrc} scripts (leading script headers exempt).`);
