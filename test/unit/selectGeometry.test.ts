import { describe, it, expect } from 'vitest';
import { rectsIntersect, tilesInMarquee, tileKey, parseKey, TileRect } from '../../src/webview/select';

const tile = (key: string, left: number, top: number): TileRect => ({
  key,
  left,
  top,
  right: left + 100,
  bottom: top + 100,
});

describe('marquee selection geometry (real select.ts)', () => {
  it('rectsIntersect detects overlap and rejects gaps', () => {
    const a = { left: 0, top: 0, right: 50, bottom: 50 };
    expect(rectsIntersect(a, { left: 40, top: 40, right: 90, bottom: 90 })).toBe(true);
    expect(rectsIntersect(a, { left: 60, top: 60, right: 90, bottom: 90 })).toBe(false);
  });

  it('selects only tiles intersected by the marquee', () => {
    const tiles = [tile('0-0', 0, 0), tile('0-1', 120, 0), tile('1-0', 0, 120), tile('1-1', 120, 120)];
    // Marquee covering the left column only.
    const hit = tilesInMarquee({ left: 10, top: 10, right: 90, bottom: 200 }, tiles);
    expect(hit.sort()).toEqual(['0-0', '1-0']);
  });

  it('a marquee spanning everything selects all tiles', () => {
    const tiles = [tile('0-0', 0, 0), tile('0-1', 120, 0), tile('1-0', 0, 120)];
    expect(tilesInMarquee({ left: -5, top: -5, right: 999, bottom: 999 }, tiles).length).toBe(3);
  });

  it('tileKey / parseKey round-trip', () => {
    expect(tileKey(2, 3)).toBe('2-3');
    expect(parseKey('2-3')).toEqual({ tupleIndex: 2, modalityIndex: 3 });
  });
});
