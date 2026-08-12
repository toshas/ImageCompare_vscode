import { describe, it, expect } from 'vitest';
import { normalizeImageBytes } from '../../src/wireFormat';

describe('extension→webview image payload contract (real wireFormat code)', () => {
  it('Test 1: a Buffer is converted to a plain Uint8Array with identical bytes', () => {
    // The exact production shape: Sharp/fs hand the provider Buffers, and Buffer is a Uint8Array
    // subclass whose species even survives Uint8Array.prototype.slice — the bug that shipped.
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const out = normalizeImageBytes(buf);
    expect(out.constructor, `constructor must be Uint8Array, got ${out.constructor.name}`).toBe(Uint8Array);
    expect(out !== buf, 'a Buffer must be copied, not passed through').toBe(true);
    expect(out.byteOffset === 0 && out.byteLength === out.buffer.byteLength, 'output must be tight').toBe(true);
    expect(Buffer.compare(Buffer.from(out), buf), 'bytes must be identical').toBe(0);
  });

  it('Test 2: an offset view is copied to exactly its range', () => {
    const backing = new Uint8Array([9, 9, 7, 8, 9, 9]);
    const view = backing.subarray(2, 5);
    const out = normalizeImageBytes(view);
    expect(out !== view, 'a view must be copied').toBe(true);
    expect(out.byteLength === 3 && out.buffer.byteLength === 3, `copy must be tight to the range, got buffer ${out.buffer.byteLength}`).toBe(true);
    expect(out[0] === 7 && out[1] === 8 && out[2] === 9, 'copy must hold the view range only').toBe(true);
  });

  it('Test 3: an already-normal payload passes through without a copy', () => {
    const plain = new Uint8Array([1, 2, 3]);
    expect(normalizeImageBytes(plain), 'a tight plain Uint8Array must be returned as-is').toBe(plain);
  });

  it('Test 4: normalized payloads survive structuredClone as plain Uint8Array', () => {
    // Pins the property the webview depends on: the payload is clonable binary, not a
    // JSON-mangled object ({type:"Buffer",data:[...]}).
    const out = normalizeImageBytes(Buffer.from([10, 20, 30]));
    const cloned = structuredClone(out);
    expect(cloned instanceof Uint8Array, `clone must stay a Uint8Array, got ${Object.prototype.toString.call(cloned)}`).toBe(true);
    expect(cloned.byteLength === 3 && cloned[1] === 20, 'clone must hold the same bytes').toBe(true);
  });
});
