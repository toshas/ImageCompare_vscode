import { describe, it, expect } from 'vitest';
import { planThumbnails, runThumbnailSweep, ThumbnailBytes } from '../../src/thumbnailPlan';
import { ExtensionMessage } from '../../src/types';

// Transcript-pinning suite: the sweep's wire order is written out as external literals,
// never derived by re-running the runner's own arithmetic.
const img = (modality: string, name: string) => ({ modality, name });

function recorder() {
  const log: string[] = [];
  const post = (m: ExtensionMessage) => {
    if (m.type === 'thumbnail') log.push(`thumb:${m.tupleIndex}-${m.modalityIndex}:${m.mime}/${m.bytes.byteLength}`);
    else if (m.type === 'thumbnailError') log.push(`error:${m.tupleIndex}-${m.modalityIndex}:${m.error}`);
    else if (m.type === 'thumbnailProgress') log.push(`progress:${m.current}/${m.total}`);
    else log.push(`unexpected:${m.type}`);
  };
  return { log, post };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

// Distinct byte lengths stand in for distinct thumbnails, so a mis-routed settle is visible.
const jpeg = (length: number): ThumbnailBytes => ({ bytes: new Uint8Array(length), mime: 'image/jpeg' });

describe('thumbnail sweep runner (real thumbnailPlan code)', () => {
  it('missing slots error out first, items fan out eagerly, and each settle posts its result then a progress tick', async () => {
    const tuples = [
      { images: [img('gt', 'a_gt.png')] },
      { images: [img('gt', 'b_gt.png'), img('pred', 'b_pred.png')] },
    ];
    const plan = planThumbnails(tuples, ['gt', 'pred']);
    const { log, post } = recorder();
    const slots = new Map<string, ReturnType<typeof deferred<ThumbnailBytes | null>>>();
    const sweep = runThumbnailSweep(plan, {
      makeThumbnail: item => {
        log.push(`make:${item.tupleIndex}-${item.modalityIndex}`);
        const d = deferred<ThumbnailBytes | null>();
        slots.set(`${item.tupleIndex}-${item.modalityIndex}`, d);
        return d.promise;
      },
    }, post);

    // Missing errors and every invocation happen before any item settles — nothing is serialized.
    expect(log).toEqual(['error:0-1:Image not available', 'make:0-0', 'make:1-0', 'make:1-1']);

    slots.get('0-0')!.resolve(jpeg(11));
    await flush();
    // done=1 plus 1 missing over total 4.
    expect(log.slice(4)).toEqual(['thumb:0-0:image/jpeg/11', 'progress:2/4']);

    // Out-of-order settle: the runner posts in completion order, not plan order.
    slots.get('1-1')!.resolve(jpeg(33));
    await flush();
    expect(log.slice(6)).toEqual(['thumb:1-1:image/jpeg/33', 'progress:3/4']);

    slots.get('1-0')!.reject(new Error('decode failed'));
    await flush();
    expect(log.slice(8)).toEqual(['error:1-0:decode failed', 'progress:4/4']);

    await sweep;
  });

  it('zero items still posts the terminal progress tick after the missing-slot errors', async () => {
    const plan = planThumbnails([{ images: [] }], ['gt', 'pred']);
    const { log, post } = recorder();
    await runThumbnailSweep(plan, { makeThumbnail: () => Promise.resolve(jpeg(1)) }, post);
    expect(log).toEqual([
      'error:0-0:Image not available',
      'error:0-1:Image not available',
      'progress:2/2',
    ]);
  });

  it('an empty plan posts a single 0/0 terminal tick', async () => {
    const { log, post } = recorder();
    await runThumbnailSweep(planThumbnails([], ['gt']), { makeThumbnail: () => Promise.resolve(null) }, post);
    expect(log).toEqual(['progress:0/0']);
  });

  it('a null resolution settles the slot silently but still ticks progress', async () => {
    const plan = planThumbnails([{ images: [img('gt', 'a_gt.png')] }], ['gt']);
    const { log, post } = recorder();
    await runThumbnailSweep(plan, { makeThumbnail: () => Promise.resolve(null) }, post);
    expect(log).toEqual(['progress:1/1']);
  });

  it('a non-Error rejection posts the Unknown error placeholder', async () => {
    const plan = planThumbnails([{ images: [img('gt', 'a_gt.png')] }], ['gt']);
    const { log, post } = recorder();
    await runThumbnailSweep(plan, { makeThumbnail: () => Promise.reject('nope') }, post);
    expect(log).toEqual(['error:0-0:Unknown error', 'progress:1/1']);
  });
});
