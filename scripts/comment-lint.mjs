// Enforces the one-line-comment rule (CLAUDE.md): two or more consecutive `//` lines are a comment
// BLOCK, i.e. documentation living in a source file where nobody maintains it — it belongs in docs/.
// Allowed: JSDoc /** */ (a contract description, not narration — not mechanically distinguishable, so
// trusted to review), `// ----`/`// ====` section banners, and lint/ts directive comments.
// Run: node scripts/comment-lint.mjs
import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Tests are exempt: a comment explaining why a fixture triggers an edge case is correctly co-located
// with the fixture — a doc about one test's byte layout would be a worse home, not a better one. The
// rule exists to keep *production* code from carrying design prose that belongs in docs/. Tests live
// under test/, outside the src/ scope, so the src/ filter alone is the whole exemption.
const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').filter(f => /^src\/.*\.ts$/.test(f));

const isComment  = l => /^\s*\/\//.test(l);
const isBanner   = l => /^\s*\/\/\s*[-=]{3,}/.test(l) || /^\s*\/\/\s*[-=]+\s*[\w /()—-]*[-=]+\s*$/.test(l);
const isDirective = l => /^\s*\/\/\s*(eslint-|@ts-|prettier-|istanbul |c8 |biome-|global |globals )/.test(l);

const violations = [];
for (const f of files) {
  let text;
  try { if (!statSync(f).isFile()) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  let start = -1, run = 0;
  const flush = () => { if (run > 1) violations.push({ f, line: start + 1, n: run }); run = 0; start = -1; };
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
console.log(`OK: no multi-line // comment runs in ${files.length} src files.`);
