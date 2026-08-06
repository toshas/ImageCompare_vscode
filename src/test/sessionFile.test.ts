/**
 * Tests for .imagecompare session file parsing and label application.
 * Imports the real implementation (sessionFile.ts has no vscode dependency).
 *
 * Run: npx ts-node src/test/sessionFile.test.ts
 */

import * as path from 'path';
import { parseSessionFile, applyLabels, suggestSessionFileName, serializeSessionFile, CURRENT_SESSION_VERSION } from '../sessionFile';

// ── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertThrows(fn: () => void, substring: string, msg: string) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${msg} (did not throw)`);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert(text.includes(substring), `${msg} (message "${text}" lacks "${substring}")`);
  }
}

function printResults() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed!');
}

const BASE = path.resolve('/sessions');

// ── Tests ─────────────────────────────────────────────────────────────────

console.log('Test 1: absolute paths pass through');
{
  const spec = parseSessionFile('{"paths": ["/a/x", "/b/y"]}', BASE);
  assert(spec.paths.length === 2, `expected 2 paths, got ${spec.paths.length}`);
  assert(spec.paths[0] === path.resolve('/a/x'), `expected /a/x, got ${spec.paths[0]}`);
  assert(spec.labels === undefined, 'labels should be undefined when absent');
}

console.log('Test 2: relative paths resolve against the session file dir');
{
  const spec = parseSessionFile('{"paths": ["run_a/images", "../run_b"]}', BASE);
  assert(spec.paths[0] === path.resolve(BASE, 'run_a/images'), `got ${spec.paths[0]}`);
  assert(spec.paths[1] === path.resolve(BASE, '../run_b'), `got ${spec.paths[1]}`);
}

console.log('Test 3: labels accepted when aligned with paths');
{
  const spec = parseSessionFile('{"paths": ["/a", "/b"], "labels": ["baseline@v1", "variant@v1"]}', BASE);
  assert(spec.labels !== undefined && spec.labels[1] === 'variant@v1', `got ${spec.labels}`);
}

console.log('Test 4: invalid JSON rejected');
assertThrows(() => parseSessionFile('not json', BASE), 'Not valid JSON', 'invalid JSON');

console.log('Test 5: missing/empty/malformed paths rejected');
assertThrows(() => parseSessionFile('{}', BASE), '"paths"', 'missing paths');
assertThrows(() => parseSessionFile('{"paths": []}', BASE), '"paths"', 'empty paths');
assertThrows(() => parseSessionFile('{"paths": ["/a", 5]}', BASE), '"paths"', 'non-string path');
assertThrows(() => parseSessionFile('{"paths": ["/a", ""]}', BASE), '"paths"', 'empty-string path');
assertThrows(() => parseSessionFile('"just a string"', BASE), '"paths"', 'non-object JSON');

console.log('Test 6: malformed labels rejected');
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["one"]}', BASE), 'length', 'label count mismatch');
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["x", 3]}', BASE), '"labels"', 'non-string label');
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["x", "x"]}', BASE), 'unique', 'duplicate labels');

console.log('Test 6b: colors accepted / rejected');
{
  const spec = parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "#ff6600"]}', BASE);
  assert(spec.colors !== undefined && spec.colors[1] === '#ff6600', `got ${spec.colors}`);
}
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0"]}', BASE), 'length', 'color count mismatch');
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "red"]}', BASE), '"colors"', 'non-hex color');
assertThrows(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "#12"]}', BASE), '"colors"', 'malformed hex');

console.log('Test 7: applyLabels overrides by URI key, leaves others');
{
  const uri = (s: string) => ({ toString: () => s });
  const dirs = [
    { name: 'auto_a', uri: uri('file:///a') },
    { name: 'auto_b', uri: uri('file:///b') }
  ];
  const labeled = applyLabels(dirs, new Map([['file:///b', 'custom_b']]));
  assert(labeled[0].name === 'auto_a', `got ${labeled[0].name}`);
  assert(labeled[1].name === 'custom_b', `got ${labeled[1].name}`);
  const untouched = applyLabels(dirs, undefined);
  assert(untouched === dirs, 'no labels should return the input array unchanged');
}

console.log('Test 8: suggestSessionFileName single selection');
{
  assert(suggestSessionFileName(['my_experiment']) === 'my_experiment', 'single dir name kept');
  assert(suggestSessionFileName(['a b/c']) === 'a_b_c', `spaces and slashes sanitized, got ${suggestSessionFileName(['a b/c'])}`);
}

console.log('Test 9: suggestSessionFileName common prefix');
{
  const name = suggestSessionFileName(['run_alpha_gt', 'run_alpha_pred']);
  assert(name === 'run_alpha', `expected run_alpha, got ${name}`);
}

console.log('Test 10: suggestSessionFileName generic/absent prefix falls back to count');
{
  assert(suggestSessionFileName(['images', 'imgs_2']) === 'compare_2', `got ${suggestSessionFileName(['images', 'imgs_2'])}`);
  assert(suggestSessionFileName(['abc', 'xyz', 'qrs']) === 'compare_3', `got ${suggestSessionFileName(['abc', 'xyz', 'qrs'])}`);
}

console.log('Test 11: suggestSessionFileName length cap and empty fallback');
{
  const long = suggestSessionFileName(['x'.repeat(100)]);
  assert(long.length === 60, `expected 60 chars, got ${long.length}`);
  assert(suggestSessionFileName(['--']) === 'comparison', `got ${suggestSessionFileName(['--'])}`);
}

console.log('Test 12: duplicate paths are rejected');
{
  // Two identical paths become two modalities sharing one URI, and every URI-keyed lookup then
  // resolves both to the first — the second column would never receive a thumbnail.
  let threw = false;
  try {
    parseSessionFile(JSON.stringify({ paths: ['/a/x.png', '/a/x.png', '/a/y.png'] }), '/base');
  } catch (e: any) {
    threw = /must not repeat/.test(e.message);
  }
  assert(threw, 'duplicate paths must be rejected');

  // Relative and absolute spellings of the same location collide only after resolution.
  let threwRel = false;
  try {
    parseSessionFile(JSON.stringify({ paths: ['x.png', '/base/x.png'] }), '/base');
  } catch (e: any) {
    threwRel = /must not repeat/.test(e.message);
  }
  assert(threwRel, 'duplicates must be detected after resolving against baseDir');

  // Distinct paths still parse.
  const ok = parseSessionFile(JSON.stringify({ paths: ['/a/x.png', '/a/y.png'] }), '/base');
  assert(ok.paths.length === 2, `expected 2 paths, got ${ok.paths.length}`);
}

console.log('\nTest: version gate — missing and current pass, future is rejected');
{
  const noVersion = parseSessionFile(JSON.stringify({ paths: ['/a'] }), '/base');
  assert(noVersion.paths.length === 1, 'a file without "version" must parse (pre-versioning files)');

  const current = parseSessionFile(JSON.stringify({ version: CURRENT_SESSION_VERSION, paths: ['/a'] }), '/base');
  assert(current.paths.length === 1, 'the current version must parse');

  assertThrows(
    () => parseSessionFile(JSON.stringify({ version: CURRENT_SESSION_VERSION + 1, paths: ['/a'] }), '/base'),
    'Update the extension',
    'a future version must be rejected, not half-opened'
  );
  assertThrows(
    () => parseSessionFile(JSON.stringify({ version: 0, paths: ['/a'] }), '/base'),
    'positive integer',
    'version 0 must be rejected'
  );
  assertThrows(
    () => parseSessionFile(JSON.stringify({ version: 1.5, paths: ['/a'] }), '/base'),
    'positive integer',
    'a fractional version must be rejected'
  );
}

console.log('\nTest: serializeSessionFile — relative only when every path is inside destDir');
{
  // All inside: relativized, and the destDir itself becomes ".".
  const inside = JSON.parse(serializeSessionFile(['/data/run', '/data/run/gt'], '/data/run'));
  assert(inside.version === CURRENT_SESSION_VERSION, 'saved file must carry the current version');
  assert(inside.paths[0] === '.', `destDir itself must serialize as ".", got ${inside.paths[0]}`);
  assert(inside.paths[1] === 'gt', `child must be relative, got ${inside.paths[1]}`);

  // Round-trip: parsing the saved body from destDir must land on the original absolute paths.
  const rt = parseSessionFile(serializeSessionFile(['/data/run/a', '/data/run/b'], '/data/run'), '/data/run');
  assert(rt.paths[0] === path.resolve('/data/run/a') && rt.paths[1] === path.resolve('/data/run/b'),
    `round-trip must restore absolute paths, got ${rt.paths}`);

  // One escapee keeps ALL paths absolute — a lone ".." would break the file the moment it moves.
  const escape = JSON.parse(serializeSessionFile(['/data/run/a', '/elsewhere/b'], '/data/run'));
  assert(escape.paths[0] === '/data/run/a' && escape.paths[1] === '/elsewhere/b',
    `an escaping path must force all-absolute, got ${escape.paths}`);

  // Labels and colors ride through untouched.
  const full = JSON.parse(serializeSessionFile(['/d/a', '/d/b'], '/d', ['GT', 'pred'], ['#f00', '#0f0']));
  assert(full.labels?.[1] === 'pred' && full.colors?.[0] === '#f00', 'labels and colors must be preserved');
}

printResults();
