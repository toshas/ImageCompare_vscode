import { Uri } from '../mocks/vscode';
import { newSweepAimPolicy } from '../../src/imageCompareProvider';
import { TransportBudget, resolveTransportBudgetBytes } from '../../src/transportBudget';
import { emptyPackLoadStat, emptyTierStats } from '../../src/debugLog';

// Shared scaffolding for the provider-level sweep suites. Not a suite itself: no `.test.ts` suffix.

/** A thumbnailService stub: each getThumbnail calls `onRead`, then waits for the test to call the resolver it queued. */
export function thumbnailServiceStub(
  resolvers: Array<() => void>,
  onRead: (uri: Uri) => void,
  onRelease: () => void = () => undefined
) {
  return {
    getThumbnail: (uri: Uri) =>
      new Promise<Buffer>(resolve => {
        onRead(uri);
        resolvers.push(() => { onRelease(); resolve(Buffer.alloc(4)); });
      }),
    loadFullImage: async () => ({ bytes: new Uint8Array(10), mime: 'image/png', width: 4, height: 4 }),
    thumbTierStats: emptyTierStats,
    thumbPackLoadStat: emptyPackLoadStat
  };
}

export interface PanelStateOptions {
  modalities: string[];
  tuples: number;
  openAt: number;
  /** The pool key is this prefix plus a random suffix. */
  poolKeyPrefix: string;
  /** Receives every message the panel posts; omitted, posts are dropped. */
  posts?: unknown[];
  /** Directory the tuple image URIs sit under (`modalityDirs` stay at `/imgs`). */
  imageRoot?: string;
}

/** A live provider PanelState over a dense `frameNN` grid, on an ssh-remote transport budget. */
export function panelState(o: PanelStateOptions): any {
  const name = (t: number) => `frame${String(t).padStart(2, '0')}`;
  const imageRoot = o.imageRoot ?? '/imgs';
  const tuples = Array.from({ length: o.tuples }, (_, t) => ({
    name: name(t),
    images: o.modalities.map(m => ({ uri: Uri.file(`${imageRoot}/${m}/${name(t)}.png`), name: `${name(t)}.png`, modality: m }))
  }));
  return {
    panel: { webview: { postMessage: (msg: unknown) => { o.posts?.push(msg); return Promise.resolve(true); } } },
    scanResult: { modalities: [...o.modalities], tuples, mode: 2, roots: [], isMultiTupleMode: true },
    loadedImages: new Map(),
    modalityDirs: new Map(o.modalities.map(m => [m, Uri.file(`/imgs/${m}`)])),
    recentlyDeleted: [],
    winners: new Map(),
    votingEnabled: false,
    currentTupleIndex: o.openAt,
    sweepAim: newSweepAimPolicy(),
    disposed: false,
    visible: true,
    poolKey: `${o.poolKeyPrefix}-${Math.random().toString(36).slice(2)}`,
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
    transport: new TransportBudget<unknown>(resolveTransportBudgetBytes(8, 'ssh-remote'))
  };
}
