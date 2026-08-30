import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Uri } from '../mocks/vscode';
import { makeSolidPng } from '../fixtures/synthetic';
import { settleServices, type FlushableService } from '../helpers/providerQuiesce';

// The last tier of the chain (docs/image-backends.md): Sharp absent -> Jimp. Nothing tested it, and
// the universal VSIX now ships with no native tier at all, so this is the tier a whole platform
// target can land on. The REAL ThumbnailService runs here against the REAL Jimp; what is simulated is
// the *environment* — `require('sharp')` throws `Unsupported CPU` the way an old CPU makes it throw,
// and the real sharpLoader then finds no wasm32 either, exactly as on a machine without the tier.
// The input PNG is hand-built (makeSolidPng) and the output dimensions are read straight out of the
// JPEG's SOF marker, so neither end of the assertion comes from an image library.

const tmpRoots: string[] = [];
// Every service this file built: `initialize()` creates a real thumbnail-cache dir and `getThumbnail`
// writes into it un-awaited, so without the flush a .jpg can land inside the rmSync below — invisible
// on POSIX, ENOTEMPTY on Windows (docs/image-backends.md: thumb-pack-survives-close; docs/testing.md).
const services: FlushableService[] = [];
afterAll(async () => {
  await settleServices(services);
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

/** Width/height from the JPEG frame header — an external pin: no backend decodes this. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker in the produced JPEG');
}

interface Bed {
  svc: any;
  src: Uri;
  sharp: unknown;
}

/** Load a fresh ThumbnailService whose sharpLoader has already failed both Sharp tiers. */
async function bedWithoutSharp(image: Buffer, name = 'src.png'): Promise<Bed> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-jimp-'));
  tmpRoots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, image);

  const Module = require('module');
  const origLoad = Module._load;
  let sharp: unknown;
  let ThumbnailService: any;
  Module._load = function (request: string, ...args: any[]) {
    if (request === 'sharp') {
      // What an x86-64-v1 machine does with the native binary present; wasm32 is absent here, as after any normal npm install.
      throw new Error('Unsupported CPU');
    }
    return origLoad.call(this, request, ...args);
  };
  try {
    vi.resetModules();
    const loader = await import('../../src/sharpLoader');
    const svcMod = await import('../../src/thumbnailService');
    sharp = loader.getSharp();
    ThumbnailService = svcMod.ThumbnailService;
  } finally {
    Module._load = origLoad;
  }

  const ctx = { globalStorageUri: Uri.file(path.join(root, 'storage')) } as any;
  const svc = new ThumbnailService(ctx);
  await svc.initialize();
  services.push(svc);
  return { svc, src: Uri.file(file), sharp };
}

describe('Jimp fallback tier', () => {
  it('generates a real thumbnail when Sharp is unavailable', async () => {
    const bed = await bedWithoutSharp(makeSolidPng(60, 30, [200, 40, 40]));
    expect(bed.sharp).toBe(null);

    const bytes: Buffer = await bed.svc.getThumbnail(bed.src, 20);

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.subarray(bytes.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
    // 60x30 fitted inside 20x20 — the same box the Sharp branch resizes into.
    expect(jpegSize(bytes)).toEqual({ width: 20, height: 10 });

    // Real pixels, not just a well-formed header: the solid red survives the round trip.
    const { Jimp } = require('jimp');
    const decoded = await Jimp.fromBuffer(bytes);
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(10);
    const d = decoded.bitmap.data;
    expect(d[0]).toBeGreaterThan(150);
    expect(d[1]).toBeLessThan(110);
    expect(d[2]).toBeLessThan(110);
  });

  it('converts a full image to PNG when Sharp is unavailable', async () => {
    const bed = await bedWithoutSharp(makeSolidPng(24, 12, [10, 220, 30]));
    const buffer = fs.readFileSync(bed.src.fsPath);

    const out = await bed.svc.convertFullImage(buffer, '.png');

    expect(out.mime).toBe('image/png');
    expect(out.width).toBe(24);
    expect(out.height).toBe(12);
    expect(Buffer.from(out.bytes.subarray(0, 8))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });
});
