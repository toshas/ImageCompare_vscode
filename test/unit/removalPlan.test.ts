import { describe, it, expect } from 'vitest';
import { commitSlotRemoval, planTupleRemoval, removeTupleStep, removeModalityStep, modalityHasFiles, RemovalStep } from '../../src/removalPlan';
import { ExtensionMessage } from '../../src/types';

// Fixture literals are external to the implementation: step orders, indices and io
// call sequences are written out by hand, never derived from the planner itself.
const img = (name: string, modality: string) => ({ name, modality });

// Records every io call as one string, so order assertions read as a transcript.
function recordingIo(log: string[]) {
  return {
    post: (m: ExtensionMessage) => {
      const idx = m as { tupleIndex?: number; modalityIndex?: number | null };
      log.push(`post:${m.type}:${idx.tupleIndex ?? idx.modalityIndex}`);
    },
    refreshCurrentTuple: (current: number) => { log.push(`refresh:${current}`); },
    saveResults: () => { log.push('save'); },
  };
}

describe('removal planner (real removalPlan code)', () => {
  it('Test 1: modalityHasFiles is true only while some tuple still holds the modality', () => {
    const tuples = [{ images: [img('a.png', 'gt')] }, { images: [img('a.png', 'pred')] }];
    expect(modalityHasFiles(tuples, 'pred')).toBe(true);
    expect(modalityHasFiles(tuples, 'depth')).toBe(false);
  });

  it('Test 2: plan lists the tuple first, then each emptied modality with indices pre-shifted for earlier splices', () => {
    const tuples = [
      { name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b'), img('t0.png', 'c')] },
      { name: 't1', images: [img('t1.png', 'b')] },
    ];
    const steps = planTupleRemoval(tuples, ['a', 'b', 'c'], 0);
    // 'b' survives in t1; after 'a' is spliced, 'c' sits at index 1, not 2.
    expect(steps).toEqual([
      { kind: 'tuple', tupleIndex: 0 },
      { kind: 'modality', modality: 'a', modalityIndex: 0 },
      { kind: 'modality', modality: 'c', modalityIndex: 1 },
    ]);
  });

  it('Test 3: a tuple whose modalities all survive plans a single step', () => {
    const tuples = [
      { name: 't0', images: [img('t0.png', 'a')] },
      { name: 't1', images: [img('t1.png', 'a')] },
    ];
    expect(planTupleRemoval(tuples, ['a'], 1)).toEqual([{ kind: 'tuple', tupleIndex: 1 }]);
  });

  it('Test 4: removeTupleStep splices, shifts winner keys, and speaks tupleDeleted -> refresh -> re-save in that order', () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'gt')] },
        { name: 't1', images: [img('t1.png', 'gt')] },
        { name: 't2', images: [img('t2.png', 'gt')] },
      ],
      modalities: ['gt'],
    };
    const winners = new Map<number, number>([[0, 0], [1, 0], [2, 0]]);
    const log: string[] = [];
    removeTupleStep(scan, winners, 2, 1, recordingIo(log));
    expect(scan.tuples.map(t => t.name)).toEqual(['t0', 't2']);
    // The winner on the removed row is dropped; the one after it shifts down.
    expect([...winners]).toEqual([[0, 0], [1, 0]]);
    expect(log).toEqual(['post:tupleDeleted:1', 'refresh:1', 'save']);
  });

  it('Test 5: removeTupleStep clamps the current index when the last row goes', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0.png', 'gt')] }, { name: 't1', images: [img('t1.png', 'gt')] }],
      modalities: ['gt'],
    };
    const log: string[] = [];
    removeTupleStep(scan, new Map(), 1, 1, recordingIo(log));
    expect(log).toEqual(['post:tupleDeleted:1', 'refresh:0', 'save']);
  });

  it('Test 6: removeModalityStep splices the column, strips images, shifts winner values, and re-saves after posting', () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b')] },
        { name: 't1', images: [img('t1.png', 'b'), img('t1.png', 'c')] },
      ],
      modalities: ['a', 'b', 'c'],
    };
    const winners = new Map<number, number>([[0, 0], [1, 2]]);
    const log: string[] = [];
    removeModalityStep(scan, winners, 1, recordingIo(log));
    expect(scan.modalities).toEqual(['a', 'c']);
    expect(scan.tuples.map(t => t.images.map(i => i.modality))).toEqual([['a'], ['c']]);
    // The 'c' winner (index 2) shifts to 1; a winner pointing at 'b' would be dropped.
    expect([...winners]).toEqual([[0, 0], [1, 1]]);
    expect(log).toEqual(['post:modalityRemoved:1', 'save']);
  });

  it('Test 7: a winner pointing at the removed modality is dropped, not shifted', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b')] }],
      modalities: ['a', 'b'],
    };
    const winners = new Map<number, number>([[0, 1]]);
    removeModalityStep(scan, winners, 1, recordingIo([]));
    expect(winners.size).toBe(0);
  });

  it('Test 8: executing a full plan re-saves after EVERY step, never once at the end', () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b'), img('t0.png', 'c')] },
        { name: 't1', images: [img('t1.png', 'b')] },
      ],
      modalities: ['a', 'b', 'c'],
    };
    const winners = new Map<number, number>();
    const log: string[] = [];
    const io = recordingIo(log);
    let current = 0;
    for (const step of planTupleRemoval(scan.tuples, scan.modalities, 0) as RemovalStep[]) {
      if (step.kind === 'tuple') {
        removeTupleStep(scan, winners, current, step.tupleIndex, {
          ...io,
          refreshCurrentTuple: (c: number) => { current = c; io.refreshCurrentTuple(c); },
        });
      } else {
        removeModalityStep(scan, winners, step.modalityIndex, io);
      }
    }
    expect(log).toEqual([
      'post:tupleDeleted:0', 'refresh:0', 'save',
      'post:modalityRemoved:0', 'save',
      'post:modalityRemoved:1', 'save',
    ]);
    expect(scan.modalities).toEqual(['b']);
    expect(scan.tuples.map(t => t.name)).toEqual(['t1']);
  });
});

// The rename-window/poll commit: the provider's timer and the standalone poll both execute this
// sequence — the transcripts below are written out by hand from docs/file-watching.md.
describe('commitSlotRemoval (real removalPlan code)', () => {
  function commitIo(scan: { tuples: Array<{ name: string; images: Array<{ name: string; modality: string }> }>; modalities: string[] }, log: string[]) {
    return {
      post: (m: ExtensionMessage) => {
        const idx = m as { tupleIndex?: number; modalityIndex?: number | null };
        log.push(`post:${m.type}:${idx.tupleIndex ?? ''}:${idx.modalityIndex ?? 'null'}`);
      },
      saveResults: () => { log.push('save'); },
      // Stubs mimic the real steps' splices so the column-empty follow-up sees the committed state.
      removeTuple: (idx: number) => { scan.tuples.splice(idx, 1); log.push(`removeTuple:${idx}`); },
      removeModality: (idx: number) => {
        const modality = scan.modalities[idx];
        scan.modalities.splice(idx, 1);
        for (const t of scan.tuples) t.images = t.images.filter(i => i.modality !== modality);
        log.push(`removeModality:${idx}`);
      },
      onSlotRemoved: (t: number, m: number) => { log.push(`evict:${t}-${m}`); },
    };
  }

  it('Test 1: a slot whose tuple keeps other images posts fileDeleted and re-saves, after the cache eviction', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0_gt.png', 'gt'), img('t0_pred.png', 'pred')] }, { name: 't1', images: [img('t1_gt.png', 'gt')] }],
      modalities: ['gt', 'pred'],
    };
    const winners = new Map<number, number>([[0, 0]]);
    const log: string[] = [];
    commitSlotRemoval(scan, winners, 0, 1, commitIo(scan, log));
    // Winner was gt (0), removed slot is pred (1): no winner traffic; pred survives in no other tuple -> column drops.
    expect(log).toEqual(['evict:0-1', 'post:fileDeleted:0:1', 'save', 'removeModality:1']);
    expect(scan.tuples[0].images.map(i => i.modality)).toEqual(['gt']);
    expect(winners.get(0)).toBe(0);
  });

  it('Test 2: a winner on the removed slot is cleared and announced before the delete traffic', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0_gt.png', 'gt'), img('t0_pred.png', 'pred')] }, { name: 't1', images: [img('t1_pred.png', 'pred')] }],
      modalities: ['gt', 'pred'],
    };
    const winners = new Map<number, number>([[0, 1]]);
    const log: string[] = [];
    commitSlotRemoval(scan, winners, 0, 1, commitIo(scan, log));
    expect(log).toEqual(['evict:0-1', 'post:winnerUpdated:0:null', 'post:fileDeleted:0:1', 'save']);
    expect(winners.has(0)).toBe(false);
  });

  it('Test 3: removing a tuple\'s last image removes the tuple (no fileDeleted), then the emptied column', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0_gt.png', 'gt')] }, { name: 't1', images: [img('t1_pred.png', 'pred')] }],
      modalities: ['gt', 'pred'],
    };
    const winners = new Map<number, number>();
    const log: string[] = [];
    commitSlotRemoval(scan, winners, 0, 0, commitIo(scan, log));
    expect(log).toEqual(['evict:0-0', 'removeTuple:0', 'removeModality:0']);
    expect(scan.tuples.map(t => t.name)).toEqual(['t1']);
    expect(scan.modalities).toEqual(['pred']);
  });

  it('Test 4: a column still held elsewhere survives an emptied tuple', () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0_gt.png', 'gt')] }, { name: 't1', images: [img('t1_gt.png', 'gt')] }],
      modalities: ['gt'],
    };
    const log: string[] = [];
    commitSlotRemoval(scan, new Map(), 0, 0, commitIo(scan, log));
    expect(log).toEqual(['evict:0-0', 'removeTuple:0']);
    expect(scan.modalities).toEqual(['gt']);
  });

  it('Test 5: an unresolvable tuple or modality index is a no-op', () => {
    const scan = { tuples: [{ name: 't0', images: [img('a.png', 'gt')] }], modalities: ['gt'] };
    const log: string[] = [];
    commitSlotRemoval(scan, new Map(), 5, 0, commitIo(scan, log));
    commitSlotRemoval(scan, new Map(), 0, 5, commitIo(scan, log));
    expect(log).toEqual([]);
    expect(scan.tuples[0].images).toHaveLength(1);
  });
});
