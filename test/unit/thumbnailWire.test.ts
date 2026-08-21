import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Uri, __resetConfig } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';

// The `thumbnail` wire shape, on the REAL provider's post path. The packfile hands out
// `key -> offset/length` slices of ONE shared buffer, so a thumbnail served from the pack is a
// Buffer view over the whole pack: posting that view ships the entire packfile per thumbnail, and a
// Buffer subclass can be JSON-mangled into {type:"Buffer",data:[…]}, which decodes to nothing and
// reads as a broken tile (docs/loading-architecture.md: image-payload-normalized).

const MODALITIES = ['gt', 'ours'];
const TUPLES = 3;

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  __resetConfig();
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

function makeRig(thumbnailBytes: () => Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-thumbwire-'));
  tmpRoots.push(root);
  const posts: any[] = [];

  const provider: any = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  // Only the byte source is stubbed: the sweep, slot re-addressing and posting are real code.
  provider.thumbnailService = {
    getThumbnail: async () => thumbnailBytes(),
    loadFullImage: async () => ({ bytes: new Uint8Array(8), mime: 'image/png', width: 4, height: 4 }),
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    })
  };

  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: `frame${t}`,
    images: MODALITIES.map(m => ({ uri: Uri.file(`/imgs/${m}/frame${t}.png`), name: `frame${t}.png`, modality: m }))
  }));

  const state: any = {
    panel: { webview: { postMessage: (msg: any) => { posts.push(msg); return Promise.resolve(true); } } },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(MODALITIES.map(m => [m, Uri.file(`/imgs/${m}`)])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: 0,
    sweepAim: newSweepAimPolicy(),
    disposed: false,
    visible: true,
    poolKey: `thumbwire-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    watchedDirs: new Set<string>(),
    fileWatchers: [],
    nodeWatchers: [],
    wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(8, undefined))
  };

  return { provider, state, posts };
}

describe('thumbnails cross the wire as tight, plain Uint8Arrays', () => {
  it('a pack-slice thumbnail is copied tight before it is posted', async () => {
    const pack = Buffer.alloc(4096, 7);
    // A 64-byte entry at offset 512 of the pack — a Buffer view, not a copy.
    const slice = pack.subarray(512, 576);
    expect(slice.byteLength).toBe(64);
    expect(slice.buffer.byteLength).toBeGreaterThan(4000);

    const rig = makeRig(() => slice);
    rig.provider.generateAllThumbnails(rig.state);
    await settle();

    const thumbs = rig.posts.filter((p: any) => p.type === 'thumbnail');
    expect(thumbs.length).toBe(TUPLES * MODALITIES.length);
    for (const t of thumbs) {
      expect(t.mime).toBe('image/jpeg');
      // Plain constructor (never Buffer), offset 0, and no backing bytes beyond the entry itself.
      expect(t.bytes.constructor).toBe(Uint8Array);
      expect(t.bytes.byteOffset).toBe(0);
      expect(t.bytes.byteLength).toBe(64);
      expect(t.bytes.buffer.byteLength).toBe(64);
      expect(Buffer.from(t.bytes).equals(slice)).toBe(true);
    }
  });

  it('an on-demand re-request posts the same tight binary shape, never a data url', async () => {
    const generated = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
    const rig = makeRig(() => generated);

    await rig.provider.sendThumbnails(rig.state, [1]);
    await settle(5);

    const thumbs = rig.posts.filter((p: any) => p.type === 'thumbnail');
    expect(thumbs.map((t: any) => `${t.tupleIndex}-${t.modalityIndex}`)).toEqual(['1-0', '1-1']);
    for (const t of thumbs) {
      expect((t as any).dataUrl).toBeUndefined();
      expect(t.bytes.constructor).toBe(Uint8Array);
      expect(Buffer.from(t.bytes).equals(generated)).toBe(true);
      expect(t.mime).toBe('image/jpeg');
    }
  });
});
