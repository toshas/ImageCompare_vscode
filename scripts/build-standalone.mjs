// Builds dist/standalone/image_compare.html — the single-file browser build (docs/standalone.md).
//
// Pipeline: tsc type-checks standalone/ (tsconfig.standalone.json), esbuild bundles
// standalone/adapter.ts with 'vscode' and 'path' aliased to the browser shims, node's Buffer
// global injected from standalone/shims/buffer.ts (a minimal hand-rolled subset — exactly what
// pngText/ppmxParser use — chosen over a full polyfill package), and process.platform defined
// to 'linux' for sessionFile. The real dist/webview.js is built via `npm run compile` when
// missing (rerun `npm run compile` yourself if it is stale), then standalone/compose.mjs inlines
// shell + both bundles into one page. Run: npm run build:standalone
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { composeStandaloneHtml } from '../standalone/compose.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Gate the build on types: vitest/esbuild transpile without checking, so this is the only tsc for standalone/.
run('npx tsc --noEmit -p tsconfig.standalone.json');

const webviewBundlePath = join(ROOT, 'dist', 'webview.js');
if (!existsSync(webviewBundlePath)) {
  console.log('dist/webview.js missing — running `npm run compile` first...');
  run('npm run compile');
}
const webviewJs = readFileSync(webviewBundlePath, 'utf8');

// The shared shell is TS; bundle it to CJS in memory and evaluate to get the exports.
const shellOut = await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'webviewShell.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  write: false,
});
const shellModule = { exports: {} };
new Function('module', 'exports', shellOut.outputFiles[0].text)(shellModule, shellModule.exports);
const { WEBVIEW_STYLES, WEBVIEW_BODY } = shellModule.exports;
if (!WEBVIEW_STYLES || !WEBVIEW_BODY) throw new Error('webviewShell.ts did not export WEBVIEW_STYLES/WEBVIEW_BODY');

const adapterOut = await esbuild.build({
  entryPoints: [join(ROOT, 'standalone', 'adapter.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  write: false,
  alias: {
    vscode: join(ROOT, 'standalone', 'shims', 'vscode.ts'),
    path: join(ROOT, 'standalone', 'shims', 'path.ts'),
  },
  inject: [join(ROOT, 'standalone', 'shims', 'buffer.ts')],
  define: {
    'process.platform': '"linux"',
    __IC_VERSION__: JSON.stringify(version),
  },
});
const adapterJs = adapterOut.outputFiles[0].text;

const html = composeStandaloneHtml({
  styles: WEBVIEW_STYLES,
  body: WEBVIEW_BODY,
  adapterJs,
  webviewJs,
  version,
});

const outDir = join(ROOT, 'dist', 'standalone');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'image_compare.html');
writeFileSync(outPath, html);
console.log(`Built ${outPath} (${(html.length / 1024).toFixed(0)} KiB, v${version})`);
