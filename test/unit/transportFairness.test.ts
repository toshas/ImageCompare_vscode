import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig, __setRemoteName } from '../mocks/vscode';
import { ImageCompareProvider, newSweepAimPolicy } from '../../src/imageCompareProvider';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';

// The head-of-line blocking a Chrome renderer trace of a remote-SSH session showed, reproduced on
// the REAL provider: an open-time thumbnail sweep (120 tiles, ~700KB) draining while one prefetch
// wave (21 full images, ~45.5MB, one 16MB whale) is issued, over a *serialized* channel whose cost is
// bytes. The wire below is that channel: strict FIFO, virtual clock advanced by bytes/rate, and a
// postMessage promise that resolves only when the payload has drained — the same ack the provider
// releases budget on. No real time is consumed, so the numbers are deterministic.
// (docs/loading-architecture.md: user-pushes-never-withheld, speculation-yields-the-wire)

const CHANNEL = 'ImageCompare';
const MODALITIES = ['gt', 'ours', 'baseline', 'depth', 'normals', 'flow'];
const TUPLES = 20;
const CENTER = 10;
const PREFETCH_COUNT = 3;
/** ~5 MB/s: a plausible remote-SSH channel, and the unit that makes a 16MB image 3.2 virtual seconds. */
const WIRE_BYTES_PER_MS = 5000;
/** A 4.4KB JPEG, the size the trace's pack tier served — thumbnails now cross the wire as raw bytes. */
const THUMB_BYTES = 4400;
const IMAGE_BYTES: Record<string, number> = { gt: 2_000_000, ours: 1_500_000, baseline: 1_000_000, depth: 1_000_000, normals: 500_000, flow: 500_000 };
/** The trace's largest single payload, on the centre tuple. */
const WHALE_BYTES = 16_000_000;
const WHALE_SLOT = `${CENTER}-gt`;
const USER_IMAGE_BYTES = 3_000_000;
const USER_TUPLE = 18;
const BUDGET_MB = 8;
/** The on-screen column plus its nearest two siblings — the whole breadth of a wave (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column). */
const PREFETCH_COLUMNS = 3;
const BUDGET_BYTES = BUDGET_MB * 1024 * 1024;

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Sent { label: string; bytes: number; at: number }

/** One serialized channel: FIFO, priced in bytes, acknowledged only on drain. */
class FakeWire {
  clock = 0;
  private pending: Array<{ label: string; bytes: number; release: () => void }> = [];
  readonly sent: Sent[] = [];
  maxSpeculativeInFlight = 0;

  post(label: string, bytes: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      this.pending.push({ label, bytes, release: () => resolve(true) });
      this.maxSpeculativeInFlight = Math.max(this.maxSpeculativeInFlight, this.queuedSpeculativeBytes);
    });
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  /** Bytes of speculative (prefetch) images sitting on the wire; the user push is excluded by label. */
  get queuedSpeculativeBytes(): number {
    return this.pending.filter(p => p.label.startsWith('image:') && !p.label.startsWith('image:user')).reduce((s, p) => s + p.bytes, 0);
  }

  private async drainOnce(): Promise<void> {
    while (this.pending.length) {
      const head = this.pending.shift()!;
      this.clock += head.bytes / WIRE_BYTES_PER_MS;
      this.sent.push({ label: head.label, bytes: head.bytes, at: this.clock });
      head.release();
      await tick();
    }
  }

  /** Drain until the producer stops re-filling — releasing budget lets more speculation on. */
  async drainFully(): Promise<void> {
    for (let idle = 0; idle < 3; ) {
      await this.drainOnce();
      await settle(3);
      idle = this.pending.length ? 0 : idle + 1;
    }
  }
}

function labelOf(msg: any): string {
  if (msg.type === 'image') return `image:${msg.tupleIndex === USER_TUPLE ? 'user' : 'spec'}:${msg.tupleIndex}-${msg.modalityIndex}`;
  if (msg.type === 'thumbnail') return 'thumbnail';
  return msg.type;
}

function bytesOf(msg: any): number {
  if (msg.type === 'image') return msg.bytes.byteLength;
  if (msg.type === 'thumbnail') return msg.bytes.byteLength;
  return 200;
}

interface Scenario {
  wire: FakeWire;
  sweepDoneLine: string;
  userSentAt: number;
  lastThumbnailAt: number;
  speculativeAheadOfUser: number;
  queuedDeltaOnUserPost: number;
  speculativeDelivered: number;
}

async function runScenario(remote: boolean): Promise<Scenario> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-wire-'));
  tmpRoots.push(root);
  const wire = new FakeWire();
  const thumbResolvers: Array<(v: Buffer) => void> = [];

  const provider = new ImageCompareProvider(
    { globalStorageUri: Uri.file(root) } as unknown as import('vscode').ExtensionContext
  );
  // Only the byte source is stubbed: scheduling, the sweep, wave accounting and posting are real code.
  (provider as unknown as { thumbnailService: unknown }).thumbnailService = {
    getThumbnail: () => new Promise<Buffer>(resolve => { thumbResolvers.push(resolve); }),
    loadFullImage: async (uri: Uri) => {
      const modality = path.basename(path.dirname(uri.path));
      const tupleIndex = Number(path.basename(uri.path).replace(/\D/g, ''));
      const size = `${tupleIndex}-${modality}` === WHALE_SLOT ? WHALE_BYTES : IMAGE_BYTES[modality];
      return { bytes: new Uint8Array(size), mime: 'image/png', width: 4, height: 4 };
    },
    thumbTierStats: () => ({
      memory: { count: 0, ms: 0, bytes: 0 },
      pack: { count: 0, ms: 0, bytes: 0 },
      disk: { count: 0, ms: 0, bytes: 0 },
      generated: { count: 0, ms: 0, bytes: 0 }
    }),
    // This bed never loads a pack; the sweep rollup still asks for the shared-read snapshot.
    thumbPackLoadStat: () => ({ count: 0, ms: 0, bytes: 0, blocked: 0, waitedMs: 0 })
  };

  const tuples = Array.from({ length: TUPLES }, (_, t) => ({
    name: `frame${t}`,
    images: MODALITIES.map(m => ({ uri: Uri.file(`/imgs/${m}/frame${t}.png`), name: `frame${t}.png`, modality: m }))
  }));

  const state: Record<string, unknown> = {
    panel: { webview: { postMessage: (msg: any) => wire.post(labelOf(msg), bytesOf(msg)) } },
    scanResult: { modalities: [...MODALITIES], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    currentTupleIndex: CENTER,
    sweepAim: newSweepAimPolicy(),
    disposed: false,
    visible: true,
    poolKey: `wire-${Math.random().toString(36).slice(2)}`,
    prefetchWaveKey: 'unset',
    prefetchWaveCounter: 0,
    imageLoadKeys: new Set<string>(),
    webviewReady: true,
    pendingDebugMessages: [],
    lastTupleSwitchAt: 0,
    heldImagePosts: new Map(),
    wire: { thumbnails: 0, thumbB64Bytes: 0, images: 0, imageBytes: 0 },
    prefetchWaves: new Map(),
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(BUDGET_MB, remote ? 'ssh-remote' : undefined))
  };

  const inner = provider as unknown as {
    generateAllThumbnails(s: unknown): void;
    prefetchAround(s: unknown, i: number, scope: unknown): Promise<void>;
    sendImage(s: unknown, t: number, m: number): Promise<void>;
  };

  // The trace's shape: a wave is issued while the open-time sweep is still draining.
  inner.generateAllThumbnails(state);
  await tick();
  // `gt` on screen, so the wave's three columns (gt, ours, baseline) still carry the trace's 16MB whale.
  await inner.prefetchAround(state, CENTER, {
    modalityOrder: MODALITIES.map((_, i) => i),
    currentDisplayIndex: 0,
    isHidden: () => false
  });
  await settle();

  let queuedDeltaOnUserPost = -1;
  let speculativeAheadOfUser = -1;
  const total = TUPLES * MODALITIES.length;
  let served = 0;
  let guard = 0;
  while (served < total && guard++ < 20000) {
    const resolve = thumbResolvers.shift();
    if (!resolve) {
      await tick();
      continue;
    }
    resolve(Buffer.alloc(THUMB_BYTES));
    served++;
    if (served === 20) {
      // The user asks for an image mid-sweep, mid-wave: this is the push that must never be withheld.
      (state.loadedImages as Map<string, unknown>).set(`${USER_TUPLE}-0`, {
        bytes: new Uint8Array(USER_IMAGE_BYTES), mime: 'image/png', width: 4, height: 4
      });
      speculativeAheadOfUser = wire.queuedSpeculativeBytes;
      const before = wire.queuedCount;
      await inner.sendImage(state, USER_TUPLE, 0);
      queuedDeltaOnUserPost = wire.queuedCount - before;
    }
    await tick();
  }

  await settle();
  await wire.drainFully();

  const sweepDoneLine = __channelLines(CHANNEL).find(l => l.includes('[IC-SWEEP]') && l.includes(' done ')) ?? '';
  const userSent = wire.sent.find(s => s.label.startsWith('image:user'));
  const thumbs = wire.sent.filter(s => s.label === 'thumbnail');
  return {
    wire,
    sweepDoneLine,
    userSentAt: userSent ? userSent.at : Number.POSITIVE_INFINITY,
    lastThumbnailAt: thumbs.length ? thumbs[thumbs.length - 1].at : Number.POSITIVE_INFINITY,
    speculativeAheadOfUser,
    queuedDeltaOnUserPost,
    speculativeDelivered: wire.sent.filter(s => s.label.startsWith('image:spec')).length
  };
}

async function withDebugChannel(remote: boolean): Promise<Scenario> {
  __resetConfig();
  __resetChannels();
  disposeDebugLog();
  __setRemoteName(remote ? 'ssh-remote' : undefined);
  __setConfig('debug', true);
  __setConfig('prefetchCount', PREFETCH_COUNT);
  __setConfig('prefetchTransportBudgetMB', BUDGET_MB);
  initDebugLog();
  try {
    return await runScenario(remote);
  } finally {
    disposeDebugLog();
    __setRemoteName(undefined);
    __resetConfig();
    __resetChannels();
  }
}

describe('transport fairness on a serialized wire (real ImageCompareProvider)', () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await withDebugChannel(true);
  }, 120000);

  it('the sweep drains without a prefetch wave on the wire (Round 1 [IC-SWEEP] rollup)', () => {
    // 120 thumbnails posted, and exactly ONE image: the user-facing one. Before backpressure this
    // read images=42/59.5MB — the wave crossing the channel while the carousel waited.
    expect(s.sweepDoneLine).toMatch(/wire thumbs=120\/\S+ images=1\/2\.9MB/);
  });

  it('every thumbnail has crossed the wire in under 1.5 virtual seconds', () => {
    expect(s.lastThumbnailAt).toBeLessThan(1500);
  });

  it('a user-facing image posted mid-wave is not queued behind speculative bytes', () => {
    expect(s.speculativeAheadOfUser).toBe(0);
    expect(s.userSentAt).toBeLessThan(1000);
  });

  it('the policy never withholds a user-facing push — it reaches the wire in the same turn', () => {
    expect(s.queuedDeltaOnUserPost).toBe(1);
  });

  it('speculative bytes in flight stay inside the budget (one over-budget image may go alone)', () => {
    expect(s.wire.maxSpeculativeInFlight).toBeLessThanOrEqual(Math.max(BUDGET_BYTES, WHALE_BYTES));
    expect(s.wire.maxSpeculativeInFlight).toBeLessThan(20_000_000);
  });

  it('deferred speculation is delivered, not dropped, once the sweep ends', () => {
    // 7 tuples x 3 columns: the wave is scoped to the on-screen column and its nearest two
    // siblings, not all six modalities (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column).
    expect(s.speculativeDelivered).toBe((PREFETCH_COUNT * 2 + 1) * PREFETCH_COLUMNS);
  });
});

// The control the green assertions above lean on: with the policy inert the SAME harness reproduces
// the pathology, so a scenario that quietly stopped blocking could not read as a pass. It is also
// the local-session case — no remoteName, no bound, the pre-backpressure behaviour byte for byte.
describe('control: with the budget off (local session) the wave still head-of-line blocks', () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await withDebugChannel(false);
  }, 120000);

  it('the whole prefetch wave crosses the wire while the sweep drains', () => {
    expect(s.sweepDoneLine).toMatch(/wire thumbs=120\/\S+ images=22\/46\.3MB/);
  });

  it('thumbnails and the user-facing image finish an order of magnitude later', () => {
    // Six times the treated run, not the old sixty: a scoped wave is 45MB of speculation on this
    // wire rather than 59MB, and unbounded it still buries a 515KB sweep.
    expect(s.lastThumbnailAt).toBeGreaterThan(8000);
    expect(s.userSentAt).toBeGreaterThan(8000);
    expect(s.speculativeAheadOfUser).toBeGreaterThan(40_000_000);
  });
});
