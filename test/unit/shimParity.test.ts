import { describe, it, expect, vi, afterEach } from 'vitest';
import { Buffer as BufferShim } from '../../standalone/shims/buffer';
import { performCrop, CropFlowIo } from '../../src/cropFlow';
import { pngReadText, CROP_RECT_KEYWORD } from '../../src/pngText';
import { ExtensionMessage, asTuple } from '../../src/types';
import { makeSolidPng } from '../fixtures/synthetic';

// Shim-parity suite. Shared src/ modules compile against node's Buffer types but run in the browser
// against standalone/shims/buffer.ts; a unit test that imports cropFlow alone gets node's real
// Buffer and therefore CANNOT see a missing shim static. These tests run the real shared flow with
// globalThis.Buffer replaced by the real shim — the same substitution esbuild's `inject` performs
// for the standalone bundle — so a static the shim lacks fails here instead of in a user's browser.

type Img = { name: string; modality: string };
type Saved = { path: string };

afterEach(() => { vi.unstubAllGlobals(); });

describe('standalone Buffer shim surface', () => {
  it('provides every Buffer static the shared modules call, including isBuffer', () => {
    for (const name of ['from', 'alloc', 'concat', 'isBuffer']) {
      expect(typeof (BufferShim as unknown as Record<string, unknown>)[name], `Buffer.${name}`).toBe('function');
    }
  });

  it('isBuffer discriminates shim buffers from plain Uint8Array', () => {
    expect(BufferShim.isBuffer(BufferShim.from([1, 2, 3]))).toBe(true);
    expect(BufferShim.isBuffer(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(BufferShim.isBuffer('not bytes')).toBe(false);
    // The false answer is what matters: plain bytes must get wrapped, or pngText's readUInt32BE is missing.
    const wrapped = BufferShim.from(new Uint8Array([0, 0, 0, 7]));
    expect(typeof wrapped.readUInt32BE).toBe('function');
    expect(wrapped.readUInt32BE(0)).toBe(7);
  });
});

describe('crop flow on the browser Buffer shim', () => {
  it('injects the crop tEXt and reports cropComplete when renderCrop returns plain Uint8Array bytes', async () => {
    const realPng = makeSolidPng(2, 2, [1, 2, 3]);
    const canvasBytes = new Uint8Array(realPng); // what a browser canvas blob hands back: no Buffer methods
    const log: string[] = [];
    const written = new Map<string, Uint8Array>();
    const io: CropFlowIo<Img, Saved> = {
      listDirNames: async () => [],
      getDimensions: async () => ({ width: 100, height: 100 }),
      renderCrop: async () => canvasBytes,
      writeCrop: async (image, outputName, bytes) => {
        const path = `/root/${image.modality}/${outputName}`;
        written.set(path, Uint8Array.from(bytes));
        return { path };
      },
      arriveFile: saved => { log.push(`arrive:${saved.path}`); },
      post: (m: ExtensionMessage) => {
        if (m.type === 'cropComplete') log.push(`post:cropComplete:${m.count}`);
        else if (m.type === 'cropError') log.push(`post:cropError:${m.error}`);
        else log.push(`post:${m.type}`);
      },
    };

    vi.stubGlobal('Buffer', BufferShim);
    try {
      await performCrop(
        { tuples: [{ name: 'shot', images: [{ name: 't.png', modality: 'a' }] }] },
        { tupleIndex: asTuple(0), cropRect: { x: 10, y: 20, w: 30, h: 40 }, srcWidth: 100, srcHeight: 100 },
        io
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(log).toEqual(['arrive:/root/a/shot_crop01.png', 'post:cropComplete:1']);
    const bytes = written.get('/root/a/shot_crop01.png');
    expect(bytes).toBeDefined();
    expect(pngReadText(Buffer.from(bytes!), CROP_RECT_KEYWORD)).toBe('10,20,30,40,100,100');
  });
});
