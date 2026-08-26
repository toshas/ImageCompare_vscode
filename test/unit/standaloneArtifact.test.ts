import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUILD_COMMAND,
  artifactPath,
  describeProblem,
  standaloneArtifactState,
  standaloneInputFiles,
} from '../webview/standaloneArtifact';

// The webview layer builds dist/standalone/image_compare.html ONCE, in globalSetup, and every
// Playwright worker only reads it (test/webview/standaloneArtifact.ts). "Built once" is only safe
// if "already built" is decided honestly: an existsSync would happily serve a month-old page, so
// this suite pins the mtime rule and the input set it is computed over, on a real synthetic tree
// rather than the repo's own (the mutation sandbox copies src/ and test/ only).

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** A throwaway repo-shaped tree; every file gets mtime `base` unless overridden later. */
function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-artifact-'));
  roots.push(root);
  for (const rel of Object.keys(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return root;
}

const setMtime = (file: string, ms: number): void => {
  const secs = ms / 1000;
  fs.utimesSync(file, secs, secs);
};

const T0 = 1_700_000_000_000;

/** A repo-relative path in the platform's own form — what `path.relative` returns, and so what
 * `newerInput` carries. The field is only ever interpolated into a human message, never parsed, so
 * the harness keeps `path.relative`'s contract and the assertions come to it. */
const nativeRel = (posix: string): string => path.join(...posix.split('/'));

/** A tree with all the usual inputs older than the artifact. */
function freshTree(extra: Record<string, string> = {}): string {
  const root = makeTree({
    'scripts/build-standalone.mjs': '// build',
    'tsconfig.standalone.json': '{}',
    'package.json': '{"version":"0.0.1"}',
    'dist/webview.js': 'bundle',
    'src/webviewShell.ts': 'export const A = 1;',
    'src/webview/main.ts': 'export const B = 2;',
    'standalone/adapter.ts': 'export const C = 3;',
    'standalone/compose.mjs': 'export const D = 4;',
    'test/webview/standalone-build.spec.ts': 'spec',
    'dist/standalone/image_compare.html': '<html></html>',
    ...extra,
  });
  for (const f of standaloneInputFiles(root)) setMtime(f, T0);
  setMtime(artifactPath(root), T0 + 5000);
  return root;
}

describe('standalone artifact freshness', () => {
  it('reports fresh when every build input is older than the artifact', () => {
    expect(standaloneArtifactState(freshTree())).toEqual({ state: 'fresh' });
  });

  it('reports missing when the artifact is not on disk', () => {
    const root = freshTree();
    fs.rmSync(artifactPath(root));
    expect(standaloneArtifactState(root)).toEqual({ state: 'missing' });
  });

  it.each([
    ['src/webviewShell.ts'],
    ['src/webview/main.ts'],
    ['standalone/adapter.ts'],
    ['standalone/compose.mjs'],
    ['scripts/build-standalone.mjs'],
    ['tsconfig.standalone.json'],
    ['package.json'],
    ['dist/webview.js'],
  ])('reports stale when %s is newer than the artifact', (input) => {
    const root = freshTree();
    setMtime(path.join(root, input), T0 + 9000);
    expect(standaloneArtifactState(root)).toEqual({ state: 'stale', newerInput: nativeRel(input) });
  });

  it('treats an input that shares the artifact mtime as stale (a build reads before it writes)', () => {
    const root = freshTree();
    const artifactMs = fs.statSync(artifactPath(root)).mtimeMs;
    setMtime(path.join(root, 'src', 'webviewShell.ts'), artifactMs);
    expect(standaloneArtifactState(root)).toEqual({ state: 'stale', newerInput: nativeRel('src/webviewShell.ts') });
  });

  it.each([
    ['zero bytes, as an interrupted write leaves it', ''],
    ['a truncated prefix of a real page', '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>ImageCompare</title'],
  ])('reports corrupt when the artifact is %s, even with the newest mtime on disk', (_what, bytes) => {
    const root = freshTree();
    // The mtime a killed mid-write leaves behind: newer than every input, so the mtime rule alone
    // would call this page current and serve it.
    fs.writeFileSync(artifactPath(root), bytes);
    setMtime(artifactPath(root), T0 + 9000);
    const state = standaloneArtifactState(root);
    expect(state.state).toBe('corrupt');
    expect(state.state === 'corrupt' && state.detail).toContain(String(bytes.length));
  });

  it('accepts a complete page that happens to be newer than everything', () => {
    const root = freshTree();
    fs.writeFileSync(artifactPath(root), '<!DOCTYPE html>\n<html lang="en">\n<body></body>\n</html>');
    setMtime(artifactPath(root), T0 + 9000);
    expect(standaloneArtifactState(root)).toEqual({ state: 'fresh' });
  });

  it('refuses to call the artifact fresh when an input tree cannot be listed', () => {
    const root = freshTree();
    // A `src` that is not a directory: readdirSync fails with ENOTDIR for every user, root included,
    // which chmod 000 would not achieve.
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'src'), 'not a directory');
    const state = standaloneArtifactState(root);
    expect(state.state).toBe('unverifiable');
    expect(state.state === 'unverifiable' && state.detail).toContain('src');
  });

  it('refuses to call the artifact fresh when no build input exists at all', () => {
    const root = makeTree({ 'dist/standalone/image_compare.html': '<html></html>', 'src/x.ts': 'x' });
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'standalone'));
    expect(standaloneArtifactState(root).state).toBe('unverifiable');
  });

  it('ignores non-inputs: a newer spec, a stray src non-TS file and an unrelated tree', () => {
    const root = freshTree({ 'src/notes.txt': 'x', 'docs/testing.md': 'doc' });
    for (const rel of ['test/webview/standalone-build.spec.ts', 'src/notes.txt', 'docs/testing.md']) {
      setMtime(path.join(root, rel), T0 + 9000);
    }
    expect(standaloneArtifactState(root)).toEqual({ state: 'fresh' });
  });

  it('scans src/ and standalone/ recursively and nothing else', () => {
    const root = freshTree();
    const rels = standaloneInputFiles(root).map(f => path.relative(root, f).split(path.sep).join('/')).sort();
    expect(rels).toEqual([
      'dist/webview.js',
      'package.json',
      'scripts/build-standalone.mjs',
      'src/webviewShell.ts',
      'src/webview/main.ts',
      'standalone/adapter.ts',
      'standalone/compose.mjs',
      'tsconfig.standalone.json',
    ].sort());
  });
});

describe('standalone artifact problem message', () => {
  it('names the file and the command for a missing artifact', () => {
    const msg = describeProblem({ state: 'missing' }, '/x/image_compare.html');
    expect(msg).toContain('/x/image_compare.html');
    expect(msg).toContain('missing');
    expect(msg).toContain(BUILD_COMMAND);
  });

  it('names the newer input and the command for a stale artifact', () => {
    const msg = describeProblem({ state: 'stale', newerInput: 'src/webviewShell.ts' }, '/x/image_compare.html');
    expect(msg).toContain('STALE');
    expect(msg).toContain('src/webviewShell.ts');
    expect(msg).toContain(BUILD_COMMAND);
  });

  it('names the damage and the command for a corrupt artifact', () => {
    const msg = describeProblem({ state: 'corrupt', detail: '0 bytes' }, '/x/image_compare.html');
    expect(msg).toContain('CORRUPT');
    expect(msg).toContain('0 bytes');
    expect(msg).toContain(BUILD_COMMAND);
  });

  it('names what could not be enumerated for an unverifiable artifact', () => {
    const msg = describeProblem({ state: 'unverifiable', detail: 'src could not be listed' }, '/x/image_compare.html');
    expect(msg).toContain('src could not be listed');
    expect(msg).toContain(BUILD_COMMAND);
  });

  it('has nothing to say about a fresh artifact', () => {
    expect(describeProblem({ state: 'fresh' })).toBeNull();
  });
});
