import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The mutation harness mutates a sandbox copy of the tree, never the working tree
// (docs/testing.md). These specs drive the REAL scripts/mutation-check.mjs as a child
// process and signal it: the only honest way to test an exit path.
//
// Windows is out of scope: the harness is an ubuntu-only CI gate, `npx` is not spawnable
// the same way there, and Windows has no SIGHUP/SIGQUIT to deliver.

const repoRoot = path.resolve(__dirname, '../..');
const HARNESS = path.join(repoRoot, 'scripts/mutation-check.mjs');

// The probe mutation: a real entry of the harness's own list, with the smallest suite.
const PROBE_REL = 'src/wireFormat.ts';
const PROBE_ABS = path.join(repoRoot, PROBE_REL);
const PROBE_SUITE = 'test/unit/wireFormat.test.ts';
const PROBE_MUTATION = 'wireFormat: payload normalization removed';
const PROBE_FIND = 'return new Uint8Array(bytes);';

// A behaviour-free transform of the same file: applying it to the working tree is
// indistinguishable from the harness poisoning it, which is what the manifest must catch.
const HARMLESS_FIND = '  // new Uint8Array(view) copies';
const HARMLESS_REPLACE = '  // new Uint8Array(view) then copies';

const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function atomicWrite(target: string, bytes: Buffer): void {
  // A rename, so a parallel test importing this module never sees a half-written file.
  const tmp = `${target}.mutationHarness.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
}

type HarnessChild = ChildProcessByStdio<null, Readable, Readable>;

interface HarnessRun {
  child: HarnessChild;
  output: () => string;
  waitFor: (re: RegExp, ms?: number) => Promise<RegExpExecArray>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const live: HarnessRun[] = [];
const sandboxes: string[] = [];

function startHarness(seam: Record<string, unknown>): HarnessRun {
  const env: NodeJS.ProcessEnv = { ...process.env, MUTATION_CHECK_TEST: JSON.stringify(seam) };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  const child: HarnessChild = spawn(process.execPath, [HARNESS], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let buffer = '';
  let closed = false;
  const waiters: { re: RegExp; resolve: (m: RegExpExecArray) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  const pump = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (const w of [...waiters]) {
      const m = w.re.exec(buffer);
      if (!m) continue;
      clearTimeout(w.timer);
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`harness exited before ${w.re} appeared:\n${buffer}`));
      }
      resolve({ code, signal });
    });
  });

  const waitFor = (re: RegExp, ms = 60_000) => new Promise<RegExpExecArray>((resolve, reject) => {
    const hit = re.exec(buffer);
    if (hit) return resolve(hit);
    if (closed) return reject(new Error(`harness already exited without ${re}:\n${buffer}`));
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}:\n${buffer}`)), ms);
    waiters.push({ re, resolve, reject, timer });
  });

  const run: HarnessRun = { child, output: () => buffer, waitFor, exit };
  live.push(run);
  return run;
}

async function sandboxOf(run: HarnessRun): Promise<string> {
  const box = (await run.waitFor(/Sandbox: (\S+)/))[1];
  sandboxes.push(box);
  return box;
}

afterEach(() => {
  for (const run of live.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  }
  for (const box of sandboxes.splice(0)) fs.rmSync(box, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('mutation harness isolation', () => {
  it('a completed run kills its mutation, drops the sandbox, and never writes the working tree', async () => {
    const before = hash(PROBE_ABS);
    const run = startHarness({ only: PROBE_MUTATION });
    const box = await sandboxOf(run);
    const { code } = await run.exit;

    expect(run.output()).toContain(`KILLED   ${PROBE_MUTATION}`);
    expect(run.output()).toContain('killed: 1  survived: 0  errors: 0');
    expect(code).toBe(0);
    expect(hash(PROBE_ABS)).toBe(before);
    expect(fs.existsSync(box)).toBe(false);
  }, 120_000);

  it('the sandbox is complete enough to resolve the vscode mock alias', async () => {
    const run = startHarness({ only: 'tuple: row sort reversed' });
    await sandboxOf(run);
    const { code } = await run.exit;

    expect(run.output()).toContain('green  test/unit/tupleMatching.test.ts');
    expect(run.output()).toContain('KILLED   tuple: row sort reversed');
    expect(code).toBe(0);
  }, 120_000);

  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'] as const) {
    it(`leaves src/ byte-identical when the run is killed with ${signal}`, async () => {
      const before = hash(PROBE_ABS);
      const run = startHarness({ only: PROBE_MUTATION, pauseMs: 120_000 });
      const box = await sandboxOf(run);
      await run.waitFor(/##MC applied/);

      // Mid-mutation: the sandbox copy carries it, the working tree does not.
      expect(fs.readFileSync(path.join(box, PROBE_REL), 'utf8')).not.toContain(PROBE_FIND);
      expect(fs.readFileSync(PROBE_ABS, 'utf8')).toContain(PROBE_FIND);

      run.child.kill(signal);
      const { code } = await run.exit;

      expect(code).toBe(130);
      expect(hash(PROBE_ABS)).toBe(before);
      expect(fs.existsSync(box)).toBe(false);
    }, 120_000);
  }

  it('leaves src/ byte-identical when the run is SIGKILLed, leaving a stale temp dir instead', async () => {
    const before = hash(PROBE_ABS);
    const run = startHarness({ only: PROBE_MUTATION, pauseMs: 120_000 });
    const box = await sandboxOf(run);
    await run.waitFor(/##MC applied/);

    run.child.kill('SIGKILL');
    const { signal } = await run.exit;

    expect(signal).toBe('SIGKILL');
    expect(hash(PROBE_ABS)).toBe(before);
    // What is left behind is a stale sandbox, not stale source.
    expect(fs.existsSync(box)).toBe(true);
    expect(fs.readFileSync(path.join(box, PROBE_REL), 'utf8')).not.toContain(PROBE_FIND);
  }, 120_000);

  it('leaves src/ byte-identical when an uncaught exception ends the run', async () => {
    const before = hash(PROBE_ABS);
    const run = startHarness({ only: PROBE_MUTATION, pauseMs: 120_000, throwAfterApply: true });
    const box = await sandboxOf(run);
    const { code } = await run.exit;

    expect(run.output()).toContain('MUTATION_CHECK_TEST injected failure');
    expect(code).toBe(1);
    expect(hash(PROBE_ABS)).toBe(before);
    expect(fs.existsSync(box)).toBe(false);
  }, 120_000);

  it('still errors, non-zero, on a find string that is absent', async () => {
    const before = hash(PROBE_ABS);
    const run = startHarness({
      mutations: [{
        name: 'probe: absent find',
        file: PROBE_REL,
        suite: PROBE_SUITE,
        find: 'a find string that is not in the file',
        replace: 'nor is this one',
        killedBy: 'nothing — this probe exists to test the harness error path'
      }]
    });
    const box = await sandboxOf(run);
    const { code } = await run.exit;

    expect(run.output()).toContain(`find string not found in ${PROBE_REL}`);
    expect(run.output()).toContain('errors: 1');
    expect(code).toBe(1);
    expect(hash(PROBE_ABS)).toBe(before);
    expect(fs.existsSync(box)).toBe(false);
  }, 120_000);

  it('is neither corrupted by an edit landing mid-run, nor corrupts it', async () => {
    const original = fs.readFileSync(PROBE_ABS);
    const edited = Buffer.concat([original, Buffer.from('\n// edited while the mutation harness was running\n')]);
    try {
      const run = startHarness({ only: PROBE_MUTATION, pauseMs: 3000 });
      await sandboxOf(run);
      await run.waitFor(/##MC applied/);
      atomicWrite(PROBE_ABS, edited);
      const { code } = await run.exit;

      expect(run.output()).toContain(`KILLED   ${PROBE_MUTATION}`);
      expect(run.output()).toContain('changed while the run was in progress');
      expect(code).toBe(0);
      expect(fs.readFileSync(PROBE_ABS)).toEqual(edited);
    } finally {
      atomicWrite(PROBE_ABS, original);
    }
  }, 120_000);

  it('fails loudly, naming the file, when a tracked file ends the run holding this run\'s mutation', async () => {
    const original = fs.readFileSync(PROBE_ABS);
    const poisoned = Buffer.from(original.toString('utf8').replace(HARMLESS_FIND, HARMLESS_REPLACE));
    expect(poisoned.equals(original)).toBe(false);
    try {
      const run = startHarness({
        mutations: [{
          name: 'probe: comment reworded',
          file: PROBE_REL,
          suite: PROBE_SUITE,
          find: HARMLESS_FIND,
          replace: HARMLESS_REPLACE,
          killedBy: 'nothing — this probe exists to test the manifest'
        }],
        pauseMs: 3000
      });
      await sandboxOf(run);
      await run.waitFor(/##MC applied/);
      atomicWrite(PROBE_ABS, poisoned);
      const { code } = await run.exit;

      expect(run.output()).toContain('MANIFEST MISMATCH');
      expect(run.output()).toContain(PROBE_ABS);
      expect(code).not.toBe(0);
    } finally {
      atomicWrite(PROBE_ABS, original);
    }
  }, 120_000);
});
