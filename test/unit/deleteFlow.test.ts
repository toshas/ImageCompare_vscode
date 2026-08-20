import { describe, it, expect } from 'vitest';
import { deleteTupleFlow, removeTupleStep, removeModalityStep } from '../../src/removalPlan';
import { ExtensionMessage } from '../../src/types';

// Transcript-pinning suite: file-delete order, live-index re-planning and step order are
// asserted as external literals, never derived from the flow's own plan.
const img = (name: string, modality: string) => ({ name, modality });

function recordingIo(log: string[], failDeletes = false) {
  return {
    deleteFile: async (image: { name: string; modality: string }) => {
      log.push(`rm:${image.name}/${image.modality}`);
      if (failDeletes) throw new Error('already gone');
    },
    removeTuple: (idx: number) => { log.push(`step:tuple:${idx}`); },
    removeModality: (idx: number) => { log.push(`step:modality:${idx}`); },
  };
}

describe('delete-tuple flow (real removalPlan code)', () => {
  it('deletes every file before executing the removal plan: rm per image, then the tuple step, then each emptied column', async () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b'), img('t0.png', 'c')] },
        { name: 't1', images: [img('t1.png', 'b')] },
      ],
      modalities: ['a', 'b', 'c'],
    };
    const log: string[] = [];
    await deleteTupleFlow(scan, 0, recordingIo(log));
    expect(log).toEqual([
      'rm:t0.png/a', 'rm:t0.png/b', 'rm:t0.png/c',
      'step:tuple:0',
      'step:modality:0', 'step:modality:1',
    ]);
  });

  it('a rejecting per-file delete is swallowed and the rest of the flow still runs', async () => {
    const scan = {
      tuples: [{ name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b')] }],
      modalities: ['a', 'b'],
    };
    const log: string[] = [];
    await deleteTupleFlow(scan, 0, recordingIo(log, true));
    // Both columns empty out; 'b' is reported at 0 because 'a' was already spliced (pre-shifted indices).
    expect(log).toEqual(['rm:t0.png/a', 'rm:t0.png/b', 'step:tuple:0', 'step:modality:0', 'step:modality:0']);
  });

  it('plans from the tuple\'s live index when a deletion await shifts rows underneath it', async () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'a')] },
        { name: 't1', images: [img('t1.png', 'a')] },
      ],
      modalities: ['a'],
    };
    const log: string[] = [];
    await deleteTupleFlow(scan, 1, {
      deleteFile: async () => {
        // A concurrent removal (e.g. a watcher) drops the row above while the delete awaits.
        log.push('rm:t1.png/a');
        scan.tuples.splice(0, 1);
      },
      removeTuple: (idx: number) => { log.push(`step:tuple:${idx}`); },
      removeModality: (idx: number) => { log.push(`step:modality:${idx}`); },
    });
    // t1 now lives at index 0; planning from the stale index 1 would delete nothing (or the wrong row).
    expect(log).toEqual(['rm:t1.png/a', 'step:tuple:0', 'step:modality:0']);
  });

  it('a missing tuple index does nothing at all', async () => {
    const scan = { tuples: [{ name: 't0', images: [img('t0.png', 'a')] }], modalities: ['a'] };
    const log: string[] = [];
    await deleteTupleFlow(scan, 7, recordingIo(log));
    expect(log).toEqual([]);
  });

  it('wired to the real steps, the flow speaks: files, tupleDeleted, refresh, save, then modalityRemoved + save per emptied column', async () => {
    const scan = {
      tuples: [
        { name: 't0', images: [img('t0.png', 'a'), img('t0.png', 'b'), img('t0.png', 'c')] },
        { name: 't1', images: [img('t1.png', 'b')] },
      ],
      modalities: ['a', 'b', 'c'],
    };
    const winners = new Map<number, number>();
    const log: string[] = [];
    let current = 0;
    const stepIo = {
      post: (m: ExtensionMessage) => {
        const idx = m as { tupleIndex?: number; modalityIndex?: number | null };
        log.push(`post:${m.type}:${idx.tupleIndex ?? idx.modalityIndex}`);
      },
      refreshCurrentTuple: (c: number) => { current = c; log.push(`refresh:${c}`); },
      saveResults: () => { log.push('save'); },
    };
    await deleteTupleFlow(scan, 0, {
      deleteFile: async image => { log.push(`rm:${image.modality}`); },
      removeTuple: idx => removeTupleStep(scan, winners, current, idx, stepIo),
      removeModality: idx => removeModalityStep(scan, winners, idx, stepIo),
    });
    expect(log).toEqual([
      'rm:a', 'rm:b', 'rm:c',
      'post:tupleDeleted:0', 'refresh:0', 'save',
      'post:modalityRemoved:0', 'save',
      'post:modalityRemoved:1', 'save',
    ]);
    expect(scan.modalities).toEqual(['b']);
    expect(scan.tuples.map(t => t.name)).toEqual(['t1']);
  });
});
