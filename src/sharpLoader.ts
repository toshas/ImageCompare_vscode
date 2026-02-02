/**
 * Dynamic Sharp loader with WASM fallback.
 *
 * Sharp's native binaries require x86-64-v2 (SSE4.2+). On older CPUs the
 * native @img/sharp-linux-x64 package is *present* but fails to load with
 * "Unsupported CPU". Sharp only auto-falls back to @img/sharp-wasm32 when
 * the native package is completely *missing*.
 *
 * Strategy:
 *  1. Try require('sharp') normally — works on modern CPUs.
 *  2. If that throws an "Unsupported CPU" (or similar load) error, flush
 *     every sharp-related entry from the require cache, temporarily block
 *     resolution of native @img/sharp-* packages so Sharp can only find
 *     @img/sharp-wasm32, and retry.
 *  3. If WASM also fails, set sharpInstance to null — callers must handle
 *     the fallback path.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

export type SharpType = typeof import('sharp');
export type SharpInstance = ReturnType<SharpType>;

let sharpModule: SharpType | null = null;
let loadAttempted = false;
let loadError: string | null = null;

/**
 * Returns the loaded Sharp module, or null if unavailable.
 */
export function getSharp(): SharpType | null {
  if (!loadAttempted) {
    loadSharp();
  }
  return sharpModule;
}

/**
 * Human-readable reason why Sharp could not be loaded (empty when loaded OK).
 */
export function getSharpError(): string | null {
  if (!loadAttempted) {
    loadSharp();
  }
  return loadError;
}

function loadSharp(): void {
  loadAttempted = true;

  // --- Attempt 1: normal load -------------------------------------------------
  try {
    sharpModule = require('sharp');
    return;
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    const isUnsupportedCpu =
      msg.includes('Unsupported CPU') ||
      msg.includes('Could not load the "sharp" module');

    if (!isUnsupportedCpu) {
      // Unexpected error — don't retry.
      loadError = msg;
      console.error('[ImageCompare] Sharp failed to load:', msg);
      return;
    }

    console.warn(
      '[ImageCompare] Native Sharp unavailable (likely older CPU). ' +
        'Attempting WASM fallback…'
    );
  }

  // --- Attempt 2: force WASM by blocking native @img/sharp-* resolution ------
  try {
    // Clear every sharp-related entry from the require cache so a fresh
    // require('sharp') re-runs the platform-detection logic.
    for (const key of Object.keys(require.cache)) {
      if (/[/\\](sharp|@img)[/\\]/.test(key)) {
        delete require.cache[key];
      }
    }

    const Module = require('module');
    const origResolve: Function = Module._resolveFilename;

    // Monkey-patch: any require of a *native* @img/sharp-<platform> package
    // throws, so Sharp's fallback chain skips to wasm32.
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (
        request.startsWith('@img/sharp-') &&
        !request.includes('wasm32')
      ) {
        const err: any = new Error(
          `[ImageCompare] Blocked native ${request} to force WASM fallback`
        );
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return origResolve.call(this, request, ...args);
    };

    try {
      sharpModule = require('sharp');
    } finally {
      // Always restore the original resolver.
      Module._resolveFilename = origResolve;
    }

    console.log('[ImageCompare] Sharp loaded via WASM fallback.');
  } catch (e2: any) {
    sharpModule = null;
    loadError =
      'Sharp could not be loaded (native nor WASM). ' +
      'Image thumbnails will use a JS fallback. ' +
      `(${e2?.message ?? e2})`;
    console.error('[ImageCompare]', loadError);
  }
}
