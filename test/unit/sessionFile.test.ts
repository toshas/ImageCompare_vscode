import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseSessionFile, applyLabels, suggestSessionFileName, serializeSessionFile, CURRENT_SESSION_VERSION } from '../../src/sessionFile';

const BASE = path.resolve('/sessions');

describe('.imagecompare session files (real sessionFile code)', () => {
  it('Test 1: absolute paths pass through', () => {
    const spec = parseSessionFile('{"paths": ["/a/x", "/b/y"]}', BASE);
    expect(spec.paths.length, `expected 2 paths, got ${spec.paths.length}`).toBe(2);
    expect(spec.paths[0], `expected /a/x, got ${spec.paths[0]}`).toBe(path.resolve('/a/x'));
    expect(spec.labels, 'labels should be undefined when absent').toBeUndefined();
  });

  it('Test 2: relative paths resolve against the session file dir', () => {
    const spec = parseSessionFile('{"paths": ["run_a/images", "../run_b"]}', BASE);
    expect(spec.paths[0], `got ${spec.paths[0]}`).toBe(path.resolve(BASE, 'run_a/images'));
    expect(spec.paths[1], `got ${spec.paths[1]}`).toBe(path.resolve(BASE, '../run_b'));
  });

  it('Test 3: labels accepted when aligned with paths', () => {
    const spec = parseSessionFile('{"paths": ["/a", "/b"], "labels": ["baseline@v1", "variant@v1"]}', BASE);
    expect(spec.labels !== undefined && spec.labels[1] === 'variant@v1', `got ${spec.labels}`).toBe(true);
  });

  it('Test 4: invalid JSON rejected', () => {
    expect(() => parseSessionFile('not json', BASE), 'invalid JSON').toThrow('Not valid JSON');
  });

  it('Test 5: missing/empty/malformed paths rejected', () => {
    expect(() => parseSessionFile('{}', BASE), 'missing paths').toThrow('"paths"');
    expect(() => parseSessionFile('{"paths": []}', BASE), 'empty paths').toThrow('"paths"');
    expect(() => parseSessionFile('{"paths": ["/a", 5]}', BASE), 'non-string path').toThrow('"paths"');
    expect(() => parseSessionFile('{"paths": ["/a", ""]}', BASE), 'empty-string path').toThrow('"paths"');
    expect(() => parseSessionFile('"just a string"', BASE), 'non-object JSON').toThrow('"paths"');
  });

  it('Test 6: malformed labels rejected', () => {
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["one"]}', BASE), 'label count mismatch').toThrow('length');
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["x", 3]}', BASE), 'non-string label').toThrow('"labels"');
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "labels": ["x", "x"]}', BASE), 'duplicate labels').toThrow('unique');
  });

  it('Test 6b: colors accepted / rejected', () => {
    const spec = parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "#ff6600"]}', BASE);
    expect(spec.colors !== undefined && spec.colors[1] === '#ff6600', `got ${spec.colors}`).toBe(true);
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0"]}', BASE), 'color count mismatch').toThrow('length');
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "red"]}', BASE), 'non-hex color').toThrow('"colors"');
    expect(() => parseSessionFile('{"paths": ["/a", "/b"], "colors": ["#0f0", "#12"]}', BASE), 'malformed hex').toThrow('"colors"');
  });

  it('Test 7: applyLabels overrides by URI key, leaves others', () => {
    const uri = (s: string) => ({ toString: () => s });
    const dirs = [
      { name: 'auto_a', uri: uri('file:///a') },
      { name: 'auto_b', uri: uri('file:///b') }
    ];
    const labeled = applyLabels(dirs, new Map([['file:///b', 'custom_b']]));
    expect(labeled[0].name, `got ${labeled[0].name}`).toBe('auto_a');
    expect(labeled[1].name, `got ${labeled[1].name}`).toBe('custom_b');
    const untouched = applyLabels(dirs, undefined);
    expect(untouched, 'no labels should return the input array unchanged').toBe(dirs);
  });

  it('Test 8: suggestSessionFileName single selection', () => {
    expect(suggestSessionFileName(['my_experiment']), 'single dir name kept').toBe('my_experiment');
    expect(suggestSessionFileName(['a b/c']), `spaces and slashes sanitized, got ${suggestSessionFileName(['a b/c'])}`).toBe('a_b_c');
  });

  it('Test 9: suggestSessionFileName common prefix', () => {
    const name = suggestSessionFileName(['run_alpha_gt', 'run_alpha_pred']);
    expect(name, `expected run_alpha, got ${name}`).toBe('run_alpha');
  });

  it('Test 10: suggestSessionFileName generic/absent prefix falls back to count', () => {
    expect(suggestSessionFileName(['images', 'imgs_2']), `got ${suggestSessionFileName(['images', 'imgs_2'])}`).toBe('compare_2');
    expect(suggestSessionFileName(['abc', 'xyz', 'qrs']), `got ${suggestSessionFileName(['abc', 'xyz', 'qrs'])}`).toBe('compare_3');
  });

  it('Test 11: suggestSessionFileName length cap and empty fallback', () => {
    const long = suggestSessionFileName(['x'.repeat(100)]);
    expect(long.length, `expected 60 chars, got ${long.length}`).toBe(60);
    expect(suggestSessionFileName(['--']), `got ${suggestSessionFileName(['--'])}`).toBe('comparison');
  });

  it('Test 12: duplicate paths are rejected', () => {
    // Two identical paths become two modalities sharing one URI, and every URI-keyed lookup then
    // resolves both to the first — the second column would never receive a thumbnail.
    let threw = false;
    try {
      parseSessionFile(JSON.stringify({ paths: ['/a/x.png', '/a/x.png', '/a/y.png'] }), '/base');
    } catch (e: any) {
      threw = /must not repeat/.test(e.message);
    }
    expect(threw, 'duplicate paths must be rejected').toBe(true);

    // Relative and absolute spellings of the same location collide only after resolution.
    let threwRel = false;
    try {
      parseSessionFile(JSON.stringify({ paths: ['x.png', '/base/x.png'] }), '/base');
    } catch (e: any) {
      threwRel = /must not repeat/.test(e.message);
    }
    expect(threwRel, 'duplicates must be detected after resolving against baseDir').toBe(true);

    // Distinct paths still parse.
    const ok = parseSessionFile(JSON.stringify({ paths: ['/a/x.png', '/a/y.png'] }), '/base');
    expect(ok.paths.length, `expected 2 paths, got ${ok.paths.length}`).toBe(2);
  });

  it('Test: version gate — missing and current pass, future is rejected', () => {
    const noVersion = parseSessionFile(JSON.stringify({ paths: ['/a'] }), '/base');
    expect(noVersion.paths.length, 'a file without "version" must parse (pre-versioning files)').toBe(1);

    const current = parseSessionFile(JSON.stringify({ version: CURRENT_SESSION_VERSION, paths: ['/a'] }), '/base');
    expect(current.paths.length, 'the current version must parse').toBe(1);

    expect(
      () => parseSessionFile(JSON.stringify({ version: CURRENT_SESSION_VERSION + 1, paths: ['/a'] }), '/base'),
      'a future version must be rejected, not half-opened'
    ).toThrow('Update the extension');
    expect(
      () => parseSessionFile(JSON.stringify({ version: 0, paths: ['/a'] }), '/base'),
      'version 0 must be rejected'
    ).toThrow('positive integer');
    expect(
      () => parseSessionFile(JSON.stringify({ version: 1.5, paths: ['/a'] }), '/base'),
      'a fractional version must be rejected'
    ).toThrow('positive integer');
  });

  it('Test: serializeSessionFile — relative only when every path is inside destDir', () => {
    // All inside: relativized, and the destDir itself becomes ".".
    const inside = JSON.parse(serializeSessionFile(['/data/run', '/data/run/gt'], '/data/run'));
    expect(inside.version, 'saved file must carry the current version').toBe(CURRENT_SESSION_VERSION);
    expect(inside.paths[0], `destDir itself must serialize as ".", got ${inside.paths[0]}`).toBe('.');
    expect(inside.paths[1], `child must be relative, got ${inside.paths[1]}`).toBe('gt');

    // Round-trip: parsing the saved body from destDir must land on the original absolute paths.
    const rt = parseSessionFile(serializeSessionFile(['/data/run/a', '/data/run/b'], '/data/run'), '/data/run');
    expect(rt.paths[0] === path.resolve('/data/run/a') && rt.paths[1] === path.resolve('/data/run/b'),
      `round-trip must restore absolute paths, got ${rt.paths}`).toBe(true);

    // One escapee keeps ALL paths absolute — a lone ".." would break the file the moment it moves.
    const escape = JSON.parse(serializeSessionFile(['/data/run/a', '/elsewhere/b'], '/data/run'));
    expect(escape.paths[0] === '/data/run/a' && escape.paths[1] === '/elsewhere/b',
      `an escaping path must force all-absolute, got ${escape.paths}`).toBe(true);

    // Labels and colors ride through untouched.
    const full = JSON.parse(serializeSessionFile(['/d/a', '/d/b'], '/d', ['GT', 'pred'], ['#f00', '#0f0']));
    expect(full.labels?.[1] === 'pred' && full.colors?.[0] === '#f00', 'labels and colors must be preserved').toBe(true);
  });
});
