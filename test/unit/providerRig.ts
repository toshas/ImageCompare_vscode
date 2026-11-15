import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** Two modalities, two tuples: deleting one slot leaves its tuple and its column alive, so the delete posts `fileDeleted`. */
export function imageFixture(tmpRoots: string[], prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  for (const mod of ['gt', 'pred']) {
    fs.mkdirSync(path.join(root, mod));
    for (const n of ['a.png', 'b.png']) fs.writeFileSync(path.join(root, mod, n), '');
  }
  return root;
}

/** A panel the real openCompare binds to; `send` delivers a webview message to whichever state is listening. */
export function fakePanel(posted: unknown[]) {
  let deliver: ((m: unknown) => unknown) | undefined;
  const panel = {
    visible: true,
    webview: {
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u: unknown) => u,
      postMessage: (msg: unknown) => { posted.push(msg); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (m: unknown) => unknown) => { deliver = listener; return { dispose: () => { deliver = undefined; } }; }
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeViewState: () => ({ dispose: () => undefined })
  };
  return { panel: panel as unknown as import('vscode').WebviewPanel, send: (m: unknown) => deliver?.(m) };
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
