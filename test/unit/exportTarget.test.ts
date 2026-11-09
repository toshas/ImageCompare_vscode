import { describe, it, expect } from 'vitest';
import { exportOutputDir } from '../../src/exportTarget';

// Layer 1 for where a PPTX export lands (docs/session-files.md: exports-land-beside-the-images).
//
// POSIX paths throughout: `path.dirname` is platform-dependent, and the parity of the URI-vs-native
// path spaces is `test/unit/pathSpaces.test.ts`'s subject, not this one's.

describe('export output directory (exportTarget.ts, real code)', () => {
  it('mode 1 exports into the base directory the user selected', () => {
    expect(exportOutputDir({ baseDir: '/data/run', modalityDirs: [] })).toBe('/data/run');
  });

  it("mode 2 exports into the modality directories' parent, not into a modality", () => {
    expect(exportOutputDir({ modalityDirs: ['/data/run/gt', '/data/run/pred'] })).toBe('/data/run');
  });

  it('mode 3 exports into the first image\'s own directory, since a file list owns none', () => {
    expect(exportOutputDir({ modalityDirs: [], firstImagePath: '/data/shots/shot_a.png' }))
      .toBe('/data/shots');
  });

  it('prefers the base directory over every other root when the comparison has one', () => {
    expect(exportOutputDir({
      baseDir: '/data/run',
      modalityDirs: ['/elsewhere/gt'],
      firstImagePath: '/third/place/a.png',
    })).toBe('/data/run');
  });

  it('prefers a modality directory over the first image when there is no base', () => {
    expect(exportOutputDir({
      modalityDirs: ['/data/run/gt'],
      firstImagePath: '/third/place/a.png',
    })).toBe('/data/run');
  });

  it('answers undefined only when the comparison has no root at all', () => {
    expect(exportOutputDir({ modalityDirs: [] })).toBeUndefined();
  });
});
