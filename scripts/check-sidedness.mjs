// Generates the sidedness reference: which src/ modules the extension ships, which the standalone
// ships, and which both do — derived from the real import graph, never hand-maintained. Runtime
// sidedness only: `import type` / `export type ... from` edges are erased by the compiler and are
// ignored (precedent: the adapter's type-only PptxGenJS import is runtime-irrelevant). The webview
// bundle is its own root — both products ship dist/webview.js, so its closure is shared by
// construction and reported as the WEBVIEW category rather than classified against the other roots.
// Gates (exit 1, offenders named): (a) a src/ module reached from no root is dead code;
// (b) the shared-module list in docs/standalone.md ("Architecture", ingredient 2) must equal the
// computed SHARED set — the list is the backticked src/ basenames inside that numbered list item
// (the convention is stated in the doc), and this checker is what keeps it honest.
// Run: node scripts/check-sidedness.mjs        (--print emits the full module table)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DOC = 'docs/standalone.md';
const ROOTS = {
  extension: ['src/extension.ts'],
  standalone: ['standalone/adapter.ts', 'standalone/fsBackends.ts', 'standalone/compose.mjs'],
  webview: ['src/webview/main.ts'],
};

const walk = dir => readdirSync(dir).flatMap(e => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs)$/.test(p) && !p.endsWith('.d.ts') ? [p.split(sep).join('/')] : [];
});
const files = new Set([...walk('src'), ...walk('standalone')]);

// One statement regex over comment-stripped text; `[^;]*?` spans multi-line specifier lists safely.
const runtimeImports = file => {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (!m[1]) specs.push(m[2]); // type-only edges are erased at runtime — skipped
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  const edges = [];
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue; // bare specifiers (vscode, pptxgenjs, node:*) are not sidedness
    const base = resolve(dirname(file), spec);
    const hit = [base, `${base}.ts`, `${base}.mjs`, join(base, 'index.ts')].find(c => existsSync(c) && statSync(c).isFile());
    if (hit) edges.push(relative('.', hit).split(sep).join('/'));
  }
  return edges;
};

const graph = new Map([...files].map(f => [f, runtimeImports(f)]));

const reach = roots => {
  const seen = new Map(); // file -> 'direct' (root or root import) | 'transitive'
  const queue = roots.filter(r => graph.has(r)).map(r => [r, 'direct']);
  while (queue.length) {
    const [f, how] = queue.shift();
    if (seen.has(f)) continue;
    seen.set(f, how);
    for (const dep of graph.get(f) ?? []) queue.push([dep, roots.includes(f) ? 'direct' : 'transitive']);
  }
  return seen;
};
const byRoot = Object.fromEntries(Object.entries(ROOTS).map(([k, r]) => [k, reach(r)]));

const category = f => {
  if (f.startsWith('standalone/')) return 'STANDALONE';
  if (f.startsWith('src/webview/')) return 'WEBVIEW';
  const ext = byRoot.extension.has(f), sta = byRoot.standalone.has(f);
  if (ext && sta) return 'SHARED';
  if (ext) return 'EXTENSION-ONLY';
  if (sta) return 'STANDALONE-ONLY';
  return byRoot.webview.has(f) ? 'WEBVIEW-ONLY' : 'UNREACHED';
};
const table = [...files].sort().map(f => ({
  f,
  cat: category(f),
  via: Object.entries(byRoot).filter(([, s]) => s.has(f)).map(([k, s]) => `${k}(${s.get(f)})`).join(' '),
}));

if (process.argv.includes('--print')) {
  for (const { f, cat, via } of table) console.log(`  ${f.padEnd(36)} ${cat.padEnd(16)} ${via || '-'}`);
}

// Gate (b): the doc's ingredient-2 list — backticked tokens matching a src/ basename, case-sensitive.
const arch = readFileSync(DOC, 'utf8').split(/^## Architecture$/m)[1]?.split(/\n## /)[0] ?? '';
const item2 = arch.split(/^2\. /m)[1]?.split(/^3\. /m)[0] ?? '';
const srcBase = f => f.replace(/^src\//, '').replace(/\.ts$/, '');
const baseNames = new Set([...files].filter(f => /^src\/[^/]+\.ts$/.test(f)).map(srcBase));
const docList = new Set([...item2.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(t => baseNames.has(t)));
const shared = new Set(table.filter(r => r.cat === 'SHARED').map(r => srcBase(r.f)));

const problems = [];
for (const { f, cat } of table) if (cat === 'UNREACHED') problems.push(`DEAD:      ${f} — reached from no root (extension, standalone, webview)`);
for (const n of docList) if (!shared.has(n)) problems.push(`FAKE-SHARE: ${DOC} lists \`${n}\` as shared, but no runtime import path reaches it from both roots`);
for (const n of shared) if (!docList.has(n)) problems.push(`UNLISTED:  src/${n}.ts is SHARED but missing from the ${DOC} ingredient-2 list`);

const counts = {};
for (const { cat } of table) counts[cat] = (counts[cat] ?? 0) + 1;
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

if (problems.length) {
  console.error('\nSidedness check FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nThe shared list in ${DOC} ("Architecture", ingredient 2) mirrors the computed SHARED set;`);
  console.error('fix the doc or the import that changed sidedness. `--print` shows the full derived table.');
  process.exit(1);
}
console.log(`OK: ${shared.size} shared src modules match the ${DOC} list; no dead src modules.`);
