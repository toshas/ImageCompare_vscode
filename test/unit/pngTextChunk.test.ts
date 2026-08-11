import { describe, it, expect } from 'vitest';
import { crc32, pngInjectText, pngReadText } from '../../src/pngText';
import { makeSolidPng } from '../fixtures/synthetic';

const KW = 'ImageCompare:CropRect';

describe('PNG tEXt chunk round-trip (real thumbnailService code)', () => {
  it('injects and reads back a value', () => {
    const png = makeSolidPng(4, 4, [255, 0, 0]);
    const out = pngInjectText(png, KW, 'hello');
    expect(pngReadText(out, KW)).toBe('hello');
    expect(out.length).toBeGreaterThan(png.length);
  });

  it('round-trips crop metadata format x,y,w,h,srcW,srcH', () => {
    const png = makeSolidPng(8, 8, [0, 128, 255]);
    const value = '10,20,100,200,1920,1080';
    const out = pngInjectText(png, KW, value);
    const read = pngReadText(out, KW);
    expect(read).toBe(value);
    expect(read!.split(',').map(Number)).toEqual([10, 20, 100, 200, 1920, 1080]);
  });

  it('returns null for a missing keyword', () => {
    const png = makeSolidPng(2, 2, [1, 2, 3]);
    expect(pngReadText(png, KW)).toBeNull();
  });

  it('returns null when reading a different keyword than was injected', () => {
    const png = makeSolidPng(2, 2, [4, 5, 6]);
    const out = pngInjectText(png, 'KeyA', 'valueA');
    expect(pngReadText(out, 'KeyB')).toBeNull();
  });

  it('keeps multiple chunks independent', () => {
    let png = makeSolidPng(4, 4, [10, 10, 10]);
    png = pngInjectText(png, 'A', 'one');
    png = pngInjectText(png, 'B', 'two');
    expect(pngReadText(png, 'A')).toBe('one');
    expect(pngReadText(png, 'B')).toBe('two');
  });

  it('preserves PNG signature and a walkable chunk chain ending in IEND', () => {
    const png = makeSolidPng(4, 4, [9, 9, 9]);
    const out = pngInjectText(png, KW, 'x');
    expect(out[0]).toBe(0x89);
    expect(out.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(out.subarray(0, 8)).toEqual(png.subarray(0, 8)); // signature
    // Walk the chunk chain by declared lengths; it must land exactly on IEND.
    let off = 8;
    let lastType = '';
    while (off + 8 <= out.length) {
      lastType = out.subarray(off + 4, off + 8).toString('ascii');
      if (lastType === 'IEND') break;
      off += 12 + out.readUInt32BE(off);
    }
    expect(lastType).toBe('IEND');
  });

  it('handles large coordinate values', () => {
    const png = makeSolidPng(2, 2, [0, 0, 0]);
    const value = '999999,888888,777777,666666,4096,4096';
    expect(pngReadText(pngInjectText(png, KW, value), KW)).toBe(value);
  });

  it('CRC-32 matches the canonical IEEE check value', () => {
    // Pinned to the spec constant, not to our own (or zlib's) implementation.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('CRC-32 full-table probe: every one of the 256 table entries is load-bearing', () => {
    // "123456789" touches only 8 of the 256 table entries; these bytes touch all
    // 256, so any single corrupt entry moves the result. Expected value
    // cross-checked against zlib.crc32 and a table-free bitwise CRC-32 — pinned
    // as a constant so neither is needed at run time.
    const fullTableProbe = Buffer.from(
      'fffe6be0d834aa3263bdabe8bf53cd5514aea85c16fa64fcad736526719d039bfa88ae3445a937affe20367522ce50c8' +
      '893335c18b67f96130eef8bbec009e0627c5a2e4e30f9109588690d38468f66e2f9593672dc15fc796485e1d4aa638a0' +
      'c1b3950f7e920c94c51b0d4e19f56bf3b2080efab05cc25a0bd5c380d73ba53d9c5eba44ae42dc4415cbdd9ec925bb23' +
      '62d8de2a608c128adb05135007eb75ed8cfed84233df41d98856400354b826beff4543b7fd118f1746988ecd9a76e870' +
      '51b3d4929579e77f2ef0e6a5f21e801859e3e5115bb729b1e03e286b3cd04ed6b7c5e37908e47ae2b36d7b386f831d85' +
      'c47e788cc62ab42c7da3b5f6a14dd34b',
      'hex'
    );
    expect(crc32(fullTableProbe)).toBe(0xd2a7d615);
  });

  it('stores the tEXt chunk CRC a decoder would verify (covers type+data)', () => {
    const injected = pngInjectText(makeSolidPng(4, 4, [1, 1, 1]), 'K', 'v');
    let off = 8;
    let found = false;
    while (off + 8 <= injected.length) {
      const len = injected.readUInt32BE(off);
      const type = injected.subarray(off + 4, off + 8).toString('ascii');
      if (type === 'tEXt') {
        const stored = injected.readUInt32BE(off + 8 + len);
        expect(stored).toBe(crc32(injected.subarray(off + 4, off + 8 + len)));
        found = true;
        break;
      }
      if (type === 'IEND') break;
      off += 12 + len;
    }
    expect(found).toBe(true);
  });

  it('Sharp validates an injected PNG (mint with Sharp, re-read with Sharp)', async () => {
    const sharp = (await import('sharp')).default;
    const minted: Buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const injected = pngInjectText(minted, KW, '10,20,30,40,100,100');
    expect(pngReadText(injected, KW)).toBe('10,20,30,40,100,100');
    const meta = await sharp(injected).metadata();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(4);
    expect(meta.format).toBe('png');
  });
});
