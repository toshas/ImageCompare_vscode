// Generates the sidedness reference: which src/ modules the extension ships, which the standalone
// ships, and which both do — derived from the real import graph, never hand-maintained. Runtime
// sidedness only: `import type` / `export type ... from` edges are erased by the compiler and are
// ignored (precedent: the adapter's type-only PptxGenJS import is runtime-irrelevant). The webview
// bundle is its own root — both products ship dist/webview.js, so its closure is shared by
// construction and reported as the WEBVIEW category rather than classified against the other roots.
// Gates (exit 1, offenders named): (a) a src/ module reached from no root is dead code;
// (b) the shared-module list in docs/standalone.md ("Architecture", ingredient 2) must equal the
// computed SHARED set — the list is the backticked src/ basenames inside that numbered list item
// (the convention is stated in the doc), and this checker is what keeps it honest;
// (c) a host may supply DATA to a shared runner, never a DECISION — see POLICY_SEAMS below. Gate (c)
// lives here because its precondition is exactly what this script already derives: the module the
// hosts must delegate to has to be genuinely SHARED, which only the real import graph can say;
// (d) shim parity — every `Buffer.x` / `path.x` / `vscode.a.b` the standalone bundle's own closure
// touches must exist on the shim it runs against. Same reason as (c): the closure is this script's
// output. Shared modules typecheck against node's real types and run against the hand-rolled shims,
// so a missing static compiles clean and throws in the browser, at the user's click. The surface is
// read by bundling and evaluating the real shim (esbuild, as the build does), never by parsing it;
// presence only, never behaviour — behaviour is a test's job (docs/standalone.md).
// (f) no host-declared affordance — the manifest may not contribute a `webview/context` menu, and a
// menu item's label may exist only in the model. Same reason again: an affordance a host declares is a
// decision outside the import graph, which is exactly what every other gate here can see and this one
// cannot (docs/standalone.md: affordances-rendered-by-the-webview).
// (e) host-only wire facts — a message one host is in a position to state and the other is not may be
// posted from that host alone. Same reason as (c) and (d): the sets it needs are the ones this script
// already derives, and nothing else in the tree can see a *silence* being broken.
// Run: node scripts/check-sidedness.mjs        (--print emits the full module table)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import esbuild from 'esbuild';

const DOC = 'docs/standalone.md';

// Gate (c): one curated row per injected decision a shared runner takes from its hosts, and why the list is curated (docs/standalone.md: host-supplies-data-not-policy).
const POLICY_SEAMS = [
  {
    runner: 'runThumbnailSweep',
    option: 'centre',
    module: 'src/sweepAimPolicy.ts',
    binding: 'SweepAimPolicy',
    produces: '.aim()',
    feeds: ['noteTuple(', 'noteStrip(', 'noteSweepStart('],
    hosts: ['src/imageCompareProvider.ts', 'standalone/adapter.ts'],
    why: 'where the user is, is host data; WHEN the aim settles is policy (docs/loading-architecture.md: sweep-centre-dwells)',
  },
];
// Gate (e): one curated row per wire fact only one host can honestly state (docs/file-watching.md: root-loss-reported-as-an-edge).
const HOST_ONLY_MESSAGES = [
  {
    message: 'rootMissing',
    sender: 'src/imageCompareProvider.ts',
    why: 'a File System Access root handle cannot tell a deleted directory from an unreadable one, so a standalone sender would be guessing at the user (docs/file-watching.md: root-loss-reported-as-an-edge)',
  },
];
// Gate (f): the menu's labels, and the one module allowed to contain them (docs/standalone.md: affordances-rendered-by-the-webview).
const MENU_MODEL = 'src/webview/contextMenuModel.ts';
const MENU_LABELS = ['Copy Image', 'Copy Path', 'Reveal in Explorer', 'Hide Modality', 'Show Modality'];
// A posted object literal (`type: 'x',`), never the union member declaring it (`type: 'x';`) — src/types.ts is SHARED and declares them all.
const postsMessage = (text, message) => new RegExp(`type:\\s*'${message}'\\s*,`).test(text);

// Gate (d): the browser bundle's entry, and the shims esbuild aliases/injects into it (scripts/build-standalone.mjs).
const BUNDLE_ENTRY = 'standalone/adapter.ts';
const SHIMS = [
  { name: 'Buffer', file: 'standalone/shims/buffer.ts', pick: m => m.Buffer },
  { name: 'path', file: 'standalone/shims/path.ts', pick: m => m, spec: 'path' },
  { name: 'vscode', file: 'standalone/shims/vscode.ts', pick: m => m, spec: 'vscode' },
];
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

// Gate (c): each curated seam, checked against the hosts' own text (comments stripped, as above).
const stripped = file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const seam of POLICY_SEAMS) {
  const where = `${seam.runner}'s \`${seam.option}\``;
  // Reported, never returned on: the host lines below are what name the offender, and on a tree without the module they are the whole answer.
  if (!shared.has(srcBase(seam.module))) problems.push(`NOT-SHARED: ${where} must be produced by ${seam.module}, which is not SHARED — ${seam.why}`);
  for (const host of seam.hosts) {
    const text = stripped(host);
    if (!text.includes(`${seam.runner}(`)) {
      problems.push(`STALE-SEAM: ${host} no longer calls ${seam.runner} — re-point or drop this POLICY_SEAMS row`);
      continue;
    }
    const imports = new RegExp(`\\bimport\\s+[^;]*?\\b${seam.binding}\\b[^;]*?\\bfrom\\s*['"][^'"]*${srcBase(seam.module)}['"]`).test(text);
    if (!imports) problems.push(`HOST-POLICY: ${host} does not import ${seam.binding} from ${seam.module} — ${seam.why}`);
    const sites = [...text.matchAll(new RegExp(`^.*\\b${seam.option}:.*$`, 'gm'))].map(m => m[0].trim());
    if (sites.length === 0) problems.push(`HOST-POLICY: ${host} passes no \`${seam.option}\` to ${seam.runner} — ${seam.why}`);
    for (const site of sites) {
      if (!site.includes(seam.produces)) problems.push(`HOST-POLICY: ${host} hand-builds ${where}: \`${site}\` — it must come from ${seam.module} (${seam.produces}); ${seam.why}`);
    }
    for (const feed of seam.feeds) {
      if (!text.includes(feed)) problems.push(`HOST-POLICY: ${host} never calls \`${feed}\` — a host that stops feeding ${seam.module} leaves the other product's aim alone with it; ${seam.why}`);
    }
  }
}

// Gate (d): the shim's real runtime surface — bundled and evaluated exactly as scripts/build-standalone.mjs does.
const loadShim = async file => {
  const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'neutral', write: false });
  const mod = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
  return mod.exports;
};

// Member chains off a binding: `x.a.b` -> ['a','b']; the lookbehind keeps `foo.path.join` and quoted text out.
const chainsOff = (text, binding) =>
  [...text.matchAll(new RegExp(`(?<![.\\w$'"])${binding}((?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g'))]
    .map(m => m[1].replace(/\s+/g, '').split('.').filter(Boolean));

// What a file calls through one shim: namespace imports contribute chains, named imports one member each; a global shim needs no import.
const shimCalls = (text, shim) => {
  if (!shim.spec) return chainsOff(text, shim.name);
  const out = [];
  for (const m of text.matchAll(new RegExp(`\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]${shim.spec}['"]`, 'g'))) out.push(...chainsOff(text, m[1]));
  for (const m of text.matchAll(new RegExp(`\\bimport\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${shim.spec}['"]`, 'g'))) {
    if (m[1]) continue; // type-only imports are erased, like the edges above
    for (const part of m[2].split(',')) {
      const named = part.trim().split(/\s+as\s+/)[0].trim();
      if (named) out.push([named]);
    }
  }
  return out;
};

const bundleClosure = [...reach([BUNDLE_ENTRY]).keys()].filter(f => f.endsWith('.ts') && !f.startsWith('standalone/shims/')).sort();
// An empty closure means the entry moved, not that nothing calls a shim: exiting 0 there is the vacuous pass this gate exists to prevent.
if (bundleClosure.length === 0) problems.push(`SHIM-CLOSURE: ${BUNDLE_ENTRY} reached no modules — the standalone entry moved and gate (d) inspected nothing`);
for (const shim of SHIMS) {
  const surface = shim.pick(await loadShim(shim.file));
  if (surface === undefined) {
    problems.push(`SHIM-LOAD: ${shim.file} exported no ${shim.name} surface to check`);
    continue; // every chain below would report against nothing; the line above is the whole answer
  }
  for (const f of bundleClosure) {
    for (const chain of shimCalls(stripped(f), shim)) {
      let cur = surface, seen = shim.name;
      for (const step of chain) {
        if (cur === undefined || cur === null || cur[step] === undefined) {
          problems.push(`SHIM-GAP:  ${f} calls ${seen}.${step}, which ${shim.file} does not provide — it is in the standalone bundle, so this throws in the browser`);
          break;
        }
        cur = cur[step];
        seen += `.${step}`;
      }
    }
  }
}

// Gate (e): the named sender must still send it, and nothing the standalone ships may.
for (const row of HOST_ONLY_MESSAGES) {
  if (!postsMessage(stripped(row.sender), row.message)) {
    problems.push(`STALE-FACT: ${row.sender} no longer posts \`${row.message}\` — re-point or drop this HOST_ONLY_MESSAGES row, or the silence it guards is vacuous`);
  }
  for (const { f, cat } of table) {
    if (f === row.sender || !(cat === 'STANDALONE' || cat === 'STANDALONE-ONLY' || cat === 'SHARED')) continue;
    if (postsMessage(stripped(f), row.message)) {
      problems.push(`HOST-FACT: ${f} (${cat}) posts \`${row.message}\`, which only ${row.sender} may — ${row.why}`);
    }
  }
}

// Gate (f): the menu is the webview's, so neither the manifest nor a host may name one of its items.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.contributes?.menus?.['webview/context']) {
  problems.push('HOST-AFFORDANCE: package.json contributes a `webview/context` menu — that item set is a decision the standalone can never reach; build it in ' + MENU_MODEL);
}
for (const f of ['package.json', ...table.map(t => t.f)]) {
  if (f === MENU_MODEL) continue;
  const text = readFileSync(f, 'utf8');
  for (const label of MENU_LABELS) {
    // Bare text, not just a quoted literal: the regression this guards is a hardcoded help row inside webviewShell's template.
    if (!text.includes(label)) continue;
    problems.push(`HOST-AFFORDANCE: ${f} names the menu item '${label}' — item text belongs only in ${MENU_MODEL}`);
  }
}

const counts = {};
for (const { cat } of table) counts[cat] = (counts[cat] ?? 0) + 1;
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

if (problems.length) {
  console.error('\nSidedness check FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nThe shared list in ${DOC} ("Architecture", ingredient 2) mirrors the computed SHARED set;`);
  console.error('fix the doc or the import that changed sidedness. `--print` shows the full derived table.');
  console.error('A HOST-POLICY line means a host decided something a shared runner asks it for: move the decision');
  console.error('into the shared module both hosts import, and leave the host supplying data and primitives only.');
  console.error('A SHIM-GAP line means the standalone bundle calls something its browser shim does not have:');
  console.error('add it to the shim, or stop calling it from a module the standalone ships. tsc cannot see this —');
  console.error("the module typechecks against node's real Buffer/path/vscode and only the browser runs the shim.");
  console.error('A HOST-AFFORDANCE line means a menu item was declared outside the webview that renders it:');
  console.error('move the item into the shared model, and leave the host serving the action it is asked for.');
  console.error('A HOST-FACT line means the standalone side started stating something only the extension can');
  console.error('establish: either the browser really can establish it (then say so in the docs and drop the row),');
  console.error('or the message must not be sent from there at all.');
  process.exit(1);
}
console.log(`OK: ${shared.size} shared src modules match the ${DOC} list; no dead src modules; ${POLICY_SEAMS.length} policy seam(s) host-neutral; ${bundleClosure.length} bundled modules call nothing the ${SHIMS.length} shims lack; ${HOST_ONLY_MESSAGES.length} host-only wire fact(s) sent by one host each; ${MENU_LABELS.length} menu label(s) declared only in the model.`);
