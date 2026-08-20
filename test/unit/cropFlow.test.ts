import { describe, it, expect } from 'vitest';
import { performCrop, CropFlowIo, CropRect } from '../../src/cropFlow';
import { pngReadText, CROP_RECT_KEYWORD } from '../../src/pngText';
import { ExtensionMessage, asTuple } from '../../src/types';
import { makeSolidPng } from '../fixtures/synthetic';

// Transcript-pinning suite for the shared crop flow: stage order, rect literals, naming,
// tEXt injection and the terminal posts are asserted as external literals, never re-derived.

type Img = { name: string; modality: string };
type Saved = { path: string };

const img = (modality: string): Img => ({ name: `t.png`, modality });

interface Rig {
  io: CropFlowIo<Img, Saved>;
  log: string[];
  written: Map<string, Buffer>;
}

function makeRig(opts: {
  dirNames?: Record<string, string[]>;
  dims?: Record<string, { width: number; height: number }>;
  serialize?: boolean;
  failRender?: string[];
  cancelRender?: string[];
  isCancelled?: (err: unknown) => boolean;
  isAborted?: () => boolean;
  withThumbnails?: boolean;
} = {}): Rig {
  const log: string[] = [];
  const written = new Map<string, Buffer>();
  let chain: Promise<unknown> = Promise.resolve();
  const io: CropFlowIo<Img, Saved> = {
    listDirNames: async image => {
      log.push(`list:${image.modality}`);
      return (opts.dirNames ?? {})[image.modality] ?? [];
    },
    getDimensions: async image => {
      log.push(`dims:${image.modality}`);
      return (opts.dims ?? {})[image.modality] ?? { width: 100, height: 100 };
    },
    renderCrop: async (image, rect: CropRect, cropMeta) => {
      log.push(`render:${image.modality}:${rect.x},${rect.y},${rect.w},${rect.h}:${cropMeta}`);
      if (opts.failRender?.includes(image.modality)) throw new Error(`render failed for ${image.modality}`);
      if (opts.cancelRender?.includes(image.modality)) throw { cancelled: true };
      return makeSolidPng(2, 2, [1, 2, 3]);
    },
    writeCrop: async (image, outputName, bytes) => {
      log.push(`write:${image.modality}:${outputName}`);
      const path = `/root/${image.modality}/${outputName}`;
      written.set(path, Buffer.from(bytes));
      return { path };
    },
    ...(opts.serialize === false ? {} : {
      schedule: <R,>(work: () => Promise<R>) => {
        const result = chain.then(work);
        chain = result.then(() => undefined, () => undefined);
        return result;
      },
    }),
    isCancelled: opts.isCancelled ?? ((err: unknown) => typeof err === 'object' && err !== null && (err as { cancelled?: boolean }).cancelled === true),
    isAborted: opts.isAborted,
    arriveFile: saved => { log.push(`arrive:${saved.path}`); },
    post: (m: ExtensionMessage) => {
      if (m.type === 'cropComplete') log.push(`post:cropComplete:${m.count}:${m.paths.join('|')}`);
      else if (m.type === 'cropError') log.push(`post:cropError:${m.error}`);
      else log.push(`post:${m.type}`);
    },
    ...(opts.withThumbnails ? { postCropThumbnails: async (saved: Saved[]) => { log.push(`thumbs:${saved.length}`); } } : {}),
  };
  return { io, log, written };
}

const scan2 = () => ({
  tuples: [{ name: 'shot', images: [img('a'), img('b')] }],
  modalities: ['a', 'b'],
});

const req = (over: Partial<{ tupleIndex: number; cropRect: CropRect; srcWidth: number; srcHeight: number }> = {}) => ({
  tupleIndex: asTuple(over.tupleIndex ?? 0),
  cropRect: over.cropRect ?? { x: 10, y: 20, w: 30, h: 40 },
  srcWidth: over.srcWidth ?? 100,
  srcHeight: over.srcHeight ?? 200,
});

describe('performCrop (real cropFlow code)', () => {
  it('speaks the canon transcript: list per modality, then dims -> render -> write per modality, then every arrival, cropComplete, thumbnails', async () => {
    // Rect drawn at 10,20,30,40 on a 100x200 view: modality a is same-size, b is 200x100.
    const { io, log } = makeRig({
      dims: { a: { width: 100, height: 200 }, b: { width: 200, height: 100 } },
      withThumbnails: true,
    });
    await performCrop(scan2(), req(), io);
    expect(log).toEqual([
      'list:a', 'list:b',
      'dims:a', 'render:a:10,20,30,40:10,20,30,40,100,200', 'write:a:shot_crop01.png',
      'dims:b', 'render:b:20,10,60,20:20,10,60,20,200,100', 'write:b:shot_crop01.png',
      'arrive:/root/a/shot_crop01.png', 'arrive:/root/b/shot_crop01.png',
      'post:cropComplete:2:/root/a/shot_crop01.png|/root/b/shot_crop01.png',
      'thumbs:2',
    ]);
  });

  it('injects the crop meta as a readable tEXt chunk into the written bytes', async () => {
    const { io, written } = makeRig({ dims: { a: { width: 100, height: 200 }, b: { width: 200, height: 100 } } });
    await performCrop(scan2(), req(), io);
    expect(pngReadText(written.get('/root/a/shot_crop01.png')!, CROP_RECT_KEYWORD)).toBe('10,20,30,40,100,200');
    expect(pngReadText(written.get('/root/b/shot_crop01.png')!, CROP_RECT_KEYWORD)).toBe('20,10,60,20,200,100');
  });

  it('numbers past the max existing crop in ANY modality dir, and one throwing listing reads as empty', async () => {
    const { io, log } = makeRig({
      dirNames: { b: ['shot_crop04.png'] },
    });
    io.listDirNames = async image => {
      log.push(`list:${image.modality}`);
      if (image.modality === 'a') throw new Error('unreadable dir');
      return ['shot_crop04.png'];
    };
    await performCrop(scan2(), req(), io);
    expect(log.filter(l => l.startsWith('write:'))).toEqual(['write:a:shot_crop05.png', 'write:b:shot_crop05.png']);
  });

  it('a modality whose rect scales to nothing is skipped, not an error: the others still save and count', async () => {
    // b is 1px tall: h scales to round(40/200 * 1) = 0 -> skip.
    const { io, log } = makeRig({ dims: { a: { width: 100, height: 200 }, b: { width: 100, height: 1 } } });
    await performCrop(scan2(), req(), io);
    expect(log.filter(l => l.startsWith('render:') || l.startsWith('write:'))).toEqual([
      'render:a:10,20,30,40:10,20,30,40,100,200', 'write:a:shot_crop01.png',
    ]);
    expect(log[log.length - 1]).toBe('post:cropComplete:1:/root/a/shot_crop01.png');
  });

  it('every modality scaling to nothing posts cropError, never cropComplete', async () => {
    const { io, log } = makeRig({ dims: { a: { width: 1, height: 1 }, b: { width: 1, height: 1 } } });
    await performCrop(scan2(), req({ cropRect: { x: 0, y: 0, w: 1, h: 1 }, srcWidth: 100, srcHeight: 200 }), io);
    expect(log.filter(l => l.startsWith('post:'))).toEqual(['post:cropError:Failed to crop any images']);
  });

  it('one failing modality is logged and dropped; the surviving one still arrives and completes', async () => {
    const { io, log } = makeRig({ failRender: ['a'] });
    await performCrop(scan2(), req(), io);
    expect(log.filter(l => l.startsWith('arrive:') || l.startsWith('post:'))).toEqual([
      'arrive:/root/b/shot_crop01.png',
      'post:cropComplete:1:/root/b/shot_crop01.png',
    ]);
  });

  it('a cancelled work unit silences the whole batch: no arrival, no cropComplete, no cropError', async () => {
    const { io, log } = makeRig({ cancelRender: ['b'] });
    await performCrop(scan2(), req(), io);
    expect(log.filter(l => l.startsWith('post:') || l.startsWith('arrive:'))).toEqual([]);
  });

  it('an aborted panel silences the batch even when every write succeeded', async () => {
    const { io, log } = makeRig({ isAborted: () => true });
    await performCrop(scan2(), req(), io);
    expect(log.filter(l => l.startsWith('write:'))).toHaveLength(2);
    expect(log.filter(l => l.startsWith('post:') || l.startsWith('arrive:'))).toEqual([]);
  });

  it('a missing tuple or an empty tuple touches no io at all', async () => {
    const a = makeRig();
    await performCrop({ tuples: [] }, req(), a.io);
    expect(a.log).toEqual([]);
    const b = makeRig();
    await performCrop({ tuples: [{ name: 'empty', images: [] }] }, req(), b.io);
    expect(b.log).toEqual([]);
  });
});
