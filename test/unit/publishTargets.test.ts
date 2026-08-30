import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
