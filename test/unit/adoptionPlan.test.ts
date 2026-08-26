// Pins the shared modality-adoption decisions (src/adoptionPlan.ts): dir qualification, the
// imageful gate, and the column-insert mutations + modalityAdded payload both products execute.
import { describe, expect, it } from 'vitest';
import { adoptableImages, applyModalityInsert, newModalityDirCandidates } from '../../src/adoptionPlan';

describe('adoptionPlan newModalityDirCandidates', () => {
  it('keeps only directories that are not dot dirs and not already columns, in listing order', () => {
    const entries = [
      { name: 'mask', isDirectory: true },
      { name: 'notes.txt', isDirectory: false },
      { name: '.git', isDirectory: true },
      { name: 'gt', isDirectory: true },
      { name: 'depth', isDirectory: true },
      { name: 'scene_01.png', isDirectory: false },
    ];
    expect(newModalityDirCandidates(entries, ['gt', 'pred'])).toEqual(['mask', 'depth']);
  });

  it('yields nothing when every directory is already a column', () => {
    const entries = [
      { name: 'gt', isDirectory: true },
      { name: 'pred', isDirectory: true },
    ];
    expect(newModalityDirCandidates(entries, ['gt', 'pred'])).toEqual([]);
  });
});

describe('adoptionPlan adoptableImages', () => {
  it('keeps only image files: non-images and subdirectories never make a dir adoptable', () => {
    const entries = [
      { name: 'a.png', isFile: true },
      { name: 'notes.txt', isFile: true },
      { name: 'b.JPEG', isFile: true },
      { name: 'nested', isFile: false },
      { name: 'c.ppmx', isFile: true },
    ];
    expect(adoptableImages(entries)).toEqual(['a.png', 'b.JPEG', 'c.ppmx']);
    expect(adoptableImages([{ name: 'readme.md', isFile: true }])).toEqual([]);
  });
});

describe('adoptionPlan applyModalityInsert', () => {
  const makeScan = () => ({
    tuples: [
      { images: [{ modality: 'pred', name: 's1_pred' }, { modality: 'gt', name: 's1_gt' }] },
      { images: [{ modality: 'gt', name: 's2_gt' }] },
    ],
    // Deliberately out-of-sort so the first tuple proves the re-sort is real.
    modalities: ['gt', 'pred'],
  });

  it('inserts alphabetically without a caller order and reports the global index on the wire', () => {
    const scan = makeScan();
    const winners = new Map<number, number>([[0, 0], [1, 1]]);
    const { insertIndex, message } = applyModalityInsert(scan, winners, 'mask', undefined, {
      modalityPath: n => `/base/${n}`,
    });
    expect(insertIndex).toBe(1);
    expect(scan.modalities).toEqual(['gt', 'mask', 'pred']);
    expect(message).toEqual({
      type: 'modalityAdded',
      modality: 'mask',
      modalityPath: '/base/mask',
      // Positional palette over the post-insert set — pinned literals, not MODALITY_COLORS re-read.
      modalityColors: ['#0f0', '#f60', '#0af'],
      modalityIndex: 1,
    });
  });

  it('shifts winner columns at/after the insertion point up in lockstep with the splice', () => {
    const scan = makeScan();
    const winners = new Map<number, number>([[0, 0], [1, 1]]);
    applyModalityInsert(scan, winners, 'mask', undefined, { modalityPath: n => n });
    // gt (0) stays; pred (was 1) is now column 2.
    expect([...winners]).toEqual([[0, 0], [1, 2]]);
  });

  it('re-sorts each tuple\'s sparse images into the post-insert modality order', () => {
    const scan = makeScan();
    applyModalityInsert(scan, new Map(), 'mask', undefined, { modalityPath: n => n });
    expect(scan.tuples[0].images.map(i => i.modality)).toEqual(['gt', 'pred']);
  });

  it('honors a caller order when the name is ranked in it, and a color override per column', () => {
    const scan = { tuples: [], modalities: ['rgb', 'depth'] };
    const { insertIndex, message } = applyModalityInsert(scan, new Map(), 'ir', ['rgb', 'ir', 'depth'], {
      modalityPath: n => `/sel/${n}`,
      colorOverride: mod => (mod === 'ir' ? '#123456' : undefined),
    });
    // The caller listed ir between rgb and depth, so it goes back to slot 1; alphabetical would have put it at 0 ('ir' < 'rgb').
    expect(insertIndex).toBe(1);
    expect(scan.modalities).toEqual(['rgb', 'ir', 'depth']);
    expect(message.modalityColors).toEqual(['#0f0', '#123456', '#0af']);
  });
});
