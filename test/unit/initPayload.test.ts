import { describe, it, expect } from 'vitest';
import { buildInitPayload, denseTupleInfo } from '../../src/initPayload';

const img = (modality: string, name: string) => ({ modality, name });

const baseArgs = {
  tuples: [
    { name: 'a', images: [img('gt', 'a_gt.png')] },
    { name: 'b', images: [img('gt', 'b_gt.png'), img('pred', 'b_pred.png')] },
  ],
  modalities: ['gt', 'pred'],
  modalityPaths: ['/data/gt', '/data/pred'],
  winners: new Map<number, number>(),
  config: { thumbnailSize: 100, prefetchCount: 3, keepZoomOnTupleChange: false },
  votingEnabled: true,
  labelsExplicit: false,
  version: '1.2.3',
  capabilities: { revealInExplorer: true, copyTextToClipboard: true, saveSessionAs: true },
};

describe('init payload assembly (initPayload.ts, real code)', () => {
  it('densifies tuples: a missing modality becomes a name:"" placeholder at its global index', () => {
    const info = denseTupleInfo({ name: 'a', images: [img('pred', 'a_pred.png')] }, 3, ['gt', 'pred']);
    expect(info).toEqual({
      name: 'a',
      images: [
        { name: '', modality: 'gt', tupleIndex: 3, modalityIndex: 0 },
        { name: 'a_pred.png', modality: 'pred', tupleIndex: 3, modalityIndex: 1 },
      ],
    });
  });

  it('builds the init message with dense tuples in row order', () => {
    const msg = buildInitPayload(baseArgs);
    if (msg.type !== 'init') throw new Error('expected init');
    expect(msg.tuples.map(t => t.name)).toEqual(['a', 'b']);
    expect(msg.tuples[0].images.map(i => i.name)).toEqual(['a_gt.png', '']);
    expect(msg.modalities).toEqual(['gt', 'pred']);
    expect(msg.modalityPaths).toEqual(['/data/gt', '/data/pred']);
    expect(msg.votingEnabled).toBe(true);
    expect(msg.labelsExplicit).toBe(false);
    expect(msg.config).toEqual({ thumbnailSize: 100, prefetchCount: 3, keepZoomOnTupleChange: false });
  });

  it('defaults colors to the positional palette, wrapping after eight columns', () => {
    // External literals from the documented palette — not read back from MODALITY_COLORS.
    const nine = Array.from({ length: 9 }, (_, i) => `m${i}`);
    const msg = buildInitPayload({ ...baseArgs, tuples: [], modalities: nine, modalityPaths: nine });
    if (msg.type !== 'init') throw new Error('expected init');
    expect(msg.modalityColors[0]).toBe('#0f0');
    expect(msg.modalityColors[1]).toBe('#f60');
    expect(msg.modalityColors[7]).toBe('#44f');
    expect(msg.modalityColors[8]).toBe('#0f0'); // wrapped
  });

  it('lets a per-column override win, with falsy overrides falling back to the palette', () => {
    const msg = buildInitPayload({
      ...baseArgs,
      colorOverride: (modality) => (modality === 'pred' ? '#123456' : undefined),
    });
    if (msg.type !== 'init') throw new Error('expected init');
    expect(msg.modalityColors).toEqual(['#0f0', '#123456']);
  });

  it('carries the product version verbatim on the init message', () => {
    // Both products feed this field; the help modal footer renders exactly what arrives.
    const msg = buildInitPayload({ ...baseArgs, version: '7.8.9-rc1' });
    if (msg.type !== 'init') throw new Error('expected init');
    expect(msg.version).toBe('7.8.9-rc1');
  });

  it('converts the winners map into a plain record keyed by tuple index', () => {
    const msg = buildInitPayload({ ...baseArgs, winners: new Map([[0, 1], [1, 0]]) });
    if (msg.type !== 'init') throw new Error('expected init');
    expect(msg.winners).toEqual({ 0: 1, 1: 0 });
  });
});
