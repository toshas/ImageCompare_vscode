import { describe, it, expect } from 'vitest';
import type PptxGenJS from 'pptxgenjs';
import { buildDeck, DeckIo } from '../../src/pptxDeck';
import { asOriginal, asTuple, OriginalModalityIndex, TupleIndex } from '../../src/types';
import type { CropMeta } from '../../src/pngText';

// A recorder standing in for PptxGenJS: buildDeck only ever calls addSlide/addImage/addText/addShape
// and sets layout/title, so recording those pins slide selection and pairing without rendering XML.
interface RecordedSlide {
  images: Array<{ data: string; x: number; y: number; w: number; h: number }>;
  texts: Array<{ text: string; opts: Record<string, unknown> }>;
  shapes: Array<{ shape: string; opts: Record<string, unknown> }>;
}

function makePptxRecorder() {
  const slides: RecordedSlide[] = [];
  const recorder = {
    layout: '',
    title: '',
    addSlide() {
      const rec: RecordedSlide = { images: [], texts: [], shapes: [] };
      slides.push(rec);
      return {
        addImage(opts: RecordedSlide['images'][0]) { rec.images.push(opts); },
        addText(text: string, opts: Record<string, unknown>) { rec.texts.push({ text, opts }); },
        addShape(shape: string, opts: Record<string, unknown>) { rec.shapes.push({ shape, opts }); },
      };
    },
  };
  return { pptx: recorder as unknown as PptxGenJS, recorder, slides };
}

// Stub io: image data encodes (tupleIndex, modalityIndex) so assertions can say whose pixels landed
// on which slide; `missing` simulates a tuple lacking that modality (io returns null, like the host).
function makeIo(opts: { missing?: Array<[number, number]>; cropMeta?: CropMeta | null } = {}) {
  const loadCalls: Array<[number, number]> = [];
  const metaCalls: Array<[number, string]> = [];
  const io: DeckIo = {
    async loadImage(tupleIndex, modalityOriginalIndex) {
      loadCalls.push([tupleIndex, modalityOriginalIndex]);
      if (opts.missing?.some(([t, m]) => t === tupleIndex && m === modalityOriginalIndex)) return null;
      return { data: `img:${tupleIndex}:${modalityOriginalIndex}`, width: 200, height: 100 };
    },
    async readCropMeta(tupleIndex, modality) {
      metaCalls.push([tupleIndex, modality]);
      return opts.cropMeta ?? null;
    },
  };
  return { io, loadCalls, metaCalls };
}

const ti = (ns: number[]): TupleIndex[] => ns.map(asTuple);
const mi = (ns: number[]): OriginalModalityIndex[] => ns.map(asOriginal);
const win = (ns: Array<number | null>): Array<OriginalModalityIndex | null> =>
  ns.map(n => (n === null ? null : asOriginal(n)));

const captionModality = (s: RecordedSlide) => s.texts[1].text;

describe('pptx deck builder (pptxDeck.ts, real code)', () => {
  const plainTuples = [{ name: 'scene_000' }, { name: 'scene_001' }];
  const modalities = ['GT', 'PRED'];

  it('sets 16:9 layout and the deck title on the injected instance', async () => {
    const { pptx, recorder } = makePptxRecorder();
    const { io } = makeIo();
    await buildDeck(pptx, plainTuples, modalities, ti([0]), win([null]), mi([0, 1]), io);
    expect(recorder.layout).toBe('LAYOUT_16x9');
    expect(recorder.title).toBe('ImageCompare Export');
  });

  it('emits one plain slide per modality with the tuple caption', async () => {
    const { pptx, slides } = makePptxRecorder();
    const { io } = makeIo();
    await buildDeck(pptx, plainTuples, modalities, ti([0]), win([null]), mi([0, 1]), io);
    expect(slides.length).toBe(2);
    expect(slides[0].images.map(i => i.data)).toEqual(['img:0:0']);
    expect(slides[1].images.map(i => i.data)).toEqual(['img:0:1']);
    expect(slides[0].texts[0].text).toBe('scene_000');
    expect(captionModality(slides[0])).toBe('GT');
    expect(captionModality(slides[1])).toBe('PRED');
  });

  it('orders slides by modalityOrder (display order), not original index order', async () => {
    const { pptx, slides } = makePptxRecorder();
    const { io } = makeIo();
    await buildDeck(pptx, plainTuples, modalities, ti([0]), win([null]), mi([1, 0]), io);
    expect(captionModality(slides[0])).toBe('PRED');
    expect(captionModality(slides[1])).toBe('GT');
  });

  it('marks exactly the winner caption with the check and the winner color', async () => {
    const { pptx, slides } = makePptxRecorder();
    const { io } = makeIo();
    await buildDeck(pptx, plainTuples, modalities, ti([0]), win([1]), mi([0, 1]), io);
    expect(captionModality(slides[0])).toBe('GT');
    expect(slides[0].texts[1].opts.color).toBe('000000');
    expect(captionModality(slides[1])).toBe('✓ PRED');
    expect(slides[1].texts[1].opts.color).toBe('008800');
  });

  it('skips the slide when a tuple lacks that modality (io returns null)', async () => {
    const { pptx, slides } = makePptxRecorder();
    const { io } = makeIo({ missing: [[0, 0]] });
    await buildDeck(pptx, plainTuples, modalities, ti([0]), win([null]), mi([0, 1]), io);
    expect(slides.length).toBe(1);
    expect(slides[0].images[0].data).toBe('img:0:1');
  });

  describe('parent/crop pairing', () => {
    const cropTuples = [{ name: 'scene_000' }, { name: 'scene_000_crop01' }, { name: 'scene_001' }];

    it('a voted crop never ships without its parent: each slide carries crop plus parent callout', async () => {
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo();
      await buildDeck(pptx, cropTuples, modalities, ti([1]), win([0]), mi([0, 1]), io);
      expect(slides.length).toBe(2);
      for (const [i, slide] of slides.entries()) {
        expect(slide.images.map(im => im.data)).toEqual([`img:1:${i}`, `img:0:${i}`]);
        expect(slide.texts[0].text).toBe('scene_000_crop01');
      }
      expect(captionModality(slides[0])).toBe('✓ GT');
      expect(captionModality(slides[1])).toBe('PRED');
    });

    it('draws the red callout rect only from crop metadata with positive source dims', async () => {
      const meta: CropMeta = { x: 10, y: 5, w: 40, h: 20, srcW: 200, srcH: 100 };
      const { pptx, slides } = makePptxRecorder();
      const { io, metaCalls } = makeIo({ cropMeta: meta });
      await buildDeck(pptx, cropTuples, modalities, ti([1]), win([null]), mi([0]), io);
      expect(metaCalls).toEqual([[1, 'GT']]);
      const red = slides[0].shapes.filter(s => (s.opts.line as { color?: string } | undefined)?.color === 'FF0000');
      expect(red.length).toBe(1);
    });

    it('suppresses the callout rect when srcW/srcH are zero (Infinity would corrupt the deck)', async () => {
      const meta: CropMeta = { x: 10, y: 5, w: 40, h: 20, srcW: 0, srcH: 0 };
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo({ cropMeta: meta });
      await buildDeck(pptx, cropTuples, modalities, ti([1]), win([null]), mi([0]), io);
      expect(slides.length).toBe(1);
      const red = slides[0].shapes.filter(s => (s.opts.line as { color?: string } | undefined)?.color === 'FF0000');
      expect(red.length).toBe(0);
    });

    it('a voted parent with one unvoted crop presents the crop paired against the parent', async () => {
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo();
      await buildDeck(pptx, cropTuples, modalities, ti([0]), win([1]), mi([0, 1]), io);
      expect(slides.length).toBe(2);
      expect(slides[0].images.map(im => im.data)).toEqual(['img:1:0', 'img:0:0']);
      expect(slides[0].texts[0].text).toBe('scene_000_crop01');
      expect(captionModality(slides[1])).toBe('✓ PRED');
    });

    it('when parent and crop are both voted, the parent gets plain slides and the crop its own paired ones', async () => {
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo();
      await buildDeck(pptx, cropTuples, modalities, ti([0, 1]), win([0, 0]), mi([0]), io);
      expect(slides.length).toBe(2);
      expect(slides[0].images.map(im => im.data)).toEqual(['img:0:0']);
      expect(slides[1].images.map(im => im.data)).toEqual(['img:1:0', 'img:0:0']);
    });

    it('several unvoted crops of a voted parent get one paired slide each', async () => {
      const tuples = [{ name: 'scene_000' }, { name: 'scene_000_crop01' }, { name: 'scene_000_crop02' }];
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo();
      await buildDeck(pptx, tuples, modalities, ti([0]), win([null]), mi([0]), io);
      expect(slides.length).toBe(2);
      expect(slides[0].images.map(im => im.data)).toEqual(['img:1:0', 'img:0:0']);
      expect(slides[1].images.map(im => im.data)).toEqual(['img:2:0', 'img:0:0']);
    });

    it('an unrelated tuple is never treated as a crop parent', async () => {
      const { pptx, slides } = makePptxRecorder();
      const { io } = makeIo();
      await buildDeck(pptx, cropTuples, modalities, ti([2]), win([null]), mi([0]), io);
      expect(slides.length).toBe(1);
      expect(slides[0].images.map(im => im.data)).toEqual(['img:2:0']);
    });
  });
});
