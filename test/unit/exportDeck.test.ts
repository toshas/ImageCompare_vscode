import { describe, it, expect } from 'vitest';
import type PptxGenJS from 'pptxgenjs';
import { exportDeck, ExportDeckIo, ExportDeckRequest } from '../../src/pptxDeck';
import { ExtensionMessage, asOriginal, asTuple } from '../../src/types';

// Transcript-pinning suite for the shared export flow: the name -> build -> save -> answer
// sequence and the exactly-one-answer discipline are asserted as external literals.

// Minimal PptxGenJS shape: buildDeck only sets layout/title and adds slides with image/text/shape.
function fakePptxCtor(log: string[]) {
  return class {
    layout = '';
    title = '';
    addSlide() {
      log.push('slide');
      return { addImage: () => undefined, addText: () => undefined, addShape: () => undefined };
    }
  } as unknown as new () => PptxGenJS;
}

const request: ExportDeckRequest = {
  tupleIndices: [asTuple(0)],
  winnerModalityIndices: [null],
  modalityOrder: [asOriginal(0)],
};

interface RigOpts {
  existing?: string[];
  failAt?: 'list' | 'ctor' | 'build' | 'save';
  cancelAt?: 'save';
  onSaved?: (path: string) => void | Promise<void>;
  onError?: (message: string) => void;
}

function makeRig(opts: RigOpts = {}) {
  const log: string[] = [];
  const io: ExportDeckIo = {
    getPptx: async () => {
      log.push('ctor');
      if (opts.failAt === 'ctor') throw new Error('no pptxgenjs');
      return fakePptxCtor(log);
    },
    listExistingNames: async () => {
      log.push('list');
      if (opts.failAt === 'list') throw new Error('Cannot determine output directory');
      return opts.existing ?? [];
    },
    deckIo: {
      loadImage: async (tupleIndex, modalityIndex) => {
        log.push(`load:${tupleIndex}:${modalityIndex}`);
        if (opts.failAt === 'build') throw new Error('image read failed');
        return { data: 'data:image/jpeg;base64,x', width: 100, height: 50 };
      },
      readCropMeta: async () => null,
    },
    saveDeck: async (_pptx, name) => {
      log.push(`save:${name}`);
      if (opts.failAt === 'save') throw new Error('disk full');
      if (opts.cancelAt === 'save') throw { cancelled: true };
      return `/out/${name}`;
    },
    post: (m: ExtensionMessage) => {
      if (m.type === 'pptxComplete') log.push(`post:pptxComplete:${m.path}`);
      else if (m.type === 'pptxError') log.push(`post:pptxError:${m.error}`);
      else log.push(`post:${m.type}`);
    },
    isCancelled: (err: unknown) => typeof err === 'object' && err !== null && (err as { cancelled?: boolean }).cancelled === true,
    onSaved: opts.onSaved ? (p: string) => { log.push('onSaved'); return opts.onSaved!(p); } : undefined,
    onError: opts.onError ? (m: string) => { log.push('onError'); opts.onError!(m); } : undefined,
  };
  return { io, log };
}

const scanTuples = [{ name: 'shot' }];
const modalities = ['a'];

describe('exportDeck (real pptxDeck flow code)', () => {
  it('speaks the canon sequence: list -> ctor -> build -> save under the max+1 name -> pptxComplete with the saved path', async () => {
    const { io, log } = makeRig({ existing: ['comparison_05.pptx', 'notes.txt'] });
    await exportDeck(scanTuples, modalities, request, io);
    expect(log).toEqual([
      'list', 'ctor', 'load:0:0', 'slide',
      'save:comparison_06.pptx',
      'post:pptxComplete:/out/comparison_06.pptx',
    ]);
  });

  it.each(['list', 'ctor', 'build', 'save'] as const)('a throw at %s posts pptxError exactly once and never pptxComplete', async stage => {
    const seen: string[] = [];
    const { io, log } = makeRig({ failAt: stage, onError: m => seen.push(m) });
    await exportDeck(scanTuples, modalities, request, io);
    const posts = log.filter(l => l.startsWith('post:'));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^post:pptxError:/);
    expect(seen).toHaveLength(1);
    expect(log.filter(l => l.startsWith('save:')).length).toBe(stage === 'save' ? 1 : 0);
  });

  it('a cancellation posts nothing at all — no answer is owed to a gone panel', async () => {
    const { io, log } = makeRig({ cancelAt: 'save', onError: () => undefined });
    await exportDeck(scanTuples, modalities, request, io);
    expect(log.filter(l => l.startsWith('post:') || l === 'onError')).toEqual([]);
  });

  it('a throw from the post-answer notification cannot forge a second answer', async () => {
    const { io, log } = makeRig({ onSaved: () => { throw new Error('toast exploded'); }, onError: () => undefined });
    await exportDeck(scanTuples, modalities, request, io);
    expect(log.filter(l => l.startsWith('post:'))).toEqual(['post:pptxComplete:/out/comparison_01.pptx']);
    expect(log).toContain('onSaved');
    expect(log).not.toContain('onError');
  });

  it('the notification hook fires after the answer, with the saved path', async () => {
    const paths: string[] = [];
    const { io, log } = makeRig({ onSaved: p => { paths.push(p); } });
    await exportDeck(scanTuples, modalities, request, io);
    expect(log.indexOf('onSaved')).toBeGreaterThan(log.indexOf('post:pptxComplete:/out/comparison_01.pptx'));
    expect(paths).toEqual(['/out/comparison_01.pptx']);
  });
});
