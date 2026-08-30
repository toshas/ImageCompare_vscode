import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// The bug this pins: VS Code matches a platform-specific extension against the *server's* platform,
// and when no build matches it refuses the install with "not compatible with the current version of
// Visual Studio Code" — a message that names the wrong cause (engines.vscode was never the problem).
// Six of nine targets shipped, so Alpine, musl and 32-bit ARM hosts got that message. A target is a
// line in a matrix, which nothing else in this repo checks, so the target list is pinned here — plus
// the two things that make a *wrong* build worse than a missing one: --libc must reach npm (musl and
// glibc are both "linux" to --os), and every matrix target must have a binary expectation in the
// packed-VSIX verification. `web` is not in the list: it is a browser host, not a node one.

const repoRoot = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/publish.yml'), 'utf8');

const VSCODE_PLATFORM_TARGETS = [
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'alpine-x64',
  'alpine-arm64',
  'darwin-x64',
  'darwin-arm64'
];

/** The `include:` entries of the build job's matrix, as plain key/value records. */
function buildMatrix(): Record<string, string>[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s+include:\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  const indent = lines[start].length - lines[start].trimStart().length;
  const entries: Record<string, string>[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ')) entries.push({});
    const pair = /^-?\s*([a-z_]+):\s*(\S+)\s*$/.exec(trimmed);
    if (pair && entries.length) entries[entries.length - 1][pair[1]] = pair[2];
  }
  return entries;
}

/** The `run:` script of a build-job step, by step name. */
function stepScript(name: string): string {
  const at = workflow.indexOf(`- name: ${name}`);
  expect(at).toBeGreaterThan(-1);
  const rest = workflow.slice(at);
  const next = rest.indexOf('\n      - name:', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('publish workflow platform targets', () => {
  it('builds every VS Code platform target plus a universal fallback', () => {
    const targets = buildMatrix().map((e) => e.target);

    expect([...targets].sort()).toEqual([...VSCODE_PLATFORM_TARGETS, 'universal'].sort());
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('gives each native target npm flags that match its platform, and universal none', () => {
    const byTarget = new Map(buildMatrix().map((e) => [e.target, e]));

    expect(byTarget.get('alpine-x64')).toMatchObject({ npm_os: 'linux', npm_cpu: 'x64', npm_libc: 'musl' });
    expect(byTarget.get('alpine-arm64')).toMatchObject({ npm_os: 'linux', npm_cpu: 'arm64', npm_libc: 'musl' });
    // 32-bit ARM is `arm` in npm's cpu naming; `armhf` would install nothing.
    expect(byTarget.get('linux-armhf')).toMatchObject({ npm_os: 'linux', npm_cpu: 'arm' });
    expect(byTarget.get('linux-armhf')!.npm_libc).toBeUndefined();
    expect(byTarget.get('linux-x64')!.npm_libc).toBeUndefined();

    for (const [target, entry] of byTarget) {
      if (target === 'universal') continue;
      const family = target.startsWith('alpine') ? 'linux' : target.split('-')[0];
      expect(entry.npm_os).toBe(family);
    }

    // A universal build that installed a native tier would be a platform build wearing the wrong name.
    const universal = byTarget.get('universal')!;
    expect(universal.npm_os).toBeUndefined();
    expect(universal.npm_cpu).toBeUndefined();
    expect(universal.npm_libc).toBeUndefined();
  });

  it('passes the matrix libc through to npm', () => {
    const install = stepScript('Install platform-specific Sharp');

    expect(install).toContain('--libc=${{ matrix.npm_libc }}');
    expect(install).toContain('--os=${{ matrix.npm_os }} --cpu=${{ matrix.npm_cpu }} $LIBC_FLAG');
  });

  it('prunes the natives npm restores, keeping only the target pair, after the last install', () => {
    const install = stepScript('Install platform-specific Sharp');

    // package-lock.json records no `libc` for @img/sharp-*, so --libc filters nothing on a
    // lockfile-driven install and the glibc tier comes back beside the musl one. Measured with
    // CI's npm (10.8.2): --os=linux --cpu=x64 --libc=musl leaves BOTH sharp-linuxmusl-x64 and
    // sharp-linux-x64. Only the prune separates them.
    expect(install).toContain('for dir in node_modules/@img/sharp-*; do');
    expect(install).toContain('KEEP="sharp-$KEEP_OS-${{ matrix.npm_cpu }} sharp-libvips-$KEEP_OS-${{ matrix.npm_cpu }}"');
    expect(install).toContain('if [ "${{ matrix.npm_libc }}" = "musl" ]; then KEEP_OS="linuxmusl"; fi');
    // Universal has no npm_cpu, so its keep-set is empty and the same loop strips every native.
    expect(install).toContain('KEEP=""');
    expect(install).toContain('if [ -n "${{ matrix.npm_cpu }}" ]; then');

    // Order is the other half of the fix: `npm install @emnapi/runtime` reconciles against the
    // lockfile and re-adds the *runner's* natives — measured on a linux x64 host by running the
    // recipe with the prune loop removed, linux-armhf reaches that point carrying sharp-linux-x64
    // and sharp-linuxmusl-x64 beside its own arm pair — so a prune before it prunes the wrong moment.
    const prune = install.indexOf('for dir in node_modules/@img/sharp-*; do');
    const installs = [...install.matchAll(/^\s*npm install /gm)].map((m) => m.index!);
    expect(installs.length).toBeGreaterThan(1);
    for (const at of installs) expect(at).toBeLessThan(prune);
    // And nothing at all runs after the wasm32 hand-extract, on any target.
    expect(install.indexOf('tar -xzf img-sharp-wasm32-')).toBeGreaterThan(prune);
  });

  it('registers a packed-VSIX binary expectation for every matrix target', () => {
    const verify = stepScript('Verify the VSIX carries the right binaries');

    for (const target of buildMatrix().map((e) => e.target)) {
      expect(verify).toContain(`"${target}":`);
    }
  });

  // The scan is a `node -e '...'` one-liner in a shell block: a single apostrophe anywhere in its
  // body ends the shell string, and the step then dies with a bash syntax error instead of checking
  // anything. That happened while writing the allow-set below, which is why it is pinned.
  it('keeps the scan body free of the quote that would truncate it', () => {
    const verify = stepScript('Verify the VSIX carries the right binaries');

    // The whole step, not just what follows `node -e `: an apostrophe in the step's name or env lines
    // would end the shell string just the same, and a window starting at `node -e ` never sees it.
    expect([...verify].filter((c) => c === "'").length).toBe(2);
  });
});

// The scan checks an *artifact*, so pinning its source text proves nothing about what it accepts: the
// check this one replaced looked only for the WASM tier's two paths and never read the @img set, so it
// passed the four-libvips-tier linux-arm64 VSIX that 0.4.0 actually shipped. These cases run the real
// step, extracted from the real workflow, against synthetic VSIX zips whose entry names are the
// measured @img shapes.
describe('publish workflow packed-VSIX scan', () => {
  /** The `node -e` program of the verify step, verbatim from the workflow. */
  function scanProgram(): string {
    const verify = stepScript('Verify the VSIX carries the right binaries');
    const at = verify.indexOf("node -e '");
    expect(at).toBeGreaterThan(-1);
    const body = verify.slice(at + "node -e '".length);
    const end = body.indexOf("'");
    expect(end).toBeGreaterThan(-1);
    return body.slice(0, end);
  }

  /** A zip whose central directory lists exactly these (empty, stored) entries. */
  function zipWith(entries: string[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const name of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(local, 30);
      locals.push(local);
      const central = Buffer.alloc(46 + nameBuf.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      nameBuf.copy(central, 46);
      centrals.push(central);
      offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  /** Everything a real VSIX carries that the scan looks at, besides `@img`. */
  const WASM_ENTRIES = [
    'extension/node_modules/@img/sharp-wasm32/lib/sharp-wasm32.node.wasm',
    'extension/node_modules/@emnapi/runtime/index.js'
  ];

  function imgEntries(pkgs: string[]): string[] {
    return pkgs.map((p) => `extension/node_modules/@img/${p}/package.json`);
  }

  /** Runs the real scan on a throwaway dir holding one synthetic VSIX. */
  function scan(target: string, entries: string[]): { status: number; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-vsix-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'image-compare-test.vsix'), zipWith(entries));
      const run = spawnSync(process.execPath, ['-e', scanProgram()], {
        cwd: dir,
        env: { ...process.env, TARGET: target },
        encoding: 'utf8'
      });
      return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every shape below was measured by packaging a real VSIX with that recipe (docs/image-backends.md).
  const PRUNED: Record<string, string[]> = {
    'linux-x64': ['colour', 'sharp-libvips-linux-x64', 'sharp-linux-x64', 'sharp-wasm32'],
    'linux-arm64': ['colour', 'sharp-libvips-linux-arm64', 'sharp-linux-arm64', 'sharp-wasm32'],
    'linux-armhf': ['colour', 'sharp-libvips-linux-arm', 'sharp-linux-arm', 'sharp-wasm32'],
    'alpine-x64': ['colour', 'sharp-libvips-linuxmusl-x64', 'sharp-linuxmusl-x64', 'sharp-wasm32'],
    'alpine-arm64': ['colour', 'sharp-libvips-linuxmusl-arm64', 'sharp-linuxmusl-arm64', 'sharp-wasm32'],
    'darwin-x64': ['colour', 'sharp-darwin-x64', 'sharp-libvips-darwin-x64', 'sharp-wasm32'],
    'darwin-arm64': ['colour', 'sharp-darwin-arm64', 'sharp-libvips-darwin-arm64', 'sharp-wasm32'],
    // Windows has no separate @img/sharp-libvips-win32-* package at all; its libvips is inside the platform package.
    'win32-x64': ['colour', 'sharp-win32-x64', 'sharp-wasm32'],
    'win32-arm64': ['colour', 'sharp-win32-arm64', 'sharp-wasm32'],
    'universal': ['colour', 'sharp-wasm32']
  };

  /** A pruned tree also carries the target's own .node, which the scan checks by name. */
  function nativeEntry(target: string): string[] {
    const pkg = PRUNED[target].find((p) => p.startsWith('sharp-') && !p.startsWith('sharp-libvips-') && p !== 'sharp-wasm32');
    return pkg ? [`extension/node_modules/@img/${pkg}/lib/${pkg}.node`] : [];
  }

  it('accepts every pruned leg, including the two win32 shapes and universal', () => {
    for (const target of Object.keys(PRUNED)) {
      const result = scan(target, [...WASM_ENTRIES, ...imgEntries(PRUNED[target]), ...nativeEntry(target)]);
      expect(`${target}: ${result.status} ${result.output}`).toContain(`${target}: 0`);
    }
    expect(Object.keys(PRUNED).sort()).toEqual([...VSCODE_PLATFORM_TARGETS, 'universal'].sort());
  });

  // This is the case the previous scan passed: the linux-arm64 VSIX 0.4.0 shipped, 36 MB, four libvips
  // tiers. That scan looked only for the WASM tier's two paths, so the @img set below never entered
  // into it. Reproduced by packaging with the pre-prune recipe; this is that artifact's own set.
  it('rejects the four-tier linux-arm64 shape that 0.4.0 shipped', () => {
    const shipped = [
      'colour',
      'sharp-libvips-linux-arm64', 'sharp-libvips-linuxmusl-arm64',
      'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linux-x64',
      'sharp-linux-arm64', 'sharp-linuxmusl-arm64', 'sharp-linuxmusl-x64', 'sharp-linux-x64',
      'sharp-wasm32'
    ];

    const result = scan('linux-arm64', [...WASM_ENTRIES, ...imgEntries(shipped), ...nativeEntry('linux-arm64')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('sharp-linux-x64');
    expect(result.output).toContain('sharp-linuxmusl-arm64');
  });

  it('rejects the pre-prune shape on every leg that can carry one, universal included', () => {
    // Measured: what a linux x64 runner leaves behind with the prune loop removed — its own glibc pair
    // beside whatever the leg asked for, and on universal the natives it is supposed to carry none of.
    const prePrune: Record<string, string[]> = {
      'linux-x64': ['colour', 'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linux-x64', 'sharp-linuxmusl-x64', 'sharp-linux-x64', 'sharp-wasm32'],
      'linux-armhf': ['colour', 'sharp-libvips-linux-arm', 'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linux-x64', 'sharp-linux-arm', 'sharp-linuxmusl-x64', 'sharp-linux-x64', 'sharp-wasm32'],
      'alpine-x64': ['colour', 'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linux-x64', 'sharp-linuxmusl-x64', 'sharp-linux-x64', 'sharp-wasm32'],
      'universal': ['colour', 'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linux-x64', 'sharp-linuxmusl-x64', 'sharp-linux-x64', 'sharp-wasm32']
    };

    for (const [target, pkgs] of Object.entries(prePrune)) {
      const result = scan(target, [...WASM_ENTRIES, ...imgEntries(pkgs), ...nativeEntry(target)]);
      expect(`${target}: ${result.status}`).toBe(`${target}: 1`);
      expect(result.output).toContain('strays');
    }
  });

  /** The step's `run:` body, verbatim — the bytes Actions hands to bash. */
  function verifyRunBody(): string {
    const verify = stepScript('Verify the VSIX carries the right binaries');
    const at = verify.indexOf('run: |');
    expect(at).toBeGreaterThan(-1);
    return verify.slice(at + 'run: |'.length).replace(/\r/g, '');
  }

  const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

  /** Runs a script under the exact shell Actions uses for `shell: bash`, with node on PATH. */
  function runInActionsShell(body: string, target: string, entries: string[]): { status: number; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-vsix-shell-'));
    try {
      fs.writeFileSync(path.join(dir, 'image-compare-test.vsix'), zipWith(entries));
      const script = path.join(dir, 'step.sh');
      fs.writeFileSync(script, body);
      const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
        cwd: dir,
        env: {
          ...process.env,
          TARGET: target,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`
        },
        encoding: 'utf8'
      });
      return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every case above hands the extracted program straight to node, which is the one thing Actions never
  // does: it runs the whole `run:` body through bash, and that is the layer the `node -e '...'` quoting
  // lives in. A step that cannot even parse looks exactly like a step that passed — twice in this round
  // it did. So this runs the body the way Actions runs it and pins BOTH directions, with exact exit
  // codes: bash's own 2 (syntax error, checked nothing) must never read as the scan's 1 (check fired).
  // Skipped, with this reason, only where there is no bash to run it under.
  it.skipIf(!hasBash)('runs the whole step under a real shell: exit 0 for a conforming VSIX, exit 1 for a stray', () => {
    const body = verifyRunBody();
    // The target arrives through `env:`; a `${{ }}` expression in the body would reach bash unexpanded.
    expect(body).not.toContain('${{');

    const conforming = [...WASM_ENTRIES, ...imgEntries(PRUNED['linux-x64']), ...nativeEntry('linux-x64')];
    const ok = runInActionsShell(body, 'linux-x64', conforming);
    expect(`exit ${ok.status} :: ${ok.output}`).toContain('exit 0 ::');
    expect(ok.output).toContain('carries exactly @img/');

    const withStray = [...PRUNED['linux-x64'], 'sharp-linuxmusl-x64', 'sharp-libvips-linuxmusl-x64'];
    const bad = runInActionsShell(body, 'linux-x64', [...WASM_ENTRIES, ...imgEntries(withStray), ...nativeEntry('linux-x64')]);
    expect(`exit ${bad.status} :: ${bad.output}`).toContain('exit 1 ::');
    expect(bad.output).toContain('strays: sharp-libvips-linuxmusl-x64, sharp-linuxmusl-x64');
  });

  it('still fails a VSIX that lost the WASM tier, or its own native binary, or names no known target', () => {
    const noWasm = scan('linux-x64', imgEntries(['colour', 'sharp-libvips-linux-x64', 'sharp-linux-x64']).concat(nativeEntry('linux-x64')));
    expect(noWasm.status).toBe(1);
    expect(noWasm.output).toContain('missing the WASM fallback');

    // The pair is present but the .node inside it is not — a prune that took the file, not the dir.
    const noNative = scan('linux-x64', [...WASM_ENTRIES, ...imgEntries(PRUNED['linux-x64'])]);
    expect(noNative.status).toBe(1);
    expect(noNative.output).toContain('missing its native Sharp binary');

    const unknown = scan('linux-riscv64', [...WASM_ENTRIES, ...imgEntries(['colour', 'sharp-wasm32'])]);
    expect(unknown.status).toBe(1);
    expect(unknown.output).toContain('no binary expectation is registered');

    // An over-eager prune that takes the libvips half leaves a platform package that cannot load,
    // and `colour` is a plain sharp@0.34 dependency the un-ignore list has to keep carrying.
    const noLibvips = scan('linux-x64', [...WASM_ENTRIES, ...imgEntries(['colour', 'sharp-linux-x64', 'sharp-wasm32']), ...nativeEntry('linux-x64')]);
    expect(noLibvips.status).toBe(1);
    expect(noLibvips.output).toContain('missing: sharp-libvips-linux-x64');

    const noColour = scan('linux-x64', [...WASM_ENTRIES, ...imgEntries(PRUNED['linux-x64'].filter((x) => x !== 'colour')), ...nativeEntry('linux-x64')]);
    expect(noColour.status).toBe(1);
    expect(noColour.output).toContain('missing: colour');
  });
});

// ── A pull request builds every VSIX and publishes nothing ──────────────────────────────────────
// Until this landed, the ten-leg build ran for the first time AT TAG TIME — the one irreversible
// step, since neither marketplace unpublishes cleanly. So the packaging recipe (per-target Sharp
// install, libvips prune, packed-VSIX scan) was first exercised at the moment its failure was most
// expensive; the 0.4.0 linux-arm64 VSIX shipped four libvips tiers and nothing in CI looked. A PR
// now runs the same build job, and must be unable to reach a marketplace even from a fork.
//
// These cases read the workflow as a document (js-yaml, an explicit devDependency — the workflow is
// YAML, and a regex over it passes on any file that happens to contain the string it looks for),
// then evaluate the real `if:` expressions under a model of Actions' documented semantics: a job's
// `if:` replaces the implicit success(); success() means every `needs` job succeeded; failure() means
// one failed; cancelled() is the run being cancelled. Nothing here pins the wording of a condition —
// an equivalent rewrite passes, a weakening does not.

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  uses?: string;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { include?: Record<string, string>[] } };
}

interface WorkflowDoc {
  on: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
  jobs: Record<string, WorkflowJob>;
}

const doc = loadYaml(workflow) as WorkflowDoc;

/** The jobs this file is expected to define — a rename or a move must fail loudly, not quietly pass. */
const JOB_IDS = ['test', 'test-full', 'build', 'codium-smoke', 'publish', 'verify-openvsx'];

type Value = string | number | boolean | null | undefined;

interface EvalContext {
  github: { event_name: string; ref: string };
  needs: Record<string, { result: string }>;
  inputs: Record<string, Value>;
  status: { success: boolean; failure: boolean; cancelled: boolean };
}

type Token = { kind: 'string' | 'name' | 'number' | 'punct'; text: string };

const PUNCT = ['&&', '||', '==', '!=', '!', '(', ')', '[', ']', '.', ','];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let text = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in: ${src}`);
        if (src[i] === "'" && src[i + 1] === "'") { text += "'"; i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        text += src[i++];
      }
      tokens.push({ kind: 'string', text });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let text = '';
      while (i < src.length && /[0-9.]/.test(src[i])) text += src[i++];
      tokens.push({ kind: 'number', text });
      continue;
    }
    if (/[A-Za-z_-]/.test(c)) {
      let text = '';
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) text += src[i++];
      tokens.push({ kind: 'name', text });
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (!punct) throw new Error(`unexpected character '${c}' in: ${src}`);
    tokens.push({ kind: 'punct', text: punct });
    i += punct.length;
  }
  return tokens;
}

function truthy(v: Value): boolean {
  return !(v === false || v === undefined || v === null || v === '' || v === 0);
}

/** Evaluates one GitHub Actions expression (the operator subset this workflow uses). */
function evaluateExpression(src: string, ctx: EvalContext): Value {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eat = (text: string): boolean => {
    if (tokens[pos] && tokens[pos].kind === 'punct' && tokens[pos].text === text) { pos++; return true; }
    return false;
  };
  const expect_ = (text: string): void => {
    if (!eat(text)) throw new Error(`expected '${text}' at token ${pos} in: ${src}`);
  };

  function primary(): Value {
    const token = peek();
    if (!token) throw new Error(`unexpected end of expression: ${src}`);
    if (eat('(')) {
      const value = or();
      expect_(')');
      return value;
    }
    if (eat('!')) return !truthy(primary());
    pos++;
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.kind !== 'name') throw new Error(`unexpected token '${token.text}' in: ${src}`);
    if (token.text === 'true') return true;
    if (token.text === 'false') return false;
    if (token.text === 'null') return null;
    if (eat('(')) {
      if (!eat(')')) throw new Error(`only zero-argument functions are modelled: ${src}`);
      if (token.text === 'always') return true;
      if (token.text === 'success') return ctx.status.success;
      if (token.text === 'failure') return ctx.status.failure;
      if (token.text === 'cancelled') return ctx.status.cancelled;
      throw new Error(`unmodelled function ${token.text}() in: ${src}`);
    }
    let value: unknown;
    if (token.text === 'github') value = ctx.github;
    else if (token.text === 'needs') value = ctx.needs;
    else if (token.text === 'inputs') value = ctx.inputs;
    else throw new Error(`unmodelled context '${token.text}' in: ${src}`);
    for (;;) {
      let key: string;
      if (eat('.')) {
        const name = peek();
        if (!name || name.kind !== 'name') throw new Error(`expected a property name in: ${src}`);
        pos++;
        key = name.text;
      } else if (eat('[')) {
        const literal = peek();
        if (!literal || literal.kind !== 'string') throw new Error(`only string indexes are modelled: ${src}`);
        pos++;
        expect_(']');
        key = literal.text;
      } else {
        break;
      }
      const container = value as Record<string, unknown> | undefined;
      if (container === undefined || !(key in container)) {
        throw new Error(`'${key}' is not in the modelled context (a job it names may have left needs): ${src}`);
      }
      value = container[key];
    }
    return value as Value;
  }

  function equality(): Value {
    let left = primary();
    for (;;) {
      if (eat('==')) left = left === primary();
      else if (eat('!=')) left = left !== primary();
      else return left;
    }
  }

  function and(): Value {
    let left = equality();
    while (eat('&&')) {
      // Short-circuit exactly as Actions does: nothing to the right of a false `&&` is evaluated.
      if (!truthy(left)) { skipOperand(); continue; }
      left = equality();
    }
    return left;
  }

  function or(): Value {
    let left = and();
    while (eat('||')) {
      if (truthy(left)) { skipOperand(); continue; }
      left = and();
    }
    return left;
  }

  /** Consumes the operand that short-circuiting skipped, without evaluating it. */
  function skipOperand(): void {
    let depth = 0;
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.kind === 'punct' && (token.text === '(' || token.text === '[')) depth++;
      if (token.kind === 'punct' && (token.text === ')' || token.text === ']')) {
        if (depth === 0) return;
        depth--;
      }
      if (depth === 0 && token.kind === 'punct' && (token.text === '&&' || token.text === '||')) return;
      pos++;
    }
  }

  const result = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens at ${pos} in: ${src}`);
  return result;
}

/** Strips the `${{ }}` wrapper Actions allows around a whole condition. */
function unwrap(expr: string): string {
  const trimmed = expr.trim();
  const opens = trimmed.split('${{').length - 1;
  if (opens > 1) throw new Error(`multiple expression blocks are not modelled: ${expr}`);
  const single = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
  return single ? single[1] : trimmed;
}

/** Whether a condition names a status function — what makes Actions drop the implicit success(). */
function namesStatusFunction(expr: string | undefined): boolean {
  return expr !== undefined && /\b(success|failure|cancelled|always)\s*\(/.test(unwrap(expr));
}

/** Actions' rule: an explicit `if:` replaces the implicit success() only when it names a status function. */
function conditionHolds(expr: string | undefined, ctx: EvalContext): boolean {
  if (expr === undefined) return ctx.status.success;
  const value = truthy(evaluateExpression(unwrap(expr), ctx));
  return namesStatusFunction(expr) ? value : ctx.status.success && value;
}

function needsOf(id: string): string[] {
  const needs = doc.jobs[id].needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped' | 'not-run';

function refFor(event: string): string {
  return event === 'push' ? 'refs/tags/v9.9.9' : 'refs/pull/7/merge';
}

/** What each job does on a run of `event`, with any job's own outcome forced through `results`. */
function jobOutcomes(
  event: string,
  opts: { results?: Record<string, JobResult>; cancelled?: boolean; ref?: string } = {}
): Record<string, JobResult> {
  const outcome: Record<string, JobResult> = {};
  for (const id of Object.keys(doc.jobs)) outcome[id] = 'not-run';
  if (!Object.prototype.hasOwnProperty.call(doc.on, event)) return outcome;

  const pending = new Set(Object.keys(doc.jobs));
  while (pending.size) {
    const ready = [...pending].filter((id) => !needsOf(id).some((n) => pending.has(n)));
    if (!ready.length) throw new Error('the job graph has a cycle');
    for (const id of ready) {
      const needs = needsOf(id);
      const needsCtx: Record<string, { result: string }> = {};
      for (const n of needs) {
        if (!(n in outcome)) throw new Error(`job ${id} needs an undefined job ${n}`);
        needsCtx[n] = { result: outcome[n] };
      }
      const ctx: EvalContext = {
        github: { event_name: event, ref: opts.ref ?? refFor(event) },
        needs: needsCtx,
        inputs: {},
        status: {
          success: needs.every((n) => outcome[n] === 'success'),
          failure: needs.some((n) => outcome[n] === 'failure'),
          cancelled: opts.cancelled === true
        }
      };
      // A cancelled run cancels the jobs that never consulted cancelled() themselves — the whole
      // reason Actions' docs push !cancelled() over always() for a condition that drops success().
      const cancelledOut = opts.cancelled === true && !namesStatusFunction(doc.jobs[id].if);
      const ran = opts.results?.[id] ?? (cancelledOut ? 'cancelled' : 'success');
      outcome[id] = conditionHolds(doc.jobs[id].if, ctx) ? ran : 'skipped';
      pending.delete(id);
    }
  }
  return outcome;
}

/** Renders a `${{ }}`-bearing scalar (the concurrency group) for one run. */
function renderTemplate(template: string, ctx: EvalContext): string {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, body: string) => String(evaluateExpression(body, ctx)));
}

function runContext(event: string, ref?: string): EvalContext {
  return {
    github: { event_name: event, ref: ref ?? refFor(event) },
    needs: {},
    inputs: {},
    status: { success: true, failure: false, cancelled: false }
  };
}

describe('publish workflow on a pull request', () => {
  it('defines exactly the jobs these cases reason about', () => {
    expect(Object.keys(doc.jobs).sort()).toEqual([...JOB_IDS].sort());
    // Every `needs` names a job that exists, or the outcome model below is reasoning about nothing.
    for (const id of JOB_IDS) for (const n of needsOf(id)) expect(Object.keys(doc.jobs)).toContain(n);
  });

  it('builds every platform target and universal on a pull_request, with the same steps a tag runs', () => {
    const pr = jobOutcomes('pull_request');

    expect(pr.build).toBe('success');
    // The one check that the artifact actually installs runs on the PR too.
    expect(pr['codium-smoke']).toBe('success');

    const include = doc.jobs.build.strategy?.matrix?.include ?? [];
    const legs = include.map((e) => e.target);
    expect([...legs].sort()).toEqual([...VSCODE_PLATFORM_TARGETS, 'universal'].sort());
    // The document and the line parser must be reading one and the same matrix.
    expect([...legs].sort()).toEqual(buildMatrix().map((e) => e.target).sort());

    // "Same recipe" is only true if no step opts out by event: a package or scan step skipped on a PR
    // would leave the PR proving nothing while the job still reports green.
    for (const id of ['build', 'codium-smoke']) {
      for (const step of doc.jobs[id].steps ?? []) {
        expect(`${id} / ${step.name ?? step.uses ?? 'step'}: ${step.if ?? '(no if)'}`).not.toContain('event_name');
      }
    }
  });

  it('keeps the ten-leg recipe in exactly one workflow, never copied into another', () => {
    const dir = path.join(repoRoot, '.github/workflows');
    const others = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== 'publish.yml');

    expect(others.length).toBeGreaterThan(0);
    expect(workflow).toContain('vsce package');
    for (const file of others) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(`${file} :: ${text}`).not.toMatch(/vsce package|sharp-wasm32|matrix\.npm_cpu/);
    }
  });

  it('cannot reach either marketplace, or the post-publish check, on a pull_request', () => {
    const pr = jobOutcomes('pull_request');

    expect(pr.publish).toBe('skipped');
    expect(pr['verify-openvsx']).toBe('skipped');

    // Not vacuous: those commands exist, in jobs a PR skips, and a tag run does reach them.
    const publishing = [/\bovsx publish\b/, /\bvsce publish\b/];
    const jobText = (id: string): string => JSON.stringify(doc.jobs[id]);
    for (const pattern of publishing) {
      expect(JOB_IDS.filter((id) => pattern.test(jobText(id))).length).toBeGreaterThan(0);
    }
    for (const id of JOB_IDS) {
      if (pr[id] !== 'success') continue;
      for (const pattern of publishing) expect(`${id}: ${jobText(id)}`).not.toMatch(pattern);
    }

    // A fork PR is still `pull_request`; `pull_request_target` is the trigger that would hand it secrets.
    expect(Object.keys(doc.on)).not.toContain('pull_request_target');
    expect(Object.keys(doc.on)).toContain('pull_request');
  });

  it('skips its own test and test-full jobs on a pull_request, and runs them on a tag', () => {
    const pr = jobOutcomes('pull_request');

    // test.yml already runs the gate battery and the 3-OS matrix on the PR; test-full IS that workflow.
    expect(pr.test).toBe('skipped');
    expect(pr['test-full']).toBe('skipped');
    expect(doc.jobs['test-full'].uses).toBe('./.github/workflows/test.yml');

    const tag = jobOutcomes('push');
    expect(tag.test).toBe('success');
    expect(tag['test-full']).toBe('success');
  });
});

describe('publish workflow release gating', () => {
  it('still runs the whole chain on a tag when both gates pass', () => {
    // The push trigger is tags-only, so `push` here is a release run.
    expect((doc.on.push as { tags?: string[] }).tags).toEqual(['v*']);

    const tag = jobOutcomes('push');

    for (const id of JOB_IDS) expect(`${id}: ${tag[id]}`).toBe(`${id}: success`);
  });

  it('refuses to build on a tag when either gate failed or was cancelled', () => {
    // An `if:` on build (needed at all only because both gates are skipped on a PR) replaces the
    // implicit success() — the trap that would silently let a red Windows matrix publish.
    expect(new Set(needsOf('build'))).toEqual(new Set(['test', 'test-full']));

    for (const gate of ['test', 'test-full']) {
      for (const bad of ['failure', 'cancelled'] as JobResult[]) {
        const run = jobOutcomes('push', { results: { [gate]: bad } });
        expect(`${gate}=${bad}: build ${run.build}`).toBe(`${gate}=${bad}: build skipped`);
        expect(`${gate}=${bad}: publish ${run.publish}`).toBe(`${gate}=${bad}: publish skipped`);
      }
    }

    // And a run cancelled after both gates went green does not sneak a build through the same door:
    // a condition that drops the implicit success() without consulting cancelled() would build here.
    const cancelledRun = jobOutcomes('push', { cancelled: true, results: { test: 'success', 'test-full': 'success' } });
    expect(`build ${cancelledRun.build}`).not.toBe('build success');
    expect(`publish ${cancelledRun.publish}`).not.toBe('publish success');
  });

  it('cancels a superseded pull-request run and never a tag run', () => {
    const flag = doc.concurrency?.['cancel-in-progress'];
    // No concurrency block at all is the other way this fails: three pushes leave thirty legs queued.
    expect(`cancel-in-progress: ${String(flag)}`).not.toContain('undefined');
    const cancels = (event: string): boolean =>
      typeof flag === 'boolean' ? flag : truthy(evaluateExpression(unwrap(String(flag)), runContext(event)));

    expect(cancels('pull_request')).toBe(true);
    // A publish cut mid-flight leaves the marketplaces half-updated; a tag run must ride it out.
    expect(cancels('push')).toBe(false);
    expect(cancels('workflow_dispatch')).toBe(false);

    // The group must separate refs, or one PR's push cancels another PR's build.
    const group = doc.concurrency?.group;
    expect(typeof group).toBe('string');
    const render = (event: string, ref: string): string => renderTemplate(String(group), runContext(event, ref));
    expect(render('pull_request', 'refs/pull/7/merge')).toBe(render('pull_request', 'refs/pull/7/merge'));
    expect(render('pull_request', 'refs/pull/7/merge')).not.toBe(render('pull_request', 'refs/pull/8/merge'));
    expect(render('pull_request', 'refs/pull/7/merge')).not.toBe(render('push', 'refs/tags/v9.9.9'));
  });

  it('models the Actions semantics these cases lean on', () => {
    const ctx = (over: Partial<EvalContext['status']>): EvalContext => ({
      ...runContext('push'),
      needs: { a: { result: 'skipped' } },
      status: { success: false, failure: false, cancelled: false, ...over }
    });

    // No status function named: the implicit success() still applies, so a skipped dependency skips.
    expect(conditionHolds("${{ github.event_name == 'push' }}", ctx({}))).toBe(false);
    expect(conditionHolds("${{ github.event_name == 'push' }}", ctx({ success: true }))).toBe(true);
    // Naming one drops the implicit success(), which is what lets a job run past a skipped dependency.
    expect(conditionHolds('${{ !cancelled() }}', ctx({}))).toBe(true);
    expect(conditionHolds('${{ !cancelled() }}', ctx({ cancelled: true }))).toBe(false);
    expect(conditionHolds(undefined, ctx({}))).toBe(false);
    expect(conditionHolds(undefined, ctx({ success: true }))).toBe(true);
    expect(namesStatusFunction('${{ always() }}')).toBe(true);
    expect(namesStatusFunction("${{ github.event_name != 'pull_request' }}")).toBe(false);
    // Short-circuit: a taken `||` must not evaluate a right side that would throw.
    expect(truthy(evaluateExpression("github.event_name == 'push' || needs.missing.result == 'success'", ctx({})))).toBe(true);
  });
});
