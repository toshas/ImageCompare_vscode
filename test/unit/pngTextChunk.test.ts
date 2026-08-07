import { describe, it, expect } from 'vitest';
import { pngInjectText, pngReadText } from '../../src/pngText';
import { makeSolidPng } from '../fixtures/synthetic';

const KW = 'ImageCompare:CropRect';

describe('PNG tEXt chunk round-trip (real thumbnailService code)', () => {
  it('injects and reads back a value', () => {
    const png = makeSolidPng(4, 4, [255, 0, 0]);
    const out = pngInjectText(png, KW, 'hello');
    expect(pngReadText(out, KW)).toBe('hello');
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

  it('keeps multiple chunks independent', () => {
    let png = makeSolidPng(4, 4, [10, 10, 10]);
    png = pngInjectText(png, 'A', 'one');
    png = pngInjectText(png, 'B', 'two');
    expect(pngReadText(png, 'A')).toBe('one');
    expect(pngReadText(png, 'B')).toBe('two');
  });

  it('preserves PNG signature and IEND', () => {
    const png = makeSolidPng(4, 4, [9, 9, 9]);
    const out = pngInjectText(png, KW, 'x');
    expect(out.subarray(0, 8)).toEqual(png.subarray(0, 8)); // signature
    expect(out.subarray(out.length - 8, out.length - 4).toString('ascii')).toBe('IEND');
  });

  it('handles large coordinate values', () => {
    const png = makeSolidPng(2, 2, [0, 0, 0]);
    const value = '999999,888888,777777,666666,4096,4096';
    expect(pngReadText(pngInjectText(png, KW, value), KW)).toBe(value);
  });
});
