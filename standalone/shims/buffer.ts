/** Minimal browser Buffer: exactly the subset the bundled src/ modules use, injected as the global by scripts/build-standalone.mjs; scripts/check-sidedness.mjs gate (d) is what keeps "exactly" true (docs/standalone.md: shim-covers-bundled-calls). */

type MiniEncoding = 'utf8' | 'utf-8' | 'latin1' | 'binary' | 'ascii';

class MiniBuffer extends Uint8Array {
  toString(encoding: MiniEncoding = 'utf8', start = 0, end = this.length): string {
    const view = this.subarray(start, end);
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return new TextDecoder().decode(view);
    }
    let out = '';
    for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
    return out;
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const src = this.subarray(sourceStart, sourceEnd);
    target.set(src, targetStart);
    return src.length;
  }

  readUInt32BE(offset: number): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, false);
  }

  writeUInt32BE(value: number, offset: number): number {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset, value >>> 0, false);
    return offset + 4;
  }

  readFloatLE(offset: number): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat32(offset, true);
  }
}

function miniFrom(value: string | Uint8Array | ArrayBuffer | number[], encoding?: MiniEncoding): MiniBuffer {
  if (typeof value === 'string') {
    const enc = encoding ?? 'utf8';
    if (enc === 'utf8' || enc === 'utf-8') {
      return new MiniBuffer(new TextEncoder().encode(value));
    }
    // latin1/binary/ascii: one byte per char code.
    const out = new MiniBuffer(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
  if (value instanceof ArrayBuffer) return new MiniBuffer(new Uint8Array(value));
  return new MiniBuffer(value);
}

function miniConcat(list: readonly Uint8Array[]): MiniBuffer {
  let total = 0;
  for (const b of list) total += b.length;
  const out = new MiniBuffer(total);
  let offset = 0;
  for (const b of list) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

// Typed as node's Buffer so callers of pngText/ppmxParser typecheck; statics attached by assignment because subclassing Uint8Array's static `from` overloads is not type-compatible.
const BufferShim = MiniBuffer as unknown as typeof globalThis.Buffer;
BufferShim.from = miniFrom as unknown as typeof BufferShim.from;
BufferShim.alloc = ((size: number) => new MiniBuffer(size)) as unknown as typeof BufferShim.alloc;
BufferShim.concat = miniConcat as unknown as typeof BufferShim.concat;
// `false` for a plain Uint8Array is the load-bearing half: it is what makes cropFlow wrap raw canvas bytes before pngText reads them (docs/standalone.md: shim-covers-bundled-calls).
BufferShim.isBuffer = ((v: unknown) => v instanceof MiniBuffer) as unknown as typeof BufferShim.isBuffer;

export { BufferShim as Buffer };
