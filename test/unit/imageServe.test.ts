import { describe, it, expect } from 'vitest';
import { serveImage, refreshTupleImages, ImageServeIo, ImageServeReply } from '../../src/imageServe';

// Transcript-pinning suite: io call order and the single terminal reply are asserted
// as external literals against scripted io, never against the orchestrator's own branches.
type TestImage = { name: string };

function recorder() {
  const log: string[] = [];
  const post = (reply: ImageServeReply) => {
    if (reply.kind === 'image') log.push(`post:image:${reply.mime}:${reply.width}x${reply.height}`);
    else log.push(`post:error:${reply.error}`);
  };
  const posts = () => log.filter(e => e.startsWith('post:')).length;
  return { log, post, posts };
}

function scriptedIo(log: string[], overrides: Partial<ImageServeIo<TestImage>> = {}): ImageServeIo<TestImage> {
  return {
    loadRaw: async () => { log.push('loadRaw'); return { bytes: Buffer.from([1, 2, 3]), ext: '.png' }; },
    probePassthrough: async () => { log.push('probe'); return { width: 320, height: 200 }; },
    convert: async () => { log.push('convert'); return { bytes: new Uint8Array([9]), mime: 'image/png', width: 64, height: 48 }; },
    ...overrides,
  };
}

describe('serveImage (real imageServe code)', () => {
  it('a missing image posts exactly one imageError and touches no io', async () => {
    const { log, post, posts } = recorder();
    await serveImage(undefined, scriptedIo(log), post);
    expect(log).toEqual(['post:error:Image not available']);
    expect(posts()).toBe(1);
  });

  it('a passthrough extension serves the original bytes with probed dims and never converts', async () => {
    const { log, posts } = recorder();
    let served: ImageServeReply | undefined;
    await serveImage({ name: 'a.png' }, scriptedIo(log), reply => { served = reply; log.push(`post:${reply.kind}`); });
    expect(log).toEqual(['loadRaw', 'probe', 'post:image']);
    expect(posts()).toBe(1);
    if (served?.kind !== 'image') throw new Error('expected an image reply');
    expect(served.mime).toBe('image/png');
    expect(served.width).toBe(320);
    expect(served.height).toBe(200);
    expect(Array.from(served.bytes)).toEqual([1, 2, 3]);
    // Buffer in, plain tight Uint8Array out — the wire normalization is the orchestrator's job.
    expect(Object.getPrototypeOf(served.bytes)).toBe(Uint8Array.prototype);
  });

  it('a non-passthrough extension converts (probe untouched) and serves the converted payload', async () => {
    const { log, post, posts } = recorder();
    await serveImage(
      { name: 'a.ppmx' },
      scriptedIo(log, { loadRaw: async () => { log.push('loadRaw'); return { bytes: new Uint8Array([7]), ext: '.ppmx' }; } }),
      post
    );
    expect(log).toEqual(['loadRaw', 'convert', 'post:image:image/png:64x48']);
    expect(posts()).toBe(1);
  });

  it('a loadRaw failure posts exactly one imageError carrying the message', async () => {
    const { log, post, posts } = recorder();
    await serveImage(
      { name: 'a.png' },
      scriptedIo(log, { loadRaw: async () => { log.push('loadRaw'); throw new Error('disk gone'); } }),
      post
    );
    expect(log).toEqual(['loadRaw', 'post:error:disk gone']);
    expect(posts()).toBe(1);
  });

  it('a convert failure posts exactly one imageError carrying the message', async () => {
    const { log, post, posts } = recorder();
    await serveImage(
      { name: 'a.tiff' },
      scriptedIo(log, {
        loadRaw: async () => { log.push('loadRaw'); return { bytes: new Uint8Array([7]), ext: '.tiff' }; },
        convert: async () => { log.push('convert'); throw new Error('.tiff is not supported in the browser'); },
      }),
      post
    );
    expect(log).toEqual(['loadRaw', 'convert', 'post:error:.tiff is not supported in the browser']);
    expect(posts()).toBe(1);
  });

  it('a non-Error failure posts the Unknown error placeholder, still exactly once', async () => {
    const { log, post, posts } = recorder();
    await serveImage(
      { name: 'a.png' },
      // eslint-disable-next-line prefer-promise-reject-errors
      scriptedIo(log, { loadRaw: () => { log.push('loadRaw'); return Promise.reject('nope'); } }),
      post
    );
    expect(log).toEqual(['loadRaw', 'post:error:Unknown error']);
    expect(posts()).toBe(1);
  });
});

describe('refreshTupleImages (real imageServe code)', () => {
  it('sends one request per modality column, in column order', () => {
    const sent: number[] = [];
    refreshTupleImages({ name: 't0' }, ['gt', 'pred', 'depth'], m => sent.push(m));
    expect(sent).toEqual([0, 1, 2]);
  });

  it('a missing tuple sends nothing', () => {
    const sent: number[] = [];
    refreshTupleImages(undefined, ['gt', 'pred'], m => sent.push(m));
    expect(sent).toEqual([]);
  });
});
