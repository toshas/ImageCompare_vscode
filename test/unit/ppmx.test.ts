import { describe, it, expect } from 'vitest';
import { parsePpmx, parsePpmxRaw, renderPpmxRgb } from '../../src/ppmxParser';
import { makePpmx, gradientPpmx } from '../fixtures/synthetic';

describe('ppmxParser', () => {
  it('parses dimensions and float values (row-major, LE)', () => {
    const buf = makePpmx(3, 2, (x, y) => x + y * 10);
    const raw = parsePpmxRaw(buf);
    expect(raw.width).toBe(3);
    expect(raw.height).toBe(2);
    expect(Array.from(raw.values)).toEqual([0, 1, 2, 10, 11, 12]);
    expect(raw.min).toBe(0);
    expect(raw.max).toBe(12);
  });

  it('rejects a bad magic header', () => {
    const bad = Buffer.concat([Buffer.from('PX\n2 2\n00000000000\n'), Buffer.alloc(16)]);
    expect(() => parsePpmxRaw(bad)).toThrow(/header/i);
  });

  it('rejects a truncated data section', () => {
    const truncated = Buffer.concat([Buffer.from('P7\n4 4\n00000000000\n'), Buffer.alloc(8)]);
    expect(() => parsePpmxRaw(truncated)).toThrow(/size mismatch/i);
  });

  it('grayscale colormap maps min->0 and max->255', () => {
    const raw = parsePpmxRaw(gradientPpmx(8, 1));
    const rgb = renderPpmxRgb(raw, 'grayscale');
    expect([rgb[0], rgb[1], rgb[2]]).toEqual([0, 0, 0]); // first pixel = min
    const last = (8 - 1) * 3;
    expect([rgb[last], rgb[last + 1], rgb[last + 2]]).toEqual([255, 255, 255]); // max
  });

  it('jet colormap differs from grayscale and stays in range', () => {
    const raw = parsePpmxRaw(gradientPpmx(16, 1));
    const jet = renderPpmxRgb(raw, 'jet');
    const gray = renderPpmxRgb(raw, 'grayscale');
    expect(Buffer.compare(jet, gray)).not.toBe(0);
    for (const v of jet) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(255);
  });

  it('handles non-finite values without NaN output', () => {
    const buf = makePpmx(2, 1, (x) => (x === 0 ? NaN : 1));
    const data = parsePpmx(buf);
    for (const v of data.rgbBuffer) expect(Number.isFinite(v)).toBe(true);
  });

  it('rotate90cw orientation swaps dimensions when hint is orthogonal', () => {
    // Source is landscape 4x2; hint is portrait => expect rotate90cw.
    const buf = makePpmx(4, 2, (x, y) => x + y * 4);
    const raw = parsePpmxRaw(buf, { orientationHint: { width: 2, height: 4 } });
    expect(raw.orientation).toBe('rotate90cw');
    expect(raw.width).toBe(2);
    expect(raw.height).toBe(4);
  });

  it('no rotation when hint matches orientation', () => {
    const buf = makePpmx(4, 2, () => 0.5);
    const raw = parsePpmxRaw(buf, { orientationHint: { width: 8, height: 4 } });
    expect(raw.orientation).toBe('none');
    expect(raw.width).toBe(4);
  });
});
