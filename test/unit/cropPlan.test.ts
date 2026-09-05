import { describe, it, expect } from 'vitest';
import { cropNamesPerImage, nextCropName, scaleAndClampRect } from '../../src/cropPlan';

describe('crop plan (cropPlan.ts, real code)', () => {
  describe('nextCropName', () => {
    it('numbers a fresh crop _crop01 when no modality dir has crops', () => {
      expect(nextCropName([['a.png', 'b.jpg'], ['a.png']], 'scene')).toBe('scene_crop01.png');
    });

    it('takes the max across modality dirs so a partial earlier crop is never overwritten', () => {
      // A cancelled crop left dir 1 at _crop03 while dir 2 only reached _crop01: the next
      // shared name must be _crop04 everywhere, or dir 1's _crop02 slot would be overwritten
      // when another modality is still on the lower number.
      const dirs = [
        ['scene.png', 'scene_crop03.png'],
        ['scene.png', 'scene_crop01.png'],
        ['scene.png'],
      ];
      expect(nextCropName(dirs, 'scene')).toBe('scene_crop04.png');
    });

    it('ignores crops belonging to other tuples', () => {
      const dirs = [['scene.png', 'scene2_crop07.png', 'other_crop09.png']];
      expect(nextCropName(dirs, 'scene')).toBe('scene_crop01.png');
    });

    it('escapes regex metacharacters in the tuple name', () => {
      // 'a.b' must not match 'axb_crop09.png' via an unescaped dot.
      expect(nextCropName([['axb_crop09.png']], 'a.b')).toBe('a.b_crop01.png');
      expect(nextCropName([['a.b_crop02.png']], 'a.b')).toBe('a.b_crop03.png');
    });

    it('numbers a crop-of-a-crop against the crop tuple name', () => {
      const dirs = [['scene_crop01.png', 'scene_crop01_crop01.png']];
      expect(nextCropName(dirs, 'scene_crop01')).toBe('scene_crop01_crop02.png');
    });

    it('zero-pads to two digits and grows past 99 unpadded', () => {
      expect(nextCropName([['scene_crop09.png']], 'scene')).toBe('scene_crop10.png');
      expect(nextCropName([['scene_crop99.png']], 'scene')).toBe('scene_crop100.png');
    });
  });

  // A file list's columns can be files in ONE directory, where the tuple-wide name above is one
  // path handed out N times: two writes, one file, and which bytes survive is a race
  // (docs/crop-and-pptx.md: shared-crop-filename).
  describe('cropNamesPerImage', () => {
    it('names each crop after the image it is cut from, so columns sharing a directory get distinct paths', () => {
      const listing = ['shot_a.png', 'shot_b.png', 'notes.txt'];
      expect(cropNamesPerImage([listing, listing], ['shot_a.png', 'shot_b.png']))
        .toEqual(['shot_a_crop01.png', 'shot_b_crop01.png']);
    });

    it('numbers each image past its OWN existing crops, not past its neighbour\'s', () => {
      const listing = ['shot_a.png', 'shot_a_crop01.png', 'shot_a_crop02.png', 'shot_b.png'];
      expect(cropNamesPerImage([listing, listing], ['shot_a.png', 'shot_b.png']))
        .toEqual(['shot_a_crop03.png', 'shot_b_crop01.png']);
    });

    // The one case where two images still reduce to the same stem. Handing both `a_crop01.png`
    // would be the very collision this function exists to remove.
    it('separates two images whose stems collide across extensions', () => {
      const listing = ['a.png', 'a.jpg'];
      expect(cropNamesPerImage([listing, listing], ['a.png', 'a.jpg']))
        .toEqual(['a_crop01.png', 'a_crop02.png']);
    });

    // Discriminating on purpose: both columns hold a file called a.png, so a namesake's crops in the
    // OTHER directory are exactly what a max-across-listings rule would wrongly number past. There is
    // nothing to keep in step here — a mode-3 crop never joins its comparison, so it pairs with nothing.
    it('numbers against the image\'s own listing, not past a namesake in another column\'s directory', () => {
      expect(cropNamesPerImage(
        [['a.png'], ['a.png', 'a_crop05.png']],
        ['a.png', 'a.png'],
      )).toEqual(['a_crop01.png', 'a_crop06.png']);
    });
  });

  describe('scaleAndClampRect', () => {
    it('rounds each scaled coordinate to the nearest pixel', () => {
      const rect = scaleAndClampRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, 101, 101);
      // 50.5 rounds to 51, 25.25 rounds to 25 — Math.round semantics, not floor/ceil.
      expect(rect).toEqual({ x: 51, y: 51, w: 25, h: 25 });
    });

    it('clamps width and height to the image bounds after rounding', () => {
      const rect = scaleAndClampRect({ x: 0.9, y: 0.95, w: 0.2, h: 0.2 }, 100, 100);
      expect(rect).toEqual({ x: 90, y: 95, w: 10, h: 5 });
      expect(rect.x + rect.w).toBe(100);
      expect(rect.y + rect.h).toBe(100);
    });

    it('clamps a negative origin to zero before the size clamp', () => {
      const rect = scaleAndClampRect({ x: -0.1, y: -0.2, w: 0.5, h: 0.5 }, 100, 100);
      expect(rect.x).toBe(0);
      expect(rect.y).toBe(0);
      expect(rect.w).toBe(50);
      expect(rect.h).toBe(50);
    });

    it('produces a non-positive size when the rect rounds past the far edge (caller skips it)', () => {
      const rect = scaleAndClampRect({ x: 0.995, y: 0.995, w: 0.01, h: 0.01 }, 100, 100);
      // x rounds to 100, so the clamp leaves w at 0 — the provider skips, never crops.
      expect(rect.w).toBeLessThanOrEqual(0);
      expect(rect.h).toBeLessThanOrEqual(0);
    });
  });
});
