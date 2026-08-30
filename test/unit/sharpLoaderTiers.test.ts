import { describe, expect, it, vi } from 'vitest';

// The WASM tier of the chain (docs/image-backends.md). What is honestly pinned here is the loader's
// *decision*, not a wasm32 decode: `@img/sharp-wasm32` declares `cpu: ["wasm32"]`, so npm never
// installs it and no local checkout or CI runner has it to decode with (the tier is hand-extracted in
// publish.yml and only exists inside a VSIX). A decode was verified by hand against a tree built the
// way the workflow builds one; what a suite can hold is the part that silently rots — that a native
// load failing with `Unsupported CPU` retries with native `@img/sharp-*` made to look absent while
// wasm32 stays resolvable, that the process-global resolver is put back on every path, and that a
// wasm32 that fails too yields null rather than throwing into the caller.
//
// The seam is Module._load, which is what the loader's own `require` goes through: the test plays the
// role of the environment (an old CPU, an absent tier), never of the code under test.

const Module = require('module');

interface Probe {
  sharpLoads: number;
  nativeError: any;
  wasmError: any;
  unrelatedResolved: boolean;
}

interface Outcome {
  probe: Probe;
  sharp: unknown;
  error: string | null;
  wasmStub: unknown;
  resolverAfter: unknown;
  resolverBefore: unknown;
}

/**
 * Load a fresh sharpLoader with `require('sharp')` behaving as `firstError` describes, and — on the
 * retry — report what Sharp's own binary resolution would have seen.
 */
async function loadUnder(opts: { firstError: Error; retry: 'wasm-ok' | 'wasm-fails' }): Promise<Outcome> {
  const origLoad = Module._load;
  const resolverBefore = Module._resolveFilename;
  const wasmStub = { marker: 'wasm-sharp' };
  const probe: Probe = { sharpLoads: 0, nativeError: null, wasmError: null, unrelatedResolved: false };

  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'sharp') {
      probe.sharpLoads++;
      if (probe.sharpLoads === 1) {
        throw opts.firstError;
      }
      // Stand in for Sharp's own resolution order: native binding first, wasm32 second.
      try {
        Module._resolveFilename('@img/sharp-linux-x64', parent, false);
        probe.nativeError = null;
      } catch (e) {
        probe.nativeError = e;
      }
      try {
        Module._resolveFilename('@img/sharp-wasm32', parent, false);
        probe.wasmError = null;
      } catch (e) {
        probe.wasmError = e;
      }
      try {
        Module._resolveFilename('path', parent, false);
        probe.unrelatedResolved = true;
      } catch {
        probe.unrelatedResolved = false;
      }
      if (opts.retry === 'wasm-fails') {
        throw new Error('Could not load the "sharp" module using the wasm32 runtime');
      }
      return wasmStub;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    vi.resetModules();
    const loader = await import('../../src/sharpLoader');
    const sharp = loader.getSharp();
    const error = loader.getSharpError();
    return { probe, sharp, error, wasmStub, resolverAfter: Module._resolveFilename, resolverBefore };
  } finally {
    Module._load = origLoad;
    // Whatever the loader did, this bed leaves no global patch behind for the next spec.
    Module._resolveFilename = resolverBefore;
  }
}

describe('sharpLoader tiers', () => {
  it('retries on Unsupported CPU with native @img blocked and wasm32 left resolvable', async () => {
    const out = await loadUnder({ firstError: new Error('Unsupported CPU'), retry: 'wasm-ok' });

    expect(out.probe.sharpLoads).toBe(2);
    expect(out.probe.nativeError).toBeInstanceOf(Error);
    expect(out.probe.nativeError.code).toBe('MODULE_NOT_FOUND');
    expect(String(out.probe.nativeError.message)).toContain('Blocked native @img/sharp-linux-x64');
    // wasm32 is the one @img the block must let through; it is absent here, so a plain resolution error is the pass.
    expect(String(out.probe.wasmError?.message ?? '')).not.toContain('Blocked');
    expect(out.probe.unrelatedResolved).toBe(true);
    expect(out.sharp).toBe(out.wasmStub);
    expect(out.error).toBe(null);
  });

  it('restores the process-global resolver after a successful WASM retry', async () => {
    const out = await loadUnder({ firstError: new Error('Unsupported CPU'), retry: 'wasm-ok' });

    expect(out.resolverAfter).toBe(out.resolverBefore);
  });

  it('returns null instead of throwing when the WASM tier fails too, and still restores the resolver', async () => {
    const out = await loadUnder({ firstError: new Error('Unsupported CPU'), retry: 'wasm-fails' });

    expect(out.sharp).toBe(null);
    expect(out.error).toContain('native nor WASM');
    expect(out.resolverAfter).toBe(out.resolverBefore);
  });

  it('does not retry an error that is not the CPU/loader signature', async () => {
    const out = await loadUnder({ firstError: new Error('EACCES: permission denied'), retry: 'wasm-ok' });

    expect(out.probe.sharpLoads).toBe(1);
    expect(out.sharp).toBe(null);
    expect(out.error).toBe('EACCES: permission denied');
  });
});
