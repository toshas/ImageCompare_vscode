import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { scanForImages, readResultsFile, mapWinnersToIndices, disambiguateDirectoryNames, RESULTS_FILENAME } from './fileService';
import { applyLabels, parseSessionFile, serializeSessionFile } from './sessionFile';
import { normalizeImageBytes } from './wireFormat';
import { matchDeletedFile, shiftIndexAfterRemoval } from './watcherLogic';
import { adoptableImages, applyModalityInsert, newModalityDirCandidates } from './adoptionPlan';
import { planDirSweep, planSweepDirs, pruneBarrenMemos, recordDirListing, shouldLogPoolSnapshot } from './pollPlan';
import { applyArrival, planArrival } from './arrivalPlan';
import { commitSlotRemoval, deleteTupleFlow, removeModalityStep, removeTupleStep } from './removalPlan';
import { DeckIo, DECK_IMAGE_MAX_DIM, DECK_JPEG_QUALITY, exportDeck } from './pptxDeck';
import { persistResults } from './resultsFile';
import { ImageServeIo, ImageServeReply, refreshTupleImages, serveImage } from './imageServe';
import { performCrop } from './cropFlow';
import { planThumbnails, runThumbnailSweep, SWEEP_REQUEUE } from './thumbnailPlan';
import { buildInitPayload } from './initPayload';
import { PrefetchScope, prefetchWavePlan } from './prefetchPlan';
// Where the sweep aims and when that settles is the shared policy's, never this host's (docs/loading-architecture.md: sweep-centre-dwells).
import { SweepAimPolicy } from './sweepAimPolicy';
import { nextPanelKey, poolWidth, Priority, TaskCancelled, usableParallelism, WorkPool } from './workPool';
import { TransportBudget, reindexSlotKeyedPosts, resolveTransportBudgetBytes } from './transportBudget';
import { beginOpenMarks, debug, debugEnabled, debugVerbose, diffPackLoadStat, diffTierStats, formatBytes, formatOpenRollup, formatPackLoad, formatTierStats, itemsPerSecond, OpenMarks } from './debugLog';
import { THUMBNAIL_MIME, ThumbnailService } from './thumbnailService';
import { renderWebviewHtml } from './webviewShell';
import { parsePpmx } from './ppmxParser';
import {
  ScanResult,
  ImageTuple,
  ImageFile,
  WebViewMessage,
  ExtensionMessage,
  LoadedImage,
  OriginalModalityIndex,
  TupleIndex,
  asOriginal,
  asTuple,
  isImageFile,
  MODALITY_COLORS
} from './types';

// Fallback existence sweep for filesystems whose watchers are unreliable (see docs/file-watching.md).
const DELETE_POLL_INTERVAL_MS = 10000;
/** Debug-only pool/wire snapshot cadence while an open-time sweep is draining (docs/testing.md). */
const DEBUG_SNAPSHOT_INTERVAL_MS = 2000;
/** Cap on debug lines queued for the webview console before 'ready'; the output channel keeps them all. */
const PENDING_DEBUG_MAX = 200;
/** Re-list a known-barren directory this often, so a mount with a frozen directory mtime still gets picked up. */
const BARREN_RECHECK_SWEEPS = 6;
/** Frees a speculative push's budget if its `postMessage` never settles, so a lost ack cannot park prefetch for the session. */
const TRANSPORT_ACK_TIMEOUT_MS = 30000;
/** Idle, not total: a sweep that has settled no slot for this long is presumed stuck and gives the wire back (docs/loading-architecture.md: speculation-yields-the-wire). */
const TRANSPORT_SWEEP_IDLE_TIMEOUT_MS = 30000;

/**
 * Info about a recently deleted file (for rename detection)
 */
interface DeletedFileInfo {
  uri: vscode.Uri;
  tupleIndex: TupleIndex;
  modalityIndex: number;
  timestamp: number;
}

/**
 * State associated with a single panel instance
 */
interface PanelState {
  panel: vscode.WebviewPanel;
  scanResult: ScanResult;
  loadedImages: Map<string, LoadedImage>;
  currentTupleIndex: TupleIndex;
  /** This panel's sweep aim: raw reports in, a settled tile out — the shared policy, as the standalone's session has (docs/loading-architecture.md: sweep-centre-dwells, thumbnails-centre-out). */
  sweepAim: SweepAimPolicy;
  fileWatchers: vscode.FileSystemWatcher[];
  nodeWatchers: fs.FSWatcher[];
  /** Per-directory, so a removed modality releases exactly its own (docs/file-watching.md: watchers-released-with-modality). */
  watchersByDir: Map<string, { fsw: vscode.FileSystemWatcher; node?: fs.FSWatcher }>;
  /** Directories with an adoption in flight — three detectors race for the same one. */
  adoptingDirs: Set<string>;
  /** Base-dir children known to hold no images: mtime plus a sweep budget, since some mounts never advance a directory's mtime (docs/file-watching.md: barren-dirs-memoized). */
  barrenDirs: Map<string, { mtime: number; sweeps: number }>;
  deleteCheckTimer?: ReturnType<typeof setInterval>; // Polling timer for delete detection
  watchedDirs: Set<string>;
  baseUri?: vscode.Uri; // Root directory for single-directory mode (mode 1)
  sessionFileUri?: vscode.Uri; // The .imagecompare file this comparison was opened from
  colorsByUri?: Map<string, string>; // URI string -> pill color override (from session-file colors)
  modalityDirs: Map<string, vscode.Uri>; // Modality name -> directory URI (for mode 2)
  recentlyDeleted: DeletedFileInfo[];
  winners: Map<TupleIndex, OriginalModalityIndex>; // tupleIndex -> modalityIndex (extension is original space)
  votingEnabled: boolean; // true for mode 1 and 2 (directory-based modes)
  labelsExplicit: boolean; // modality names came from user-provided session-file labels
  disposed: boolean; // panel closed — in-flight async work must stop touching this state
  visible: boolean; // panel is showing — hidden panels don't poll or prefetch
  deleteSweepRunning: boolean; // guards against overlapping existence sweeps
  /** Last pool snapshot this panel's poll printed, so an idle window stops repeating it (docs/loading-architecture.md: idle-poll-logs-nothing-new). */
  lastPoolSnapshot?: string;
  poolKey: string; // work-pool cancellation key scoping this panel's tasks
  prefetchWaveKey: string; // key of the current prefetch wave (cancelled when superseded)
  prefetchWaveCounter: number;
  /** Live per-tuple image-load keys; leaving a tuple cancels its own (docs/loading-architecture.md: stale-tuple-loads-cancelled). */
  imageLoadKeys: Set<string>;
  webviewReady: boolean;
  pendingDebugMessages: string[];
  lastTupleSwitchAt: number; // last setCurrentTuple arrival; recent = the user is scrubbing
  heldImagePosts: Map<string, Extract<ExtensionMessage, { type: 'image' }>>; // off-screen payloads parked during a scrub burst
  burstFlushTimer?: ReturnType<typeof setTimeout>;
  /** Bytes-on-the-wire backpressure for speculative image pushes (docs/loading-architecture.md: speculation-yields-the-wire). */
  transport: TransportBudget<Extract<ExtensionMessage, { type: 'image' }>>;
  sweepIdleTimer?: ReturnType<typeof setTimeout>; // sweep-stall watchdog; cleared at sweep end and on dispose
  /** Live ack watchdogs, so dispose can clear them instead of retaining the panel for the timeout (docs/loading-architecture.md: speculation-yields-the-wire). */
  ackWatchdogs?: Set<ReturnType<typeof setTimeout>>;
  /** Running outbound accounting for the debug channel; both totals are raw payload bytes, since thumbnails cross the channel binary like images. */
  wire: { thumbnails: number; thumbBytes: number; images: number; imageBytes: number };
  /** Debug-only prefetch-wave rollups, keyed by wave key; `open` until issuing finishes, then deleted as the wave drains. */
  prefetchWaves: Map<string, { center: number; issued: number; done: number; bytes: number; startedAt: number; open: boolean }>;
  sweepStatsTimer?: ReturnType<typeof setInterval>; // debug-only; cleared at sweep end and on dispose
  /** Re-enters the running sweep's pump; called whenever this panel's visible/disposed answer changes (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels). */
  sweepRepump?: () => void;
  /** Debug-only open trace; absent when debug was off at open, and cleared once the rollup is emitted (docs/loading-architecture.md: open-spans-account-for-the-whole-open). */
  openMarks?: OpenMarks;
}

/** The sweep's own cancellation key: a re-aim drops queued thumbnail reads only, never the panel's export/poll work (docs/loading-architecture.md: sweep-cancels-on-reaim). */
function sweepPoolKey(state: PanelState): string {
  return `${state.poolKey}-sweep`;
}

let shared: WorkPool | undefined;

/**
 * The single pool every panel's image work goes through. No aging: safe only while
 * every producer stays finite — see docs/loading-architecture.md.
 */
function sharedWorkPool(): WorkPool {
  if (!shared) {
    // The os-derived counts and the override live here so workPool.ts stays browser-safe; the width rule is the shared poolWidth (docs/loading-architecture.md: pool-width-hides-latency).
    const override = vscode.workspace.getConfiguration('imageCompare').get<number>('maxConcurrentReads', 0);
    shared = new WorkPool(poolWidth(usableParallelism(os.availableParallelism?.(), os.cpus()?.length), override));
  }
  return shared;
}

/** The host's whole contribution to the aim: two timer primitives, no decision (docs/standalone.md: host-supplies-data-not-policy, docs/loading-architecture.md: sweep-centre-dwells). */
export function newSweepAimPolicy(): SweepAimPolicy {
  return new SweepAimPolicy({
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  });
}

/**
 * Provider for the ImageCompare WebView panel
 */
export class ImageCompareProvider {
  private thumbnailService: ThumbnailService;
  private readonly pool: WorkPool = sharedWorkPool();
  private disposables: vscode.Disposable[] = [];
  // Track all open panels (for cleanup on deactivate)
  private panels: Set<PanelState> = new Set();

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.thumbnailService = new ThumbnailService(context);
  }

  /** webview/context menu commands; ctx is the clicked element's merged data-vscode-context. */
  async handleMenuCommand(
    action: 'copyImage' | 'copyPath' | 'revealInExplorer' | 'toggleHidden',
    ctx: { webviewSection?: string; tupleIndex?: number; modalityIndex?: number } | undefined
  ): Promise<void> {
    const state = [...this.panels].find(s => s.panel.active && !s.disposed);
    if (!state || !ctx) return;

    if (action === 'copyImage') {
      const msg: ExtensionMessage = { type: 'copyImage' };
      state.panel.webview.postMessage(msg);
      return;
    }

    if (action === 'toggleHidden') {
      if (typeof ctx.modalityIndex !== 'number') return;
      const msg: ExtensionMessage = { type: 'toggleModalityHidden', modalityIndex: asOriginal(ctx.modalityIndex) };
      state.panel.webview.postMessage(msg);
      return;
    }

    const uri = this.resolveMenuTarget(state, ctx);
    if (!uri) return;
    if (action === 'copyPath') {
      try {
        await vscode.env.clipboard.writeText(uri.fsPath);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not copy the path: ${e?.message ?? e}`);
      }
      return;
    }
    // Reveal in VS Code's Explorer tree — works over remotes, where an OS file-manager reveal cannot.
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }

  /** The image section targets the displayed file; the pill section (or a missing file) falls back to the modality path. */
  private resolveMenuTarget(
    state: PanelState,
    ctx: { webviewSection?: string; tupleIndex?: number; modalityIndex?: number }
  ): vscode.Uri | undefined {
    const modality = typeof ctx.modalityIndex === 'number' ? state.scanResult.modalities[ctx.modalityIndex] : undefined;
    if (modality === undefined) return undefined;
    if (ctx.webviewSection === 'imageCompareImage' && typeof ctx.tupleIndex === 'number') {
      const tuple = state.scanResult.tuples[ctx.tupleIndex];
      const img = tuple ? this.findImageForModality(tuple, modality) : undefined;
      if (img) return img.uri;
    }
    return vscode.Uri.file(this.resolveModalityPath(state, modality));
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    await this.thumbnailService.initialize();
  }

  /**
   * Open the ImageCompare viewer for the given URIs in the supplied panel; never creates
   * a panel itself (docs/session-files.md: custom-editor-entry).
   * @param labels modality name overrides, keyed by URI string (mode 2 only)
   * @param sessionFileUri the .imagecompare file this was opened from (results.txt placement)
   * @param colors modality pill color overrides, keyed by URI string
   */
  async openCompare(uris: vscode.Uri[], panel: vscode.WebviewPanel, labels?: Map<string, string>, sessionFileUri?: vscode.Uri, colors?: Map<string, string>): Promise<void> {
    // One flag read gates the whole open trace; every later mark is guarded by this object's existence (docs/loading-architecture.md: debug-off-costs-nothing).
    const marks = debugEnabled() ? beginOpenMarks(Date.now()) : undefined;
    // Close during the scan would leak watchers/timers: the real onDidDispose is only attached after it.
    let closedDuringScan = false;
    const earlyDispose = panel.onDidDispose(() => { closedDuringScan = true; });
    try {
      const scanResult = await scanForImages(uris, labels);
      if (marks) {
        marks.scanDoneAt = Date.now();
        marks.scanFiles = scanResult.stats?.files ?? 0;
        marks.matchMs = scanResult.stats?.matchMs ?? 0;
      }

      if (closedDuringScan) {
        earlyDispose.dispose();
        return;
      }

      if (scanResult.tuples.length === 0) {
        earlyDispose.dispose();
        panel.webview.html = this.getEmptyScanHtml(uris);
        return;
      }

      // Mode 1 sets baseUri, mode 2 sets modalityDirs, mode 3 neither (see docs/session-files.md).
      let baseUri: vscode.Uri | undefined;
      const modalityDirs = new Map<string, vscode.Uri>();

      // The scan's verdict, not the raw input: a listed path that no longer exists is dropped first (docs/session-files.md: mode-is-explicit).
      if (scanResult.mode === 1) {
        baseUri = scanResult.roots[0];
      } else if (scanResult.mode === 2) {
        // Labels must be applied at every naming site (docs/session-files.md: labels-all-or-none).
        const disambiguated = applyLabels(disambiguateDirectoryNames(scanResult.roots), labels);
        for (const { name, uri } of disambiguated) {
          if (scanResult.modalities.includes(name)) {
            modalityDirs.set(name, uri);
          }
        }
      }

      // Watched dirs: base (mode 1), each modality dir (mode 2), plus every leaf dir holding images — keyed by `.path`, never a native path (docs/file-watching.md: watched-dirs-are-uri-paths).
      const watchedDirs = new Set<string>();
      if (baseUri) {
        watchedDirs.add(baseUri.path);
      }
      if (modalityDirs.size > 0) {
        for (const dirUri of modalityDirs.values()) {
          watchedDirs.add(dirUri.path);
        }
      }
      for (const tuple of scanResult.tuples) {
        for (const img of tuple.images) {
          const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
          if (dir) watchedDirs.add(dir);
        }
      }

      // Voting is directory-based modes only (docs/session-files.md).
      const votingEnabled = baseUri !== undefined || modalityDirs.size > 0;

      const panelKey = nextPanelKey();
      const panelState: PanelState = {
        panel,
        scanResult,
        loadedImages: new Map<string, LoadedImage>(),
        currentTupleIndex: asTuple(0),
        sweepAim: newSweepAimPolicy(),
        fileWatchers: [],
        nodeWatchers: [],
        watchersByDir: new Map(),
        adoptingDirs: new Set<string>(),
        barrenDirs: new Map<string, { mtime: number; sweeps: number }>(),
        watchedDirs,
        baseUri,
        sessionFileUri,
        colorsByUri: colors,
        modalityDirs,
        labelsExplicit: !!labels && labels.size > 0 && scanResult.mode === 2,
        recentlyDeleted: [],
        winners: new Map<TupleIndex, OriginalModalityIndex>(),
        votingEnabled,
        webviewReady: false,
        pendingDebugMessages: [],
        lastTupleSwitchAt: 0,
        heldImagePosts: new Map(),
        disposed: false,
        visible: panel.visible,
        deleteSweepRunning: false,
        poolKey: panelKey,
        prefetchWaveKey: `${panelKey}-prefetch-0`,
        prefetchWaveCounter: 0,
        imageLoadKeys: new Set<string>(),
        wire: { thumbnails: 0, thumbBytes: 0, images: 0, imageBytes: 0 },
        prefetchWaves: new Map(),
        // Unlimited unless this window is remote (docs/loading-architecture.md: wire-budget-remote-only).
        transport: new TransportBudget(resolveTransportBudgetBytes(
          vscode.workspace.getConfiguration('imageCompare').get<number>('prefetchTransportBudgetMB'),
          vscode.env.remoteName
        )),
        openMarks: marks
      };

      if (marks) marks.watchersAt = Date.now();
      this.setupFileWatcher(panelState);
      if (marks) {
        marks.watchersDoneAt = Date.now();
        marks.watchedDirs = watchedDirs.size;
      }
      this.panels.add(panelState);

      // Per-panel, not the provider-wide `disposables` array: those would accumulate across open/close.
      const panelSubscriptions: vscode.Disposable[] = [earlyDispose];

      // Listener must be attached BEFORE setting HTML, which starts the webview's 'ready' post.
      panelSubscriptions.push(panel.webview.onDidReceiveMessage(
        (message: WebViewMessage) => this.handlePanelMessage(panelState, message)
      ));

      panelSubscriptions.push(panel.onDidChangeViewState(() => this.setPanelVisible(panelState, panel.visible)));

      // Triggers the webview JS to run and post 'ready'.
      if (marks) marks.htmlAt = Date.now();
      panel.webview.html = this.getHtmlContent(panel.webview);

      panel.onDidDispose(() => this.disposePanel(panelState, panelSubscriptions));
    } catch (error) {
      earlyDispose.dispose();
      const message = error instanceof Error ? error.message : 'Unknown error';
      // An empty panel is never left unexplained; the toast still covers the not-visible case (docs/session-files.md: resolve-never-throws).
      if (!closedDuringScan) {
        try { panel.webview.html = this.getEmptyScanHtml(uris, message); } catch { /* panel already gone */ }
      }
      vscode.window.showErrorMessage(`ImageCompare: ${message}`);
    }
  }


  /**
   * React to this panel being shown or hidden: nothing is cancelled but the speculative prefetch
   * wave, and the open-time sweep is paused while hidden and resumed on re-show
   * (docs/loading-architecture.md: hidden-keeps-work, hidden-sweep-pauses-not-cancels).
   */
  private setPanelVisible(state: PanelState, visible: boolean): void {
    state.visible = visible;
    if (!visible) this.pool.cancel(state.prefetchWaveKey);
    // Both directions: hiding must reach the pump to take effect at all, showing to restart it.
    state.sweepRepump?.();
  }

  /**
   * Tear a panel down: cancel its work, drop its caches and clear every timer it armed
   * (docs/loading-architecture.md, "Lifecycle").
   */
  private disposePanel(state: PanelState, subscriptions: vscode.Disposable[]): void {
    state.disposed = true;
    // Every key: pool.cancel matches exactly (docs/loading-architecture.md, "Lifecycle").
    this.pool.cancel(state.poolKey);
    this.pool.cancel(sweepPoolKey(state)); // the sweep's queue hangs off its own key (docs/loading-architecture.md: sweep-cancels-on-reaim)
    this.pool.cancel(state.prefetchWaveKey);
    this.cancelImageLoads(state); // per-tuple keys outlive poolKey's cancel (docs/loading-architecture.md: stale-tuple-loads-cancelled)
    state.sweepRepump?.(); // a sweep paused with nothing outstanding has no settle left to end it (docs/loading-architecture.md: hidden-sweep-pauses-not-cancels)
    state.loadedImages.clear();
    state.heldImagePosts.clear();
    state.transport.reset(); // parked speculation dies with the panel (docs/loading-architecture.md: speculation-yields-the-wire)
    if (state.burstFlushTimer) clearTimeout(state.burstFlushTimer);
    if (state.sweepStatsTimer) clearInterval(state.sweepStatsTimer);
    if (state.sweepIdleTimer) clearTimeout(state.sweepIdleTimer);
    state.sweepAim.dispose(); // a dwell must not fire against a dead panel (docs/loading-architecture.md: sweep-centre-dwells)
    // Un-acked pushes would otherwise retain this panel for the ack timeout (docs/loading-architecture.md: speculation-yields-the-wire).
    for (const timer of state.ackWatchdogs ?? []) clearTimeout(timer);
    state.ackWatchdogs?.clear();
    state.fileWatchers.forEach(w => w.dispose());
    state.nodeWatchers.forEach(w => w.close());
    if (state.deleteCheckTimer) clearInterval(state.deleteCheckTimer);
    subscriptions.forEach(d => d.dispose());
    this.panels.delete(state);
  }

  /**
   * Handle messages from the webview (panel-specific)
   */
  private async handlePanelMessage(state: PanelState, message: WebViewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (state.openMarks) state.openMarks.readyAt = Date.now();
        state.webviewReady = true;
        for (const msg of state.pendingDebugMessages) {
          state.panel.webview.postMessage({ type: '_debug', msg });
        }
        state.pendingDebugMessages = [];
        await this.sendInitData(state);
        break;

      case 'requestThumbnails':
        await this.sendThumbnails(state, message.tupleIndices);
        break;

      case 'requestImage':
        await this.sendImage(
          state,
          message.tupleIndex,
          message.modalityIndex,
          // The webview ranks its own request; the tail is the speculative remainder (docs/loading-architecture.md: sibling-tail-never-competes).
          message.tail ? Priority.SIBLING_TAIL : message.sibling ? Priority.SIBLING : Priority.VISIBLE,
          message.forceReload
        );
        break;

      case 'setCurrentTuple':
        // Queued loads for the tuple being left are work nobody awaits (docs/loading-architecture.md: stale-tuple-loads-cancelled).
        this.cancelImageLoads(state, message.tupleIndex);
        state.currentTupleIndex = message.tupleIndex;
        state.lastTupleSwitchAt = Date.now();
        state.sweepAim.noteTuple(message.tupleIndex);
        // The user landed here: anything held for this tuple is delivered now, ahead of the burst flush.
        for (const [key, held] of state.heldImagePosts) {
          if (held.tupleIndex === message.tupleIndex) {
            state.heldImagePosts.delete(key);
            this.postImageNow(state, held);
          }
        }
        break;

      case 'setCurrentModality':
        // A clicked column aims the sweep at once; `tupleFullyLoaded` can be a whole cold tuple away (docs/loading-architecture.md: click-reports-its-column).
        state.sweepAim.noteStrip(message);
        break;

      case 'tupleFullyLoaded': {
        // The strip as displayed is also the sweep's column aim — the one report that carries it (docs/loading-architecture.md: thumbnails-centre-out).
        state.sweepAim.noteStrip(message);
        if (message.tupleIndex === state.currentTupleIndex) {
          const hidden = new Set<number>(message.hiddenModalities);
          // The strip as displayed is the wave's whole scope (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column).
          await this.prefetchAround(state, message.tupleIndex, {
            modalityOrder: message.modalityOrder,
            currentDisplayIndex: message.currentDisplayIndex,
            isHidden: o => hidden.has(o)
          });
        }
        break;
      }

      case 'setWinner':
        await this.handleSetWinner(state, message.tupleIndex, message.modalityIndex);
        break;

      case 'cropImages':
        await this.handleCropImages(state, message.tupleIndex, message.cropRect, message.srcWidth, message.srcHeight);
        break;

      case 'deleteTuple':
        await this.handleDeleteTuple(state, message.tupleIndex);
        break;

      case 'exportPptx':
        await this.handleExportPptx(state, message.tupleIndices, message.winnerModalityIndices, message.modalityOrder);
        break;

      case 'saveSessionAs':
        await this.saveSessionAs(state);
        break;

      case 'log':
        break;
    }
  }

  /**
   * Handle setting or clearing a winner for a tuple
   */
  private async handleSetWinner(state: PanelState, tupleIndex: TupleIndex, modalityIndex: OriginalModalityIndex | null): Promise<void> {
    if (!state.votingEnabled) return;

    if (modalityIndex === null) {
      state.winners.delete(tupleIndex);
    } else {
      state.winners.set(tupleIndex, modalityIndex);
    }

    const msg: ExtensionMessage = {
      type: 'winnerUpdated',
      tupleIndex,
      modalityIndex
    };
    state.panel.webview.postMessage(msg);

    await this.saveResults(state);
  }

  /**
   * Handle delete tuple request: delete all image files for the given tuple from disk.
   * File watchers will detect the deletions and update the UI.
   */
  private async handleDeleteTuple(state: PanelState, tupleIndex: TupleIndex): Promise<void> {
    // Remove eagerly rather than waiting on a watcher event, which may be up to a sweep away (docs/file-watching.md: self-writes-never-wait).
    await deleteTupleFlow<ImageFile>(state.scanResult, tupleIndex, {
      deleteFile: async img => { await vscode.workspace.fs.delete(img.uri); },
      removeTuple: idx => this.removeTuple(state, idx),
      removeModality: idx => this.removeModality(state, idx)
    });
  }

  /**
   * Handle PPTX export request: generate a PowerPoint presentation for voted tuples.
   */
  private async handleExportPptx(
    state: PanelState,
    tupleIndices: TupleIndex[],
    winnerModalityIndices: (OriginalModalityIndex | null)[],
    modalityOrder: OriginalModalityIndex[]
  ): Promise<void> {
    const loadImageBase64Unpooled = async (uri: vscode.Uri): Promise<{ data: string; width: number; height: number } | null> => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const buffer = Buffer.from(bytes);
          const ext = path.extname(uri.path).toLowerCase();
          const sharp = (await import('./sharpLoader')).getSharp();
          if (sharp) {
            let img;
            if (ext === '.ppmx') {
              const ppmx = parsePpmx(buffer);
              img = sharp(ppmx.rgbBuffer, { raw: { width: ppmx.width, height: ppmx.height, channels: 3 } });
            } else {
              img = sharp(buffer);
            }
            const meta = await img.metadata();
            // Capped and JPEG-recompressed, never full-res PNG (docs/crop-and-pptx.md: deck-images-bounded).
            const jpgBuffer = await img
              .resize(DECK_IMAGE_MAX_DIM, DECK_IMAGE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: DECK_JPEG_QUALITY })
              .toBuffer();
            return {
              data: `data:image/jpeg;base64,${jpgBuffer.toString('base64')}`,
              width: meta.width || 100,
              height: meta.height || 100
            };
          }
          // No Sharp: Jimp must still cap and recompress (docs/crop-and-pptx.md: deck-images-bounded).
          const capped = await this.thumbnailService.capSlideImage(buffer, ext);
          if (capped) {
            return {
              data: `data:image/jpeg;base64,${capped.bytes.toString('base64')}`,
              width: capped.width || 100,
              height: capped.height || 100
            };
          }
          // Last resort, no backend at all: pass bytes through, which only renders for browser-decodable formats.
          const mimeByExt: Record<string, string> = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
            '.bmp': 'image/bmp', '.webp': 'image/webp'
          };
          return {
            data: `data:${mimeByExt[ext] || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`,
            width: 100,
            height: 100
          };
        } catch {
          return null;
        }
      };

    const deckIo: DeckIo = {
      loadImage: async (tupleIndex, modalityOriginalIndex) => {
        const tuple = state.scanResult.tuples[tupleIndex];
        const modality = state.scanResult.modalities[modalityOriginalIndex];
        const img = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;
        if (!img) return null;
        // cancel() drains the queue once; a sequential producer must stop submitting itself.
        if (state.disposed) throw new TaskCancelled();
        return this.pool.submit(() => loadImageBase64Unpooled(img.uri), { priority: Priority.EXPORT, key: state.poolKey });
      },
      readCropMeta: async (tupleIndex, modality) => {
        const tuple = state.scanResult.tuples[tupleIndex];
        const img = tuple ? this.findImageForModality(tuple, modality) : undefined;
        if (!img) return null;
        if (state.disposed) throw new TaskCancelled();
        return this.pool.submit(() => this.thumbnailService.readCropMetadata(img.uri), { priority: Priority.EXPORT, key: state.poolKey });
      }
    };

    let saveUri: vscode.Uri | undefined;
    // Name, build, save and the exactly-one answer are sequenced by the shared flow (docs/crop-and-pptx.md: export-always-answers) (docs/standalone.md: deck-layout-shared).
    await exportDeck(state.scanResult.tuples, state.scanResult.modalities, { tupleIndices, winnerModalityIndices, modalityOrder }, {
      getPptx: async () => PptxGenJS,
      listExistingNames: async () => {
        const parentDir = this.pptxOutputDir(state);
        if (!parentDir) throw new Error('Cannot determine output directory');
        // Scan-and-increment, unlocked — same pattern (and same race) as crop numbering.
        try {
          return await fs.promises.readdir(parentDir);
        } catch {
          return []; // unreadable dir: the export still lands there with the default name
        }
      },
      deckIo,
      saveDeck: async (pptx, name) => {
        // One buffer, one write: a streamed write racing the completion notification is how a half-flushed deck gets opened.
        const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
        if (state.disposed) throw new TaskCancelled();
        saveUri = vscode.Uri.file(path.join(this.pptxOutputDir(state)!, name));
        await vscode.workspace.fs.writeFile(saveUri, buffer);
        if (state.disposed) throw new TaskCancelled();
        return saveUri.fsPath;
      },
      post: msg => { state.panel.webview.postMessage(msg); },
      // A closed panel is not a failure: every other pooled await filters this the same way.
      isCancelled: err => err instanceof TaskCancelled || state.disposed,
      onSaved: async savedPath => {
        const choice = await vscode.window.showInformationMessage(`PPTX exported: ${savedPath}`, 'Reveal in Explorer');
        if (choice && saveUri) void vscode.commands.executeCommand('revealInExplorer', saveUri);
      },
      onError: errorMsg => { vscode.window.showErrorMessage(`PPTX export failed: ${errorMsg}`); }
    });
  }

  /**
   * Crop every modality of the tuple to `cropRect`, given in the pixel space of the
   * image it was drawn on (`srcWidth`/`srcHeight`). See docs/crop-and-pptx.md.
   */
  private async handleCropImages(
    state: PanelState,
    tupleIndex: TupleIndex,
    cropRect: { x: number; y: number; w: number; h: number },
    srcWidth: number,
    srcHeight: number
  ): Promise<void> {
    // Naming, rect math, per-modality order and the terminal posts are sequenced by the shared flow (docs/crop-and-pptx.md: shared-crop-filename).
    await performCrop<ImageFile, { path: string; uri: vscode.Uri }>(state.scanResult, { tupleIndex, cropRect, srcWidth, srcHeight }, {
      listDirNames: async img => (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(img.uri, '..'))).map(([name]) => name),
      getDimensions: img => this.thumbnailService.getImageDimensions(img.uri),
      renderCrop: (img, rect, cropMeta) => this.thumbnailService.cropImage(img.uri, rect, cropMeta),
      writeCrop: async (img, outputName, bytes) => {
        const outputUri = vscode.Uri.joinPath(vscode.Uri.joinPath(img.uri, '..'), outputName);
        await vscode.workspace.fs.writeFile(outputUri, bytes);
        return { path: outputUri.path, uri: outputUri };
      },
      // Pooled per modality: a wide tuple would otherwise fan out full-res decodes without bound (docs/loading-architecture.md: visible-never-starved).
      schedule: work => this.pool.submit(work, { priority: Priority.EXPORT, key: state.poolKey }),
      isCancelled: err => err instanceof TaskCancelled,
      isAborted: () => state.disposed,
      // Place the crop now — a self-write never waits on its own event (docs/file-watching.md: self-writes-never-wait).
      arriveFile: saved => { this.handleFileCreated(state, saved.uri); },
      post: msg => { state.panel.webview.postMessage(msg); }
    });
  }

  /** Export output directory: the base dir, or the first modality's parent, or undefined. */
  private pptxOutputDir(state: PanelState): string | undefined {
    const baseDir = state.baseUri?.fsPath ||
      (state.modalityDirs.size > 0 ? Array.from(state.modalityDirs.values())[0].fsPath : undefined);
    if (!baseDir) return undefined;
    return state.baseUri ? baseDir : path.dirname(baseDir);
  }

  /**
   * Directory and filename for the results file, or undefined when voting is disabled.
   * The single placement rule for both the read and the write path — see the table in
   * docs/session-files.md, "getResultsTarget()".
   */
  private getResultsTarget(state: PanelState): { baseUri: vscode.Uri; filename: string } | undefined {
    if (state.baseUri) {
      return { baseUri: state.baseUri, filename: RESULTS_FILENAME };
    }

    if (state.modalityDirs.size > 0) {
      const uris = Array.from(state.modalityDirs.values());
      const paths = uris.map(u => u.path);
      const firstParent = paths[0].substring(0, paths[0].lastIndexOf('/'));
      const allSameParent = paths.every(p => p.startsWith(firstParent + '/'));

      if (!allSameParent && state.sessionFileUri) {
        const sessionPath = state.sessionFileUri.fsPath;
        const stem = path.basename(sessionPath).replace(/\.imagecompare$/i, '');
        return {
          baseUri: state.sessionFileUri.with({ path: path.dirname(state.sessionFileUri.path) }),
          filename: `${stem}.results.txt`
        };
      }

      return { baseUri: vscode.Uri.file(firstParent).with({ scheme: uris[0].scheme }), filename: RESULTS_FILENAME };
    }

    return undefined;
  }

  /** Title-bar entry point: Save Session As for the active panel. */
  async saveSessionAsActive(): Promise<void> {
    const state = [...this.panels].find(s => s.panel.active && !s.disposed);
    if (state) await this.saveSessionAs(state);
  }

  /** Save a copy of the session file (paths relativized when possible) plus the results sidecar if one exists. */
  private async saveSessionAs(state: PanelState): Promise<void> {
    if (!state.sessionFileUri) return;
    try {
      const defaultDir = this.suggestSessionSaveDir(state);
      const stem = path.basename(state.sessionFileUri.fsPath).replace(/\.imagecompare$/i, '');
      const destUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, `${stem}.imagecompare`),
        filters: { 'ImageCompare Session': ['imagecompare'] }
      });
      if (!destUri) return;

      const text = Buffer.from(await vscode.workspace.fs.readFile(state.sessionFileUri)).toString('utf8');
      const spec = parseSessionFile(text, path.dirname(state.sessionFileUri.fsPath));
      const destDir = path.dirname(destUri.fsPath);
      const body = serializeSessionFile(spec.paths, destDir, spec.labels, spec.colors);
      await vscode.workspace.fs.writeFile(destUri, Buffer.from(body, 'utf8'));

      // Sidecar votes ride along; folder-anchored results.txt stays put (docs/session-files.md: single-results-target).
      const target = this.getResultsTarget(state);
      if (target && target.filename !== RESULTS_FILENAME) {
        const srcResults = vscode.Uri.joinPath(target.baseUri, target.filename);
        const newStem = path.basename(destUri.fsPath).replace(/\.imagecompare$/i, '');
        try {
          const bytes = await vscode.workspace.fs.readFile(srcResults);
          await vscode.workspace.fs.writeFile(
            destUri.with({ path: `${destUri.path.substring(0, destUri.path.lastIndexOf('/'))}/${newStem}.results.txt` }),
            bytes
          );
        } catch {
          // No sidecar yet — nothing to carry.
        }
      }

      const choice = await vscode.window.showInformationMessage(`Session saved: ${destUri.fsPath}`, 'Reveal in Explorer');
      if (choice === 'Reveal in Explorer') {
        await vscode.commands.executeCommand('revealInExplorer', destUri);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not save the session: ${e?.message ?? e}`);
    }
  }

  /** Default save location: base dir (mode 1), common parent (mode 2), else the first image's directory. */
  private suggestSessionSaveDir(state: PanelState): vscode.Uri {
    if (state.baseUri) return state.baseUri;
    if (state.modalityDirs.size > 0) {
      const uris = Array.from(state.modalityDirs.values());
      const paths = uris.map(u => u.path);
      const firstParent = paths[0].substring(0, paths[0].lastIndexOf('/'));
      if (paths.every(p => p.startsWith(firstParent + '/'))) {
        return vscode.Uri.file(firstParent).with({ scheme: uris[0].scheme });
      }
      return uris[0].with({ path: firstParent });
    }
    const firstImage = state.scanResult.tuples[0]?.images[0]?.uri;
    if (firstImage) return firstImage.with({ path: firstImage.path.substring(0, firstImage.path.lastIndexOf('/')) });
    return state.sessionFileUri!.with({ path: state.sessionFileUri!.path.substring(0, state.sessionFileUri!.path.lastIndexOf('/')) });
  }

  /**
   * Persist current winners; deletes the file when no winners remain.
   */
  private async saveResults(state: PanelState): Promise<void> {
    // Write path goes through getResultsTarget, same as the read (docs/session-files.md: single-results-target).
    const target = this.getResultsTarget(state);
    if (!target) return;
    const { baseUri, filename } = target;

    const resultsUri = vscode.Uri.joinPath(baseUri, filename);

    // Empty-deletes, naming and serialization are the shared persist flow (docs/standalone.md: results-format-shared).
    await persistResults(state.scanResult.tuples, state.scanResult.modalities, state.winners, {
      writeText: async text => { await vscode.workspace.fs.writeFile(resultsUri, Buffer.from(text, 'utf-8')); },
      deleteFile: async () => { await vscode.workspace.fs.delete(resultsUri); }
    });
  }

  /**
   * Resolve a tuple's image by modality name. The only correct lookup: `tuple.images`
   * is sparse, so a position in it is not a modality index (docs/tuple-matching.md, "Trap 1").
   */
  private findImageForModality(tuple: ImageTuple, modality: string): ImageFile | undefined {
    return tuple.images.find(img => img.modality === modality);
  }

  /**
   * Terminal reply for a request whose file is no longer in the view. Suppressed only when the
   * enqueued slot still exists and another file occupies it — that slot is healthy, and marking it
   * missing would blank it for good, since the webview never re-requests a filled slot. A slot that
   * no longer exists still gets the post; the webview's range guard discards it
   * (docs/loading-architecture.md: reply-exactly-once).
   */
  private postVacatedSlotError(state: PanelState, tupleIndex: TupleIndex, modalityIndex: number, error: string): void {
    if (state.disposed) return;
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    if (tuple && modality && this.findImageForModality(tuple, modality)) return;
    const msg: ExtensionMessage = {
      type: 'imageError',
      tupleIndex,
      modalityIndex: asOriginal(modalityIndex),
      error
    };
    state.panel.webview.postMessage(msg);
  }

  /**
   * Where this file lives *now*. The slot it was enqueued at is checked first and is almost always
   * still correct, so the O(tuples) scan runs only when a splice actually moved the row. The hint
   * carries the modality *name*: a column splice invalidates every index but no name
   * (docs/tuple-matching.md: revalidate-slot-before-write).
   */
  private resolveSlotForUri(
    state: PanelState,
    hintTupleIndex: number,
    hintModality: string,
    uri: vscode.Uri
  ): { tupleIndex: TupleIndex; modalityIndex: number } | undefined {
    if (state.disposed) return undefined;
    const m = state.scanResult.modalities.indexOf(hintModality);
    if (m >= 0 && this.slotMatchesUri(state, hintTupleIndex, m, uri)) {
      return { tupleIndex: asTuple(hintTupleIndex), modalityIndex: m };
    }
    return this.findExistingSlotByUri(state, uri);
  }

  /**
   * True if the (tupleIndex, global modalityIndex) slot still maps to `uri`. Async loads
   * must re-validate before writing an index-keyed cache entry, because watcher events
   * re-index tuples underneath them (docs/tuple-matching.md: revalidate-slot-before-write).
   */
  private slotMatchesUri(state: PanelState, tupleIndex: number, modalityIndex: number, uri: vscode.Uri): boolean {
    if (state.disposed) return false;
    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) return false;
    const modality = state.scanResult.modalities[modalityIndex];
    if (!modality) return false;
    const img = this.findImageForModality(tuple, modality);
    return !!img && img.uri.toString() === uri.toString();
  }

  /**
   * Page shown when a session's paths hold no comparable images — a transient toast
   * over a permanently blank tab would leave the user with nothing to read.
   */
  private getEmptyScanHtml(uris: vscode.Uri[], errorMessage?: string): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const list = uris.map(u => `<li><code>${esc(u.fsPath)}</code></li>`).join('');
    const heading = errorMessage ? 'Could not compare these paths' : 'No images to compare';
    const lead = errorMessage
      ? `<p>${esc(errorMessage)}</p><p>ImageCompare was given:</p>`
      : '<p>ImageCompare found no matching images in:</p>';
    const trailer = errorMessage
      ? 'Close this tab and reopen with a valid selection.'
      : 'The files may have been moved, deleted, or not generated yet. Close this tab and reopen once the images exist.';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: var(--vscode-font-family); padding: 2rem; color: var(--vscode-foreground);">
<h2>${heading}</h2>
${lead}
<ul>${list}</ul>
<p>${trailer}</p>
</body></html>`;
  }

  /**
   * Send initialization data to webview
   */
  private async sendInitData(state: PanelState): Promise<void> {
    const marks = state.openMarks;
    if (marks) marks.initAt = Date.now();
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const prefetchCount = config.get<number>('prefetchCount', 3);
    const keepZoomOnTupleChange = config.get<boolean>('keepZoomOnTupleChange', false);

    const allModalities = state.scanResult.modalities;

    // Read path goes through getResultsTarget, same as the write (docs/session-files.md: single-results-target).
    if (state.votingEnabled) {
      const target = this.getResultsTarget(state);
      if (target) {
        try {
          const savedWinners = await readResultsFile(target.baseUri, target.filename);
          if (state.disposed) return;
          const indexedWinners = mapWinnersToIndices(
            savedWinners,
            state.scanResult.tuples,
            allModalities
          );
          // mapWinnersToIndices resolves names to original modality indices, keyed by tuple index; rebrand at the boundary.
          state.winners = new Map([...indexedWinners].map(([t, m]) => [asTuple(t), asOriginal(m)]));
        } catch {
          // File doesn't exist or can't be read - that's OK
        }
      }
    }

    // Assembled by the shared pure builder; session-file colors flow through the override hook (docs/standalone.md: adapter-contains-no-logic).
    const initMessage = buildInitPayload({
      tuples: state.scanResult.tuples,
      modalities: allModalities,
      modalityPaths: allModalities.map(mod => this.resolveModalityPath(state, mod)),
      winners: state.winners,
      config: { thumbnailSize, prefetchCount, keepZoomOnTupleChange },
      votingEnabled: state.votingEnabled,
      labelsExplicit: state.labelsExplicit,
      // Real installed version from the extension's own manifest via the activation context.
      version: String(this.context.extension.packageJSON.version ?? ''),
      colorOverride: (mod, i) => this.resolveModalityColor(state, mod, i)
    });

    if (marks) {
      // The one JSON pass debug adds; reported as `sizing` so nobody reads it as product cost (docs/loading-architecture.md: open-spans-account-for-the-whole-open).
      const sizingAt = Date.now();
      marks.initBytes = Buffer.byteLength(JSON.stringify(initMessage));
      marks.initSizingMs = Date.now() - sizingAt;
      marks.tuples = state.scanResult.tuples.length;
      marks.modalities = allModalities.length;
    }

    state.panel.webview.postMessage(initMessage);
    if (marks) marks.initPostedAt = Date.now();
    this.generateAllThumbnails(state);
  }

  /**
   * One-shot open-time sweep of every slot, dispatched outward from the current tuple. Not
   * visibility-gated: every slot is swept, so skipping one leaves a blank thumbnail for the
   * session. Queued dispatches are cancelled on re-aim and returned to the cursor, never dropped;
   * a dispose abandons the rest instead (docs/loading-architecture.md: sweep-covers-every-slot-once,
   * sweep-stops-when-host-abandons).
   */
  private generateAllThumbnails(state: PanelState): void {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    // Slot selection, order, totals and the sweep's wire traffic come from the shared planner/runner (docs/standalone.md: adapter-contains-no-logic).
    const plan = planThumbnails(state.scanResult.tuples, state.scanResult.modalities);
    const itemBySlot = new Map(plan.items.map(item => [`${item.tupleIndex}-${item.modalityIndex}`, item]));

    // The sweep opens aimed at the row the panel opened on; the dwell governs moves only (docs/loading-architecture.md: sweep-centre-dwells).
    state.sweepAim.noteSweepStart(state.currentTupleIndex);
    // One flag read gates the whole sweep's instrumentation — clock, snapshots and timer alike (docs/loading-architecture.md: debug-off-costs-nothing).
    const timed = debugEnabled();
    const sweepStart = timed ? Date.now() : 0;
    const openMarks = state.openMarks;
    // Emitted once per open, on the sweep's own clock: the trace is consumed here and no time falls between the two rollups (docs/loading-architecture.md: open-spans-account-for-the-whole-open).
    if (openMarks) {
      openMarks.sweepAt = timed ? sweepStart : Date.now();
      state.openMarks = undefined;
      debug('[IC-OPEN]', () => formatOpenRollup(openMarks));
    }
    const tiersBefore = timed ? this.thumbnailService.thumbTierStats() : undefined;
    const packLoadBefore = timed ? this.thumbnailService.thumbPackLoadStat() : undefined;
    let sweepPostedBytes = 0;
    // The sweep owns the wire until it drains (docs/loading-architecture.md: speculation-yields-the-wire).
    state.transport.setSweepActive(true);
    debug('[IC-SWEEP]', () => `start slots=${plan.total} items=${plan.items.length} missing=${plan.missing.length} grid=${state.scanResult.tuples.length}x${state.scanResult.modalities.length} pool ${this.pool.stats()}`);
    // Never overwrite a live interval: a second sweep on the same panel would strand the first past dispose.
    if (state.sweepStatsTimer) clearInterval(state.sweepStatsTimer);
    state.sweepStatsTimer = undefined;
    if (timed) {
      // Debug-only timer; cleared in the sweep's finally and again on panel dispose.
      state.sweepStatsTimer = setInterval(() => {
        debug('[IC-POOL]', () => `sweeping ${Date.now() - sweepStart}ms pool ${this.pool.stats()} ${this.formatWire(state)}`);
      }, DEBUG_SNAPSHOT_INTERVAL_MS);
    }

    let ended = false;
    // The one exit: the settle, a synchronous throw out of the prologue and the stall watchdog all land here (docs/loading-architecture.md: speculation-yields-the-wire).
    const endSweep = (): void => {
      if (ended) return;
      ended = true;
      if (state.sweepIdleTimer) {
        clearTimeout(state.sweepIdleTimer);
        state.sweepIdleTimer = undefined;
      }
      if (state.sweepStatsTimer) {
        clearInterval(state.sweepStatsTimer);
        state.sweepStatsTimer = undefined;
      }
      debug('[IC-SWEEP]', () => {
        const ms = Date.now() - sweepStart;
        const tiers = diffTierStats(tiersBefore ?? this.thumbnailService.thumbTierStats(), this.thumbnailService.thumbTierStats());
        // The shared pack read is reported beside the tiers, never inside them (docs/loading-architecture.md: shared-waits-are-not-per-item-work).
        const packLoad = diffPackLoadStat(packLoadBefore ?? this.thumbnailService.thumbPackLoadStat(), this.thumbnailService.thumbPackLoadStat());
        return `done ${ms}ms items=${plan.items.length} ${itemsPerSecond(plan.items.length, ms)}/s posted=${formatBytes(sweepPostedBytes)} ${formatTierStats(tiers)} ${formatPackLoad(packLoad)} pool ${this.pool.stats()} ${this.formatWire(state)}`;
      });
      // Logged first, so the rollup reports the traffic that shared the wire WITH the sweep (docs/loading-architecture.md: speculation-yields-the-wire).
      state.transport.setSweepActive(false);
      this.drainDeferredImagePosts(state);
    };
    // Re-armed by every slot that settles, so only a stalled sweep — never a long one — loses the wire.
    const armStallWatchdog = (): void => {
      if (!state.transport.active || ended) return;
      if (state.sweepIdleTimer) clearTimeout(state.sweepIdleTimer);
      state.sweepIdleTimer = setTimeout(endSweep, TRANSPORT_SWEEP_IDLE_TIMEOUT_MS);
    };
    armStallWatchdog();

    // Centre-out dispatch + FIFO-within-priority fills outward from the user's row (docs/loading-architecture.md: thumbnails-centre-out).
    let sweep: Promise<void>;
    try {
      sweep = runThumbnailSweep(
        plan,
        {
          makeThumbnail: item =>
            this.pool
              .submit(() => this.thumbnailService.getThumbnail(item.image.uri, thumbnailSize * 2), {
                // Ranks below on-demand THUMBNAIL so scrolling can't queue behind the sweep.
                priority: Priority.THUMBNAIL_BULK,
                key: sweepPoolKey(state),
                // The panel is the fair-share bucket, so a second tab's sweep interleaves with this one (docs/loading-architecture.md: bulk-sweeps-share-the-pool).
                group: state.poolKey
              })
              .then(bytes => ({ bytes, mime: THUMBNAIL_MIME }))
              .catch(error => {
                // A live panel's cancellation is the sweep's own re-aim drop, so the slot goes back to the cursor (docs/loading-architecture.md: sweep-cancels-on-reaim).
                if (error instanceof TaskCancelled) return state.disposed ? null : SWEEP_REQUEUE;
                if (state.disposed) return null;
                throw error;
              }),
          // The mechanism is the pool's; the decision to use it is the shared module's (docs/loading-architecture.md: sweep-cancels-on-reaim).
          dropQueued: () => this.pool.cancel(sweepPoolKey(state))
        },
        msg => {
          armStallWatchdog();
          if (msg.type === 'thumbnailProgress') {
            this.sendProgressMessage(state, msg.current, msg.total);
            return;
          }
          if (msg.type !== 'thumbnail' && msg.type !== 'thumbnailError') return;
          const item = itemBySlot.get(`${msg.tupleIndex}-${msg.modalityIndex}`);
          if (!item) {
            // A plan-missing slot: posted at its grid position, no live-slot re-resolution needed.
            if (msg.type === 'thumbnailError') this.sendThumbnailErrorMessage(state, msg.tupleIndex, msg.modalityIndex, msg.error);
            return;
          }
          // Async settles re-address to the file's live slot (docs/tuple-matching.md: revalidate-slot-before-write).
          const slot = this.resolveSlotForUri(state, msg.tupleIndex, item.image.modality, item.image.uri);
          if (!slot || slot.modalityIndex < 0) return;
          if (msg.type === 'thumbnail') {
            if (timed) sweepPostedBytes += msg.bytes.byteLength;
            this.sendThumbnailMessage(state, slot.tupleIndex, slot.modalityIndex, msg.bytes, msg.mime);
          } else this.sendThumbnailErrorMessage(state, slot.tupleIndex, slot.modalityIndex, msg.error);
        },
        // The host supplies only where the user is, whether it is still there and whether anyone is looking; every ordering decision is the shared module's (docs/loading-architecture.md: thumbnails-centre-out, sweep-stops-when-host-abandons, hidden-sweep-pauses-not-cancels, sweep-centre-dwells).
        {
          centre: () => state.sweepAim.aim(),
          abandoned: () => state.disposed,
          paused: () => !state.visible,
          onRepump: repump => { state.sweepRepump = repump; }
        }
      );
    } catch (error) {
      // The prologue posts before it returns a promise, so a synchronous throw would strand the claim.
      endSweep();
      throw error;
    }
    void sweep.finally(endSweep);
  }

  /** Running outbound totals for this panel — what Round 2 needs to see prefetch crowd out the sweep (docs/testing.md). */
  private formatWire(state: PanelState): string {
    const w = state.wire;
    return `wire thumbs=${w.thumbnails}/${formatBytes(w.thumbBytes)} images=${w.images}/${formatBytes(w.imageBytes)}`;
  }

  /**
   * Send thumbnails for specific tuple indices, at on-demand priority — ranked above the open-time bulk sweep. Requested when the tuple or modality set changes, never by scrolling.
   */
  private async sendThumbnails(state: PanelState, tupleIndices: TupleIndex[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    // Snapshot: removeModality splices the live array, and this loop awaits between columns.
    const allModalities = state.scanResult.modalities.slice();

    for (const tupleIndex of tupleIndices) {
      if (tupleIndex < 0 || tupleIndex >= state.scanResult.tuples.length) continue;

      const tuple = state.scanResult.tuples[tupleIndex];
      
      for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
        const modality = allModalities[modalityIndex];
        const imageFile = this.findImageForModality(tuple, modality);
        
        if (!imageFile) {
          // Both halves re-resolved: the row may have shifted and the column may have moved.
          const liveTuple = state.scanResult.tuples.indexOf(tuple);
          const liveMod = state.scanResult.modalities.indexOf(modality);
          if (liveTuple < 0 || liveMod < 0) continue;
          this.sendThumbnailErrorMessage(state, liveTuple, liveMod, 'Image not available');
          continue;
        }
        
        try {
          const bytes = await this.pool.submit(
            () => this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2),
            { priority: Priority.THUMBNAIL, key: state.poolKey }
          );
          const okSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
          if (!okSlot || okSlot.modalityIndex < 0) continue;
          this.sendThumbnailMessage(state, okSlot.tupleIndex, okSlot.modalityIndex, bytes, THUMBNAIL_MIME);
        } catch (error) {
          if (state.disposed) return;
          if (error instanceof TaskCancelled) continue;
          const slot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
          if (!slot || slot.modalityIndex < 0) continue;
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.sendThumbnailErrorMessage(state, slot.tupleIndex, slot.modalityIndex, message);
        }
      }
    }
  }

  /** Multi-MB payloads landing mid-scrub caused the trace's long tasks; the current tuple's are never held (docs/loading-architecture.md: held-payloads-always-flush). */
  private postImage(state: PanelState, msg: Extract<ExtensionMessage, { type: 'image' }>, speculative = false): void {
    const tight = normalizeImageBytes(msg.bytes);
    if (tight !== msg.bytes) msg = { ...msg, bytes: tight };
    const slotKey = `${msg.tupleIndex}-${msg.modalityIndex}`;
    if (speculative) {
      // Only speculation waits for the wire (docs/loading-architecture.md: user-pushes-never-withheld).
      if (!state.transport.canSend(msg.bytes.byteLength, true)) {
        state.transport.defer(slotKey, msg, msg.bytes.byteLength);
        return;
      }
    } else {
      // A user-facing push supersedes any parked speculation for the same slot.
      state.transport.drop(slotKey);
    }
    const bursting = Date.now() - state.lastTupleSwitchAt < 150;
    if (bursting && msg.tupleIndex !== state.currentTupleIndex) {
      state.heldImagePosts.set(`${msg.tupleIndex}-${msg.modalityIndex}`, msg);
      // Cap the parked payloads; a dropped one stays uncached in the webview and is simply re-requested on visit.
      if (state.heldImagePosts.size > 48) {
        const oldest = state.heldImagePosts.keys().next().value;
        if (oldest !== undefined) state.heldImagePosts.delete(oldest);
      }
      this.scheduleBurstFlush(state);
      return;
    }
    this.postImageNow(state, msg);
  }

  /** The single choke point where an `image` reaches the wire — so the debug byte count cannot miss one. */
  private postImageNow(state: PanelState, msg: Extract<ExtensionMessage, { type: 'image' }>): void {
    if (debugEnabled()) {
      state.wire.images++;
      state.wire.imageBytes += msg.bytes.byteLength;
      debugVerbose('[IC-WIRE]', () => `image t=${msg.tupleIndex} m=${msg.modalityIndex} ${formatBytes(msg.bytes.byteLength)} ${msg.mime} total=${formatBytes(state.wire.imageBytes)}`);
    }
    // User-facing bytes occupy the budget too, so speculation yields to them (docs/loading-architecture.md: user-pushes-never-withheld).
    if (!state.transport.active) {
      state.panel.webview.postMessage(msg);
      return;
    }
    const bytes = msg.bytes.byteLength;
    state.transport.noteSent(bytes);
    let acked = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (acked) return;
      acked = true;
      if (watchdog) {
        clearTimeout(watchdog);
        state.ackWatchdogs?.delete(watchdog);
      }
      state.transport.noteDelivered(bytes);
      this.drainDeferredImagePosts(state);
    };
    const posted = state.panel.webview.postMessage(msg);
    watchdog = setTimeout(release, TRANSPORT_ACK_TIMEOUT_MS);
    // Tracked so dispose can clear it; an un-acked push would otherwise retain the panel (docs/loading-architecture.md: speculation-yields-the-wire).
    (state.ackWatchdogs ??= new Set()).add(watchdog);
    // Resolution of postMessage is the delivery ack; over a remote link it is a full round trip.
    Promise.resolve(posted).then(release, release);
  }

  /** Release parked speculative pushes while the budget allows; ones the user has navigated away from are dropped, as `loadImageToCache` would have at push time (docs/loading-architecture.md: speculation-yields-the-wire). */
  private drainDeferredImagePosts(state: PanelState): void {
    if (state.disposed || state.transport.deferredCount === 0) return;
    const prefetchCount = vscode.workspace.getConfiguration('imageCompare').get<number>('prefetchCount', 3);
    for (;;) {
      const next = state.transport.takeNext();
      if (!next) return;
      if (Math.abs(next.item.tupleIndex - state.currentTupleIndex) > prefetchCount) continue;
      this.postImage(state, next.item, true);
    }
  }

  /** The park and the burst hold are slot-keyed like `loadedImages`, so a row splice moves them too (docs/file-watching.md: reindex-in-lockstep). */
  private reindexPendingImagePosts(state: PanelState, shift: (tupleIndex: number) => number | null): void {
    state.heldImagePosts = new Map(reindexSlotKeyedPosts(state.heldImagePosts, shift));
    state.transport.remap(entry => {
      const [moved] = reindexSlotKeyedPosts([[entry.key, entry.item]], shift);
      return moved ? { key: moved[0], bytes: entry.bytes, item: moved[1] } : undefined;
    });
  }

  /** The one slot invalidation: cached bytes, parked speculation and the burst hold all name this slot, so a caller that clears one leaves the others to paint a ghost (docs/loading-architecture.md: slot-invalidation-clears-the-wire). */
  private invalidateSlot(state: PanelState, tupleIndex: number, modalityIndex: number): void {
    const slotKey = `${tupleIndex}-${modalityIndex}`;
    state.loadedImages.delete(slotKey);
    state.transport.drop(slotKey);
    state.heldImagePosts.delete(slotKey);
  }

  /** A column splice renames every slot key, so parked and held posts go the way `loadedImages` does (docs/file-watching.md: reindex-in-lockstep). */
  private dropPendingImagePosts(state: PanelState): void {
    state.heldImagePosts.clear();
    state.transport.clearParked();
  }

  /** Re-arms while the scrub continues, then drains ONE payload per tick so each owns a quiet frame; dispose, the cap eviction in postImage, a column splice and slot invalidation are the only discards (docs/loading-architecture.md: held-payloads-always-flush, slot-invalidation-clears-the-wire). This ~32ms trickle is the only route to the wire that re-checks no byte budget (docs/loading-architecture.md: speculation-yields-the-wire). */
  private scheduleBurstFlush(state: PanelState, delayMs = 180): void {
    if (state.burstFlushTimer) clearTimeout(state.burstFlushTimer);
    state.burstFlushTimer = setTimeout(() => {
      state.burstFlushTimer = undefined;
      if (state.disposed) return;
      if (Date.now() - state.lastTupleSwitchAt < 150) {
        this.scheduleBurstFlush(state);
        return;
      }
      const first = state.heldImagePosts.entries().next();
      if (first.done) return;
      state.heldImagePosts.delete(first.value[0]);
      this.postImageNow(state, first.value[1]);
      if (state.heldImagePosts.size > 0) this.scheduleBurstFlush(state, 32);
    }, delayMs);
  }

  /** Drop every queued image load except `keepTupleIndex`'s (docs/loading-architecture.md: stale-tuple-loads-cancelled). */
  private cancelImageLoads(state: PanelState, keepTupleIndex?: TupleIndex): void {
    const keep = keepTupleIndex === undefined ? undefined : this.imageLoadKey(state, keepTupleIndex);
    for (const key of state.imageLoadKeys) {
      if (key === keep) continue;
      this.pool.cancel(key);
      state.imageLoadKeys.delete(key);
    }
  }

  private imageLoadKey(state: PanelState, tupleIndex: TupleIndex): string {
    return `${state.poolKey}-image-${tupleIndex}`;
  }

  /**
   * Send a full image to the webview. Replies exactly once (`image` or `imageError`) unless the
   * panel is gone or another file now occupies the enqueued slot — a silent drop is a stuck spinner
   * (docs/loading-architecture.md: reply-exactly-once).
   */
  private async sendImage(
    state: PanelState,
    tupleIndex: TupleIndex,
    modalityIndex: OriginalModalityIndex,
    priority: Priority = Priority.VISIBLE,
    forceReload = false
  ): Promise<void> {
    const cacheKey = `${tupleIndex}-${modalityIndex}`;

    // Drop the cached bytes first or the retry re-serves them (docs/loading-architecture.md).
    if (forceReload) {
      this.invalidateSlot(state, tupleIndex, modalityIndex);
    }

    if (state.loadedImages.has(cacheKey)) {
      const cached = state.loadedImages.get(cacheKey)!;
      if (state.disposed) return;
      this.postImage(state, {
        type: 'image',
        tupleIndex,
        modalityIndex,
        bytes: cached.bytes,
        mime: cached.mime,
        width: cached.width,
        height: cached.height
      });
      return;
    }

    // Range-guarded: an out-of-range index resolves no image and replies imageError, throwing nothing.
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;

    const io: ImageServeIo<ImageFile> = {
      loadRaw: async img => ({ bytes: await vscode.workspace.fs.readFile(img.uri), ext: path.extname(img.uri.path).toLowerCase() }),
      // No backend call at all; 0×0 means "webview sizes from naturalWidth/Height" (docs/image-backends.md: passthrough-no-backend).
      probePassthrough: async () => ({ width: 0, height: 0 }),
      convert: (bytes, ext) => this.thumbnailService.convertFullImage(Buffer.from(bytes), ext)
    };

    const deliver = (reply: ImageServeReply): void => {
      if (!imageFile) {
        if (state.disposed || reply.kind !== 'error') return;
        const msg: ExtensionMessage = { type: 'imageError', tupleIndex, modalityIndex, error: reply.error };
        state.panel.webview.postMessage(msg);
        return;
      }
      if (reply.kind === 'image') {
        // Guards the cache write only — never the reply below.
        if (this.slotMatchesUri(state, tupleIndex, modalityIndex, imageFile.uri)) {
          state.loadedImages.set(cacheKey, { bytes: reply.bytes, mime: reply.mime, width: reply.width, height: reply.height });
        }
        /* Not gated on currentTupleIndex — the request is authoritative — but addressed at delivery, since a splice would otherwise file these pixels under a neighbour's name (docs/loading-architecture.md: reply-exactly-once). */
        const replySlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
        if (state.disposed) return;
        if (replySlot && replySlot.modalityIndex >= 0) {
          this.postImage(state, {
            type: 'image',
            tupleIndex: replySlot.tupleIndex,
            modalityIndex: asOriginal(replySlot.modalityIndex),
            bytes: reply.bytes,
            mime: reply.mime,
            width: reply.width,
            height: reply.height
          });
          return;
        }
        // The file left the view mid-load. The waiting slot still needs a terminal reply or it spins forever.
        this.postVacatedSlotError(state, tupleIndex, modalityIndex, 'Image not available');
        return;
      }
      if (state.disposed) return;
      const errSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (errSlot && errSlot.modalityIndex >= 0) {
        const msg: ExtensionMessage = {
          type: 'imageError',
          tupleIndex: errSlot.tupleIndex,
          modalityIndex: asOriginal(errSlot.modalityIndex),
          error: reply.error
        };
        state.panel.webview.postMessage(msg);
        return;
      }
      this.postVacatedSlotError(state, tupleIndex, modalityIndex, reply.error);
    };

    if (!imageFile) {
      // A missing slot answers immediately, never queued behind pool work.
      await serveImage(imageFile, io, deliver);
      return;
    }

    // Keyed by tuple, like a prefetch wave, so leaving cancels it (docs/loading-architecture.md: stale-tuple-loads-cancelled).
    const loadKey = this.imageLoadKey(state, tupleIndex);
    state.imageLoadKeys.add(loadKey);
    try {
      // One pool task spans read + convert + delivery — the old loadFullImage granularity (docs/loading-architecture.md: visible-never-starved).
      await this.pool.submit(() => serveImage(imageFile, io, deliver), { priority, key: loadKey });
    } catch (error) {
      // Reachable on ordinary navigation as well as dispose, and silent either way (docs/loading-architecture.md: stale-tuple-loads-cancelled).
      if (error instanceof TaskCancelled) return;
      if (state.disposed) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (errSlot && errSlot.modalityIndex >= 0) {
        const msg: ExtensionMessage = {
          type: 'imageError',
          tupleIndex: errSlot.tupleIndex,
          modalityIndex: asOriginal(errSlot.modalityIndex),
          error: message
        };
        state.panel.webview.postMessage(msg);
        return;
      }
      this.postVacatedSlotError(state, tupleIndex, modalityIndex, message);
    }
  }

  /**
   * Load `centerIndex ± prefetchCount` × the columns `scope` puts on or beside the screen, at
   * PREFETCH priority, superseding the previous wave (docs/loading-architecture.md, "Prefetch").
   */
  private async prefetchAround(state: PanelState, centerIndex: TupleIndex, scope: PrefetchScope): Promise<void> {
    if (state.disposed) return;

    // Supersede first, even if we bail below: stale neighbours would delay the new ones.
    this.pool.cancel(state.prefetchWaveKey);
    state.prefetchWaveKey = `${state.poolKey}-prefetch-${++state.prefetchWaveCounter}`;

    if (!state.visible) return; // hidden panels don't speculate

    const config = vscode.workspace.getConfiguration('imageCompare');
    const prefetchCount = config.get<number>('prefetchCount', 3);
    // Re-read once per wave, never per message (docs/loading-architecture.md: wire-budget-remote-only).
    state.transport.setLimit(resolveTransportBudgetBytes(config.get<number>('prefetchTransportBudgetMB'), vscode.env.remoteName));
    // Which slots, and in what order, is the pure plan's call alone (docs/loading-architecture.md: prefetch-visible-column-first).
    const plan = prefetchWavePlan({
      centerIndex,
      tupleCount: state.scanResult.tuples.length,
      prefetchCount,
      scope,
      isCached: (t, m) => state.loadedImages.has(`${t}-${m}`)
    });

    const waveKey = state.prefetchWaveKey;
    // Registered `open` before the loop: a slot with no image settles synchronously, and a wave that could roll up mid-issue would report nothing at all.
    if (debugEnabled()) state.prefetchWaves.set(waveKey, { center: centerIndex, issued: 0, done: 0, bytes: 0, startedAt: Date.now(), open: true });
    let issued = 0;
    for (const slot of plan) {
      issued++;
      void this.loadImageToCache(state, asTuple(slot.tupleIndex), slot.modalityIndex, waveKey);
    }

    const wave = state.prefetchWaves.get(waveKey);
    if (wave) {
      wave.issued = issued;
      wave.open = false;
      // Bytes are only knowable as the wave lands; the rollup in noteWaveSettled reports them (docs/testing.md).
      debug('[IC-PREFETCH]', () => `wave ${waveKey} center=${centerIndex} slots=${issued} pool ${this.pool.stats()}`);
      this.rollupWaveIfDone(state, waveKey);
    }

    this.evictDistantTuples(state, centerIndex, prefetchCount + 2);
  }

  /**
   * Load one slot into the cache at PREFETCH priority, pushing it to the webview only
   * if the tuple is still nearby and the panel visible.
   */
  private async loadImageToCache(
    state: PanelState,
    tupleIndex: TupleIndex,
    modalityIndex: number,
    waveKey: string
  ): Promise<void> {
    const cacheKey = `${tupleIndex}-${modalityIndex}`;
    if (state.loadedImages.has(cacheKey)) {
      this.noteWaveSettled(state, waveKey, 0);
      return;
    }

    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;

    if (!imageFile) {
      this.noteWaveSettled(state, waveKey, 0);
      return;
    }

    let loadedBytes = 0;
    try {
      // Keyed by wave, so navigating elsewhere cancels the whole wave.
      const { bytes, mime, width, height } = await this.pool.submit(
        () => this.thumbnailService.loadFullImage(imageFile.uri),
        { priority: Priority.PREFETCH, key: waveKey }
      );
      loadedBytes = bytes.byteLength;
      if (!this.slotMatchesUri(state, tupleIndex, modalityIndex, imageFile.uri)) return;
      state.loadedImages.set(cacheKey, { bytes, mime, width, height });

      // Only push if still nearby: multi-MB images for tuples the user has left delay the one they want.
      const config = vscode.workspace.getConfiguration('imageCompare');
      const prefetchCount = config.get<number>('prefetchCount', 3);
      const stillNearby = Math.abs(tupleIndex - state.currentTupleIndex) <= prefetchCount;
      if (!state.disposed && state.visible && stillNearby) {
        // Speculative: this push waits for the wire, the bytes stay cached meanwhile (docs/loading-architecture.md: speculation-yields-the-wire).
        this.postImage(state, { type: 'image', tupleIndex, modalityIndex: asOriginal(modalityIndex), bytes, mime, width, height }, true);
      }
    } catch {
      // Prefetch is best-effort (including TaskCancelled when a wave is superseded).
    } finally {
      // Exactly once per issued slot, whatever the exit — the wave rollup counts on it.
      this.noteWaveSettled(state, waveKey, loadedBytes);
    }
  }

  /** Debug-only: one prefetch slot settled (loaded, skipped or cancelled). */
  private noteWaveSettled(state: PanelState, waveKey: string, bytes: number): void {
    const wave = state.prefetchWaves.get(waveKey);
    if (!wave) return;
    wave.done++;
    wave.bytes += bytes;
    this.rollupWaveIfDone(state, waveKey);
  }

  /** Emit the wave's byte/latency rollup once issuing has finished and every issued slot has settled, then forget it. */
  private rollupWaveIfDone(state: PanelState, waveKey: string): void {
    const wave = state.prefetchWaves.get(waveKey);
    if (!wave || wave.open || wave.done < wave.issued) return;
    state.prefetchWaves.delete(waveKey);
    if (wave.issued === 0) return;
    debug('[IC-PREFETCH]', () => `wave ${waveKey} done ${Date.now() - wave.startedAt}ms slots=${wave.issued} loaded=${formatBytes(wave.bytes)} pool ${this.pool.stats()} ${this.formatWire(state)}`);
  }

  /**
   * Evict images that are too far from current position. Bytes only: these slots are live, so the
   * park and the hold stay (docs/loading-architecture.md: slot-invalidation-clears-the-wire).
   */
  private evictDistantTuples(state: PanelState, centerIndex: TupleIndex, maxDistance: number): void {
    const keysToDelete: string[] = [];

    for (const key of state.loadedImages.keys()) {
      const tupleIndex = parseInt(key.split('-')[0], 10);
      if (Math.abs(tupleIndex - centerIndex) > maxDistance) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      state.loadedImages.delete(key);
    }
  }

  /**
   * Send thumbnail message to webview
   */
  private sendThumbnailMessage(state: PanelState, tupleIndex: number, modalityIndex: number, bytes: Uint8Array, mime: string): void {
    if (state.disposed) return;
    // A pack hit is a slice of the whole packfile buffer, so skipping this ships the pack per thumbnail (docs/loading-architecture.md: image-payload-normalized).
    const tight = normalizeImageBytes(bytes);
    const msg: ExtensionMessage = { type: 'thumbnail', tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex), bytes: tight, mime };
    if (debugEnabled()) {
      state.wire.thumbnails++;
      state.wire.thumbBytes += tight.byteLength;
      debugVerbose('[IC-WIRE]', () => `thumbnail t=${tupleIndex} m=${modalityIndex} ${formatBytes(tight.byteLength)} ${mime} total=${formatBytes(state.wire.thumbBytes)}`);
    }
    state.panel.webview.postMessage(msg);
  }

  /**
   * Send thumbnail error message to webview
   */
  private sendThumbnailErrorMessage(state: PanelState, tupleIndex: number, modalityIndex: number, error: string): void {
    if (state.disposed) return;
    const msg: ExtensionMessage = { type: 'thumbnailError', tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex), error };
    state.panel.webview.postMessage(msg);
  }

  /**
   * Send progress message to webview
   */
  private sendProgressMessage(state: PanelState, current: number, total: number): void {
    if (state.disposed) return;
    const msg: ExtensionMessage = { type: 'thumbnailProgress', current, total };
    state.panel.webview.postMessage(msg);
  }

  /**
   * Get HTML content for the webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );

    const nonce = this.getNonce();

    return renderWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
    });
  }

  /**
   * Generate a nonce for Content Security Policy
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }



  /**
   * Set up the three overlapping detection mechanisms for a panel: one VS Code watcher per
   * watched dir, one fs.watch per leaf dir (plus mode 1's base dir), and the existence sweep. See docs/file-watching.md.
   */
  private setupFileWatcher(state: PanelState): void {
    if (state.watchedDirs.size === 0) return;

    const firstUri = state.scanResult.tuples[0]?.images[0]?.uri;
    if (!firstUri) return;
    const scheme = firstUri.scheme;

    // Leaf dirs = those directly containing images.
    const leafDirs = new Set<string>();
    for (const tuple of state.scanResult.tuples) {
      for (const img of tuple.images) {
        const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
        if (dir) leafDirs.add(dir);
      }
    }

    for (const dir of state.watchedDirs) {
      this.watchDirectory(state, dir, scheme, leafDirs.has(dir) || dir === state.baseUri?.path);
    }

    // Last resort for FUSE/network mounts, where neither watcher above fires at all.
    this.startDeletePolling(state);
  }

  /**
   * Session-file override (keyed by directory URI), else the default palette cycle. One resolver, so
   * a column added after open is coloured the same way the initial payload colours the rest.
   */
  private resolveModalityColor(state: PanelState, modality: string, index: number): string {
    const dirUri = state.modalityDirs.get(modality);
    const override = dirUri && state.colorsByUri?.get(dirUri.toString());
    return override || MODALITY_COLORS[index % MODALITY_COLORS.length];
  }

  /**
   * The path shown in a modality pill's tooltip and used by its context-menu copy/reveal. Every
   * mode resolves to a real
   * filesystem path: the modality directory in mode 2, `base/<name>` in mode 1, and otherwise the
   * first file carrying that modality — a file list has no directory of its own to name
   * (docs/session-files.md: modality-path-always-real).
   */
  private resolveModalityPath(state: PanelState, modality: string): string {
    const dirUri = state.modalityDirs.get(modality);
    if (dirUri) return dirUri.fsPath;
    if (state.baseUri) return vscode.Uri.joinPath(state.baseUri, modality).fsPath;
    for (const tuple of state.scanResult.tuples) {
      const img = tuple.images.find(i => i.modality === modality);
      // Mode 3 columns are files; modes 1 and 2 are directories even when the scan yields one row.
      if (img) return state.scanResult.mode === 3 ? img.uri.fsPath : path.dirname(img.uri.fsPath);
    }
    return modality;
  }

  /**
   * Mode 1 only: adopts a directory created under the base dir as a new modality. The base glob is
   * non-recursive, so the images written inside it are never reported — the directory create is the
   * only signal (docs/file-watching.md: new-modality-dir-adopted). The watcher is armed before the
   * entries are dispatched, and the listing is retaken afterwards so nothing written in between is lost.
   */
  private async adoptNewModalityDir(state: PanelState, dirUri: vscode.Uri, name: string): Promise<void> {
    if (state.disposed || !state.baseUri) return;
    // Qualification (not a column yet, never a dot dir) is the shared planner's; all three detectors converge here (docs/file-watching.md: new-modality-dir-adopted).
    if (newModalityDirCandidates([{ name, isDirectory: true }], state.scanResult.modalities).length === 0) return;
    // Single-flight: three detectors race for one directory (docs/file-watching.md: new-modality-dir-adopted).
    if (state.adoptingDirs.has(dirUri.path)) return;

    const scheme = state.scanResult.tuples[0]?.images[0]?.uri.scheme;
    if (!scheme) return;

    state.adoptingDirs.add(dirUri.path);
    try {
      let entries: [string, vscode.FileType][];
      try {
        const stat = await vscode.workspace.fs.stat(dirUri);
        if (state.disposed) return;
        if (!(stat.type & vscode.FileType.Directory)) return; // bitmask: a symlinked dir adopts too (docs/tuple-matching.md: entry-type-is-a-bitmask)
        /* Skip-or-list and the budget tick are the shared planner's decision (docs/file-watching.md: barren-dirs-memoized). */
        if (planSweepDirs([{ dir: dirUri.path, mtime: stat.mtime }], state.barrenDirs, BARREN_RECHECK_SWEEPS).length === 0) {
          return;
        }
        entries = await vscode.workspace.fs.readDirectory(dirUri);
        if (state.disposed) return;

        // Imageful-or-barren is the shared planner's decision (docs/file-watching.md: new-modality-dir-adopted); type test is a bitmask (docs/tuple-matching.md: entry-type-is-a-bitmask).
        const hasImages = adoptableImages(entries.map(([n, t]) => ({ name: n, isFile: (t & vscode.FileType.File) !== 0 }))).length > 0;
        recordDirListing(state.barrenDirs, dirUri.path, stat.mtime, hasImages);
        if (!hasImages) return;

        // `.path`, like every other producer of this set (docs/file-watching.md: watched-dirs-are-uri-paths).
        if (!state.watchedDirs.has(dirUri.path)) {
          state.watchedDirs.add(dirUri.path);
          this.watchDirectory(state, dirUri.path, scheme, true);
        }
        // Retaken after the watcher is armed: a file written during the first listing is in this one.
        entries = await vscode.workspace.fs.readDirectory(dirUri);
      } catch {
        return;
      }
      if (state.disposed || state.scanResult.modalities.includes(name)) return;

      // Bitmask: a symlinked image in an adopted dir is an image (docs/tuple-matching.md: entry-type-is-a-bitmask).
      const images = adoptableImages(entries.map(([n, t]) => ({ name: n, isFile: (t & vscode.FileType.File) !== 0 })));
      this.debugMsg(state, `adopted new modality dir: ${dirUri.path} (${images.length} images)`);
      for (const entryName of images) {
        if (state.disposed) return;
        // Un-awaited by necessity: inside a POLL task, awaiting pooled work deadlocks at cap 1 (docs/file-watching.md: duplicate-reports-idempotent).
        this.handleFileCreated(state, vscode.Uri.joinPath(dirUri, entryName));
      }
    } finally {
      state.adoptingDirs.delete(dirUri.path);
    }
  }

  /**
   * Releases the watchers for a modality's directory. A directory that comes back is re-adopted and
   * re-watched; keeping the old handle would leave it bound to the dead inode and silently deaf
   * (docs/file-watching.md: watchers-released-with-modality).
   */
  private unwatchModalityDir(state: PanelState, modality: string): void {
    // Mode 2 has no adoption path to re-watch a directory that comes back, so keep watching it.
    if (!state.baseUri) return;
    const dirUri = state.modalityDirs.get(modality)
      ?? (state.baseUri ? vscode.Uri.joinPath(state.baseUri, modality) : undefined);
    if (!dirUri) return;

    // Keyed in URI space like watchedDirs, so the two agree on every platform (docs/file-watching.md: watched-dirs-are-uri-paths).
    const dir = dirUri.path;
    const rec = state.watchersByDir.get(dir);
    if (!rec) return;

    try { rec.fsw.dispose(); } catch { /* already disposed */ }
    if (rec.node) { try { rec.node.close(); } catch { /* already closed */ } }
    state.fileWatchers = state.fileWatchers.filter(w => w !== rec.fsw);
    state.nodeWatchers = state.nodeWatchers.filter(w => w !== rec.node);
    state.watchersByDir.delete(dir);
    state.watchedDirs.delete(dir);
    this.debugMsg(state, `released watchers for ${dir}`);
  }

  /**
   * Creates the watchers for one directory: the VS Code watcher every watched dir gets, plus the
   * fs.watch delete backup that only local leaf dirs need. Called for each dir at open and again
   * when a modality directory appears later, so an entry in `watchedDirs` always has a live watcher
   * behind it (docs/file-watching.md: watched-dirs-have-watchers).
   */
  private watchDirectory(state: PanelState, dir: string, scheme: string, isLeaf: boolean): void {
    if (state.disposed) return;
    // Non-recursive: each leaf has its own watcher, so '**/*' would double-report (docs/file-watching.md).
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(dir).with({ scheme }),
      '*'
    );

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidDelete(uri => {
      try { this.handleFileDeleted(state, uri); } catch (e: any) { this.debugMsg(state, `handleFileDeleted ERROR: ${e?.message ?? e}`); }
    });
    watcher.onDidCreate(uri => {
      this.debugMsg(state, `onDidCreate: ${uri.path}`);
      try { this.handleFileCreated(state, uri); } catch (e: any) { this.debugMsg(state, `handleFileCreated ERROR: ${e?.message ?? e}`); }
    });
    watcher.onDidChange(uri => {
      try { this.handleFileChanged(state, uri); } catch (e: any) { this.debugMsg(state, `handleFileChanged ERROR: ${e?.message ?? e}`); }
    });

    state.fileWatchers.push(watcher);
    state.watchersByDir.set(dir, { fsw: watcher });

    // Backs up VS Code's onDidDelete, which doesn't fire on some platform/filesystem combos.
    if (!isLeaf || scheme !== 'file') return;
    // node's fs takes filesystem paths; `dir` is a URI path, and on Windows the two differ (docs/file-watching.md: watched-dirs-are-uri-paths).
    const fsDir = vscode.Uri.file(dir).fsPath;
    try {
      const fsWatcher = fs.watch(fsDir, (eventType, filename) => {
        this.debugMsg(state, `fs.watch event: ${eventType} ${filename} in ${dir}`);
        if (eventType === 'rename' && filename) {
          const filePath = path.join(fsDir, filename);
          // 'rename' = appeared or vanished; probed async (a sync stat blocks the extension host) and through the link (docs/file-watching.md: existence-probes-follow-the-link).
          setTimeout(() => {
            if (state.disposed) return;
            fs.promises.stat(filePath).then(
              () => {
                if (state.disposed) return;
                // On mounts where the VS Code watcher is silent, this is the only create signal (docs/file-watching.md: new-modality-dir-adopted).
                if (state.baseUri && dir === state.baseUri.path) {
                  void this.adoptNewModalityDir(state, vscode.Uri.file(`${dir}/${filename}`), filename);
                }
              },
              () => {
                if (state.disposed) return;
                // Built from `dir`, never from `filePath`: fsPath lowercases the drive letter, so the round trip would name a URI no tracked image equals (docs/file-watching.md: watched-dirs-are-uri-paths).
                const fileUri = vscode.Uri.file(`${dir}/${filename}`);
                this.debugMsg(state, `fs.watch delete: ${filePath}`);
                this.handleFileDeleted(state, fileUri);
              }
            );
          }, 50);
        }
      });
      fsWatcher.on('error', (err) => {
        this.debugMsg(state, `fs.watch error on ${dir}: ${err.message}`);
      });
      this.debugMsg(state, `fs.watch setup OK: ${dir}`);
      state.nodeWatchers.push(fsWatcher);
      const rec = state.watchersByDir.get(dir);
      if (rec) rec.node = fsWatcher;
    } catch {
      // fs.watch unavailable (remote FS, permission error) — VS Code watcher only
    }
  }

  /**
   * Start polling for file deletions. Checks all known image URIs periodically.
   */
  /**
   * Mode 1: finds a modality directory added while the comparison is open. Neither watcher reports a
   * directory create on a network or FUSE mount, so the sweep is the only detector that always works
   * (docs/file-watching.md: new-modality-dir-adopted).
   */
  private async sweepForNewModalityDirs(state: PanelState): Promise<void> {
    if (state.disposed || !state.baseUri) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(state.baseUri);
    } catch {
      return;
    }
    // A pipeline that creates and removes scratch dirs would otherwise grow the memo forever.
    pruneBarrenMemos(state.barrenDirs, new Set(entries.map(([name]) => vscode.Uri.joinPath(state.baseUri!, name).path)));

    // Which children qualify is the shared planner's decision (docs/file-watching.md: new-modality-dir-adopted); type test is a bitmask (docs/tuple-matching.md: entry-type-is-a-bitmask).
    const candidates = newModalityDirCandidates(
      entries.map(([name, type]) => ({ name, isDirectory: (type & vscode.FileType.Directory) !== 0 })),
      state.scanResult.modalities
    );
    for (const name of candidates) {
      if (state.disposed) return;
      await this.adoptNewModalityDir(state, vscode.Uri.joinPath(state.baseUri, name), name);
    }
  }

  private startDeletePolling(state: PanelState): void {
    if (state.deleteCheckTimer) return; // already running

    const firstUri = state.scanResult.tuples[0]?.images[0]?.uri;
    if (!firstUri || firstUri.scheme !== 'file') return; // only poll local files

    state.deleteCheckTimer = setInterval(() => {
      void this.runDeleteSweep(state);
    }, DELETE_POLL_INTERVAL_MS);
  }

  /**
   * One existence sweep over the tracked files: async, POLL priority, non-overlapping,
   * skipped while hidden (docs/loading-architecture.md, "Filesystem watching").
   */
  private async runDeleteSweep(state: PanelState): Promise<void> {
    if (state.disposed || !state.visible || state.deleteSweepRunning) return;
    state.deleteSweepRunning = true;
    if (debugEnabled()) {
      // An idle window polls forever; only a busy or changed pool earns a line (docs/loading-architecture.md: idle-poll-logs-nothing-new).
      const snapshot = this.pool.stats();
      if (shouldLogPoolSnapshot(snapshot, this.pool.running > 0 || this.pool.pending > 0, state.lastPoolSnapshot)) {
        state.lastPoolSnapshot = snapshot;
        this.debugMsg(state, `pool ${snapshot}`);
      }
    }
    try {
      // Snapshot (watcher events may mutate the arrays while we await), keyed by leaf dir then name: one listing yields both the arrivals silent watchers never report and this cycle's deletion candidates (docs/file-watching.md: sweep-derives-deletions-from-listings).
      const knownByDir = new Map<string, Map<string, vscode.Uri>>();
      for (const dir of state.watchedDirs) {
        if (dir !== state.baseUri?.path) knownByDir.set(dir, new Map());
      }
      // A tracked file under no listed dir keeps its own check — nothing else would ever look at it.
      const strays: vscode.Uri[] = [];
      for (const tuple of state.scanResult.tuples) {
        for (const img of tuple.images) {
          // Both sides in URI space, so the lookup hits on Windows too (docs/file-watching.md: watched-dirs-are-uri-paths).
          const cut = img.uri.path.lastIndexOf('/');
          const known = knownByDir.get(img.uri.path.substring(0, cut));
          if (known) known.set(img.uri.path.substring(cut + 1), img.uri);
          else strays.push(img.uri);
        }
      }

      // Cheap and first: one readdir, so its latency is the interval, not the whole existence pass.
      await this.pool
        .submit(() => this.sweepForNewModalityDirs(state), { priority: Priority.POLL, key: state.poolKey })
        .catch(() => undefined);
      if (state.disposed) return;

      // One listing per watched leaf dir: on mounts with silent watchers this is the only detector of new files — a copy finishing after adoption's second listing lands here (docs/file-watching.md: new-modality-dir-adopted).
      const dirChecks = [...knownByDir].map(([dir, known]) =>
        this.pool
          .submit(async (): Promise<vscode.Uri[]> => {
            if (state.disposed) return [];
            let entries: [string, vscode.FileType][] | undefined;
            try {
              entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
            } catch {
              entries = undefined; // dir gone or unreadable: this dir's tracked files fall back to their own checks
            }
            // Both directions from the one listing via the shared planner — arrivals, and the deletion candidates re-verified below (docs/file-watching.md: sweep-derives-deletions-from-listings, poll-diff-names-first); type test is a bitmask (docs/tuple-matching.md: entry-type-is-a-bitmask).
            const plan = planDirSweep(
              [...known.keys()],
              entries?.filter(([n]) => isImageFile(n)).map(([n, t]) => ({ name: n, isFile: (t & vscode.FileType.File) !== 0 }))
            );
            for (const name of plan.added) {
              if (state.disposed) return [];
              this.debugMsg(state, `sweep new file: ${dir}/${name}`);
              this.handleFileCreated(state, vscode.Uri.file(`${dir}/${name}`));
            }
            // The tracked URI, never one rebuilt from the name: the slot's identity is that object's string form.
            return plan.candidates.map(name => known.get(name)).filter((u): u is vscode.Uri => u !== undefined);
          }, { priority: Priority.POLL, key: state.poolKey })
          .catch((): vscode.Uri[] => []) // cancelled/errored: nothing to re-verify this cycle
      );

      // Sequenced, not nested: a listing task awaiting its own sub-tasks could starve them in a bounded pool.
      const candidates = (await Promise.all(dirChecks)).flat();
      if (state.disposed) return;

      const checks = [...candidates, ...strays].map(uri =>
        this.pool
          .submit(async () => {
            try {
              // Async, never statSync: a sync sweep blocks the host for seconds (docs/loading-architecture.md: no-sync-blocking); `stat`, never `access` (docs/file-watching.md: existence-probes-follow-the-link).
              await fs.promises.stat(uri.fsPath);
              return;
            } catch {
              // True only at this instant: re-verify before reporting (docs/file-watching.md: sweep-reverifies-before-report).
            }
            if (state.disposed) return;
            try {
              await fs.promises.stat(uri.fsPath); // the same probe, for the same reason (docs/file-watching.md: existence-probes-follow-the-link)
              return; // came back — it was a rewrite, not a delete
            } catch {
              // still gone
            }
            if (state.disposed) return;
            this.debugMsg(state, `poll delete detected: ${uri.fsPath}`);
            this.handleFileDeleted(state, uri);
          }, { priority: Priority.POLL, key: state.poolKey })
          .catch(() => undefined) // cancelled/errored: treat as present
      );

      await Promise.all(checks);
    } finally {
      state.deleteSweepRunning = false;
    }
  }

  /**
   * Drop pending deletes older than 2s — longer than the 500ms commit timer, so a slow
   * create can still be matched, but not indefinitely.
   */
  private cleanupRecentlyDeleted(state: PanelState): void {
    const now = Date.now();
    state.recentlyDeleted = state.recentlyDeleted.filter(d => now - d.timestamp < 2000);
  }

  /**
   * Defer a deletion behind a 500ms window so a following create can claim it as a rename
   * or an in-place overwrite (docs/file-watching.md, "Rename detection").
   */
  private handleFileDeleted(state: PanelState, uri: vscode.Uri): void {
    if (state.disposed) return;
    const uriStr = uri.toString();

    // One state change per delete, however many mechanisms report it (docs/file-watching.md: duplicate-reports-idempotent).
    if (state.recentlyDeleted.some(d => d.uri.toString() === uriStr)) return;

    // A whole modality directory, recognised before the per-file search below.
    const deletedPath = uri.path;
    const modalityIndex = state.scanResult.modalities.findIndex(modality => {
      if (state.baseUri) {
        const modalityPath = vscode.Uri.joinPath(state.baseUri, modality).path;
        if (deletedPath === modalityPath) return true;
      }
      const modalityUri = state.modalityDirs.get(modality);
      if (modalityUri && deletedPath === modalityUri.path) return true;
      return false;
    });

    if (modalityIndex >= 0) {
      this.removeModality(state, modalityIndex);
      return;
    }

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (let modIdx = 0; modIdx < tuple.images.length; modIdx++) {
        if (tuple.images[modIdx].uri.toString() === uriStr) {
          // Global index, never the sparse array position (docs/file-watching.md: modality-index-is-global).
          const modalityName = tuple.images[modIdx].modality;
          const globalModIdx = state.scanResult.modalities.indexOf(modalityName);

          // Capture the tuple *object*: a create elsewhere can splice one in ahead of it.
          const capturedTuple = tuple;
          this.cleanupRecentlyDeleted(state);
          state.recentlyDeleted.push({
            uri,
            tupleIndex: asTuple(tupleIndex),
            modalityIndex: globalModIdx,
            timestamp: Date.now()
          });

          this.invalidateSlot(state, tupleIndex, globalModIdx);

          setTimeout(() => {
            if (state.disposed) return;
            // Re-resolve: the index may have shifted since the timer was armed.
            const currentTupleIndex = asTuple(state.scanResult.tuples.indexOf(capturedTuple));
            if (currentTupleIndex < 0) return; // tuple already removed

            // Re-resolve the column too: add/removeModality shifts recentlyDeleted but not this closure.
            const currentModIdx = state.scanResult.modalities.indexOf(modalityName);
            if (currentModIdx < 0) return; // modality already removed, which took the image with it

            // Still pending means no create claimed it — commit the delete.
            const stillDeleted = state.recentlyDeleted.some(
              d => d.tupleIndex === currentTupleIndex && d.modalityIndex === currentModIdx
            );

            if (stillDeleted) {
              state.recentlyDeleted = state.recentlyDeleted.filter(
                d => !(d.tupleIndex === currentTupleIndex && d.modalityIndex === currentModIdx)
              );

              // Strip, winner clear, empty-tuple vs fileDeleted, then the column-empty check — the shared commit (docs/file-watching.md: delete-message-order).
              commitSlotRemoval(state.scanResult, state.winners, currentTupleIndex, currentModIdx, {
                post: msg => state.panel.webview.postMessage(msg),
                // A load that resolved inside the window re-populated this slot; clear it or it is served as a ghost.
                onSlotRemoved: (t, m) => this.invalidateSlot(state, t, m),
                removeTuple: idx => this.removeTuple(state, idx),
                removeModality: idx => this.removeModality(state, idx),
                saveResults: () => {
                  if (state.votingEnabled) {
                    this.saveResults(state);
                  }
                }
              });
            }
          }, 500); // rename window

          return;
        }
      }
    }
  }

  /**
   * Remove a tuple. Splice, winner shift and the canon post order (tupleDeleted, refresh, re-save)
   * are the shared removal step (docs/file-watching.md: delete-message-order); the provider-only
   * caches re-key in the hook, in the same operation as the splice.
   */
  private removeTuple(state: PanelState, tupleIndex: TupleIndex): void {
    if (state.disposed) return;
    removeTupleStep(state.scanResult, state.winners, state.currentTupleIndex, tupleIndex, {
      post: msg => state.panel.webview.postMessage(msg),
      // Provider-only index-keyed caches shift with the splice (docs/file-watching.md: reindex-in-lockstep).
      onTupleRemoved: removed => {
        const newLoadedImages = new Map<string, LoadedImage>();
        for (const [key, value] of state.loadedImages) {
          const [tIdx, mIdx] = key.split('-').map(Number);
          if (tIdx > removed) {
            newLoadedImages.set(`${tIdx - 1}-${mIdx}`, value);
          } else if (tIdx < removed) {
            newLoadedImages.set(key, value);
          }
          // tIdx === removed: discard (tuple removed)
        }
        state.loadedImages = newLoadedImages;
        this.reindexPendingImagePosts(state, t => shiftIndexAfterRemoval(t, removed));
        state.recentlyDeleted = state.recentlyDeleted.flatMap(d => {
          const shifted = shiftIndexAfterRemoval(d.tupleIndex, removed);
          return shifted === null ? [] : [{ ...d, tupleIndex: asTuple(shifted) }];
        });
      },
      // A structural mutation must not strand the current view (docs/file-watching.md: mutation-never-strands-view).
      refreshCurrentTuple: current => {
        state.currentTupleIndex = asTuple(current);
        this.refreshCurrentTupleImages(state);
      },
      saveResults: () => {
        if (state.votingEnabled) void this.saveResults(state);
      }
    });
  }

  /**
   * Re-send the current tuple's images (cached ones serve immediately). Call after any
   * mutation that shifts indices under an in-flight load.
   */
  private refreshCurrentTupleImages(state: PanelState): void {
    if (state.disposed) return;
    const tupleIndex = state.currentTupleIndex;
    refreshTupleImages(state.scanResult.tuples[tupleIndex], state.scanResult.modalities, m => {
      void this.sendImage(state, tupleIndex, m);
    });
  }

  /**
   * Remove a modality column. Splice, strip, winner shift and the modalityRemoved + re-save order
   * are the shared removal step (docs/file-watching.md: delete-message-order); provider-only
   * structures re-index in the hook, alongside the splice (docs/file-watching.md: reindex-in-lockstep).
   */
  private removeModality(state: PanelState, modalityIndex: number): void {
    removeModalityStep(state.scanResult, state.winners, modalityIndex, {
      post: msg => state.panel.webview.postMessage(msg),
      onModalityRemoved: (modality, removed) => {
        this.unwatchModalityDir(state, modality);
        // Cleared wholesale: every key past the removed column is wrong, and the column is gone.
        state.loadedImages.clear();
        this.dropPendingImagePosts(state);
        state.recentlyDeleted = state.recentlyDeleted.flatMap(d => {
          const shifted = shiftIndexAfterRemoval(d.modalityIndex, removed);
          return shifted === null ? [] : [{ ...d, modalityIndex: shifted }];
        });
      },
      saveResults: () => {
        if (state.votingEnabled) void this.saveResults(state);
      }
    });
  }

  /**
   * Claim a create as an exact-URI restore, then as a rename, else place it as a new file
   * (docs/file-watching.md, "Claiming a pending delete").
   */
  private handleFileCreated(state: PanelState, uri: vscode.Uri): void {
    if (state.disposed) return;
    const filename = uri.path.split('/').pop() || '';
    if (!isImageFile(filename)) {
      // A mode-1 modality arrives as a directory create, and this is the only event we get for it (docs/file-watching.md: new-modality-dir-adopted).
      const parent = uri.path.substring(0, uri.path.lastIndexOf('/'));
      if (state.baseUri && parent === state.baseUri.path) {
        void this.adoptNewModalityDir(state, uri, filename);
      }
      return;
    }

    this.cleanupRecentlyDeleted(state);

    // Exact URI: a restore or an in-place overwrite.
    const restoredSlot = this.findExistingSlotByUri(state, uri);
    if (restoredSlot && restoredSlot.modalityIndex >= 0) {
      const { tupleIndex } = restoredSlot;
      const modalityIndex = asOriginal(restoredSlot.modalityIndex);

      // Disarm the 500ms timer or it deletes the file that just came back (docs/file-watching.md: no-armed-delete-after-return).
      state.recentlyDeleted = state.recentlyDeleted.filter(d => d.uri.toString() !== uri.toString());

      this.invalidateSlot(state, tupleIndex, modalityIndex);

      this.regenerateThumbnail(state, tupleIndex, modalityIndex);

      const msg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex,
        modalityIndex
      };
      state.panel.webview.postMessage(msg);

      if (tupleIndex === state.currentTupleIndex) {
        this.sendImage(state, tupleIndex, modalityIndex);
      }

      return;
    }

    // Unknown URI: it may be the new name of a pending delete.
    const deletedMatch = this.findMatchingDeletedFile(state, uri);

    if (deletedMatch) {
      // Update in place, keeping the tuple's index, cache key and winner intact.
      const { tupleIndex } = deletedMatch;
      const modalityIndex = asOriginal(deletedMatch.modalityIndex);
      const tuple = state.scanResult.tuples[tupleIndex];
      const modality = state.scanResult.modalities[modalityIndex];
      const img = tuple.images.find(i => i.modality === modality);
      if (img) {
        img.uri = uri;
        img.name = filename;
      }

      // Disarm the 500ms timer or it deletes the file that just came back (docs/file-watching.md: no-armed-delete-after-return).
      state.recentlyDeleted = state.recentlyDeleted.filter(
        d => !(d.tupleIndex === tupleIndex && d.modalityIndex === modalityIndex)
      );

      this.invalidateSlot(state, tupleIndex, modalityIndex);

      this.regenerateThumbnail(state, tupleIndex, modalityIndex);

      // Restore, not add: the file is available again under a new name.
      const msg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex,
        modalityIndex
      };
      state.panel.webview.postMessage(msg);

      if (tupleIndex === state.currentTupleIndex) {
        this.sendImage(state, tupleIndex, modalityIndex);
      }

      return;
    }

    void this.handleNewFile(state, uri, filename).catch(e => this.debugMsg(state, `handleNewFile ERROR: ${e?.message ?? e}`));
  }

  /**
   * Find an existing slot in tuples that matches this URI exactly
   */
  private findExistingSlotByUri(state: PanelState, uri: vscode.Uri): { tupleIndex: TupleIndex; modalityIndex: number } | undefined {
    if (state.disposed) return undefined;
    const uriStr = uri.toString();

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (const img of tuple.images) {
        if (img.uri.toString() === uriStr) {
          // Global index, not the sparse array position (docs/tuple-matching.md: wire-index-is-original).
          const globalModIdx = state.scanResult.modalities.indexOf(img.modality);
          return { tupleIndex: asTuple(tupleIndex), modalityIndex: globalModIdx };
        }
      }
    }

    return undefined;
  }

  /**
   * The pending delete `newUri` renames from, or undefined when the answer is not
   * unambiguous — matchDeletedFile never guesses (docs/file-watching.md: rename-never-guessed).
   */
  private findMatchingDeletedFile(state: PanelState, newUri: vscode.Uri): DeletedFileInfo | undefined {
    const dirOf = (u: vscode.Uri) => u.path.substring(0, u.path.lastIndexOf('/'));
    const filenameOf = (u: vscode.Uri) => u.path.split('/').pop() || '';
    const entries = state.recentlyDeleted.map(d => ({ dir: dirOf(d.uri), filename: filenameOf(d.uri) }));
    const idx = matchDeletedFile(entries, dirOf(newUri), filenameOf(newUri), state.scanResult.isMultiTupleMode);
    return idx >= 0 ? state.recentlyDeleted[idx] : undefined;
  }

  /**
   * Place a genuinely new file into an existing tuple or a new one. Modes 1 and 2 only —
   * a mode-3 comparison is an explicit file list with no structure to extend.
   */
  private async handleNewFile(state: PanelState, uri: vscode.Uri, filename: string): Promise<void> {
    if (state.scanResult.mode === 3) {
      return;
    }

    const filePath = uri.path;
    let modalityName: string | undefined;

    // Mode 1: the modality is the first subdirectory below the base.
    if (state.baseUri) {
      const basePath = state.baseUri.path;

      if (!filePath.startsWith(basePath)) {
        return;
      }

      const relativePath = filePath.substring(basePath.length + 1);
      const parts = relativePath.split('/');

      if (parts.length < 2) {
        return; // directly in the base dir, so not in a modality subdirectory
      }

      modalityName = parts[0];
    }
    // Mode 2: the modality is whichever selected directory contains the file.
    else if (state.modalityDirs.size > 0) {
      for (const [modality, dirUri] of state.modalityDirs.entries()) {
        if (filePath.startsWith(dirUri.path + '/')) {
          modalityName = modality;
          break;
        }
      }
      
      if (!modalityName) {
        return;
      }
    }
    else {
      return;
    }

    let modalityIndex = asOriginal(state.scanResult.modalities.indexOf(modalityName!));

    if (modalityIndex === -1) {
      modalityIndex = asOriginal(await this.addNewModality(state, modalityName));
      if (modalityIndex === -1) {
        return;
      }
      // A concurrent create may have taken this slot while we awaited (docs/file-watching.md: duplicate-reports-idempotent).
      if (state.disposed || this.findExistingSlotByUri(state, uri)) {
        return;
      }
    }

    // Placement — slot-fill vs new tuple, insert position, wire payload — comes from the shared arrival planner (docs/file-watching.md, "Watcher-added files").
    const plan = planArrival(state.scanResult.tuples, state.scanResult.modalities, { name: filename, modality: modalityName });
    if (!plan) return;
    const applied = applyArrival(state.scanResult, state.winners, state.currentTupleIndex, plan, { uri, name: filename, modality: modalityName });

    if (plan.kind === 'slot-fill') {
      this.regenerateThumbnail(state, plan.tupleIndex, plan.modalityIndex);
      // imageInfo fills a slot the webview did not know about; each later post-crop file posts this after the first file's tupleAdded (docs/crop-and-pptx.md: post-crop-message-order).
      state.panel.webview.postMessage(applied.message);
      return;
    }

    // Provider-only index-keyed structures shift up in lockstep with the planner's splice (docs/file-watching.md: reindex-in-lockstep).
    const insertIndex = plan.insertIndex;
    const newLoadedImages = new Map<string, LoadedImage>();
    for (const [key, value] of state.loadedImages) {
      const [tIdx, mIdx] = key.split('-').map(Number);
      if (tIdx >= insertIndex) {
        newLoadedImages.set(`${tIdx + 1}-${mIdx}`, value);
      } else {
        newLoadedImages.set(key, value);
      }
    }
    state.loadedImages = newLoadedImages;
    this.reindexPendingImagePosts(state, t => (t >= insertIndex ? t + 1 : t));

    for (const d of state.recentlyDeleted) {
      if (d.tupleIndex >= insertIndex) {
        d.tupleIndex++;
      }
    }

    state.currentTupleIndex = asTuple(applied.currentTupleIndex);

    // The first post-crop create lands here: its sparse tupleAdded opens the canon sequence (docs/crop-and-pptx.md: post-crop-message-order).
    state.panel.webview.postMessage(applied.message);

    this.regenerateThumbnail(state, insertIndex, plan.modalityIndex);
  }

  /**
   * Insert a new modality column: at the caller's position in mode 2, alphabetically in mode 1
   * (best-effort — see the caveat in docs/file-watching.md). Returns its index, or -1 on failure.
   */
  private async addNewModality(state: PanelState, modalityName: string): Promise<number> {
    // A mode-2 re-add keeps the caller's slot from modalityDirs key order (docs/tuple-matching.md: modality-order-is-callers); mode 1 has no caller order.
    const callerOrder = state.modalityDirs.size > 0 ? Array.from(state.modalityDirs.keys()) : undefined;
    // Insert position, winner shift, tuple re-sort and the modalityAdded payload are the shared planner's (docs/file-watching.md: new-modality-dir-adopted).
    const { insertIndex, message } = applyModalityInsert(state.scanResult, state.winners, modalityName, callerOrder, {
      modalityPath: name => this.resolveModalityPath(state, name),
      colorOverride: (mod, i) => this.resolveModalityColor(state, mod, i),
    });

    // Insertion invalidates every key: "0-2" no longer names the same modality (docs/file-watching.md: reindex-in-lockstep).
    state.loadedImages.clear();
    this.dropPendingImagePosts(state);

    state.recentlyDeleted = state.recentlyDeleted.map(d =>
      d.modalityIndex >= insertIndex ? { ...d, modalityIndex: d.modalityIndex + 1 } : d
    );

    if (state.baseUri && !state.disposed) {
      const newDir = vscode.Uri.joinPath(state.baseUri, modalityName).path; // `.path`: same space as the rest of the set (docs/file-watching.md: watched-dirs-are-uri-paths)
      const scheme = state.scanResult.tuples[0]?.images[0]?.uri.scheme;
      // Setup runs once at open, so a dir discovered later must be watched here or never (docs/file-watching.md: watched-dirs-have-watchers).
      if (scheme && !state.watchedDirs.has(newDir)) {
        state.watchedDirs.add(newDir);
        this.watchDirectory(state, newDir, scheme, true);
      }
    }

    state.panel.webview.postMessage(message);

    // Winner indices may have shifted.
    if (state.votingEnabled && state.winners.size > 0) {
      await this.saveResults(state);
    }

    return insertIndex;
  }

  /**
   * Reload the image and thumbnail for a changed file.
   */
  private handleFileChanged(state: PanelState, uri: vscode.Uri): void {
    if (state.disposed) return;
    const uriStr = uri.toString();

    // Resolve the global modality index; everything downstream keys by it.
    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      const img = tuple.images.find(i => i.uri.toString() === uriStr);
      if (img) {
        const modalityIndex = asOriginal(state.scanResult.modalities.indexOf(img.modality));
        if (modalityIndex < 0) return;
        this.invalidateSlot(state, tupleIndex, modalityIndex);
        this.regenerateThumbnail(state, tupleIndex, modalityIndex);
        if (tupleIndex === state.currentTupleIndex) {
          this.sendImage(state, asTuple(tupleIndex), modalityIndex);
        }
        return;
      }
    }
  }

  /**
   * Log to the "ImageCompare" output channel and mirror to the webview's console when
   * `imageCompare.debug` is on, queueing (bounded) if the webview has not signalled 'ready' yet.
   */
  private debugMsg(state: PanelState, msg: string): void {
    if (!debugEnabled()) return;
    debug('[IC-EXT]', () => msg);
    if (state.webviewReady) {
      state.panel.webview.postMessage({ type: '_debug', msg });
    } else {
      // Bounded: a slow remote open queued thousands, then replayed them into the renderer console at 'ready' (docs/testing.md).
      if (state.pendingDebugMessages.length >= PENDING_DEBUG_MAX) state.pendingDebugMessages.shift();
      state.pendingDebugMessages.push(msg);
    }
  }

  /**
   * Rebuild one slot's thumbnail after its file changed.
   * @param modalityIndex global index into scanResult.modalities
   */
  private async regenerateThumbnail(state: PanelState, tupleIndex: number, modalityIndex: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);

    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;
    if (!imageFile) return;

    try {
      const bytes = await this.pool.submit(
        () => this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2),
        { priority: Priority.THUMBNAIL, key: state.poolKey }
      );
      const okSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (!okSlot || okSlot.modalityIndex < 0) return;
      this.sendThumbnailMessage(state, okSlot.tupleIndex, okSlot.modalityIndex, bytes, THUMBNAIL_MIME);
    } catch (error) {
      if (error instanceof TaskCancelled || state.disposed) return;
      const slot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (!slot || slot.modalityIndex < 0) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendThumbnailErrorMessage(state, slot.tupleIndex, slot.modalityIndex, message);
    }
  }

  /** Awaited by `deactivate` before dispose, so a dirty thumbnail pack lands while the cache still holds it (docs/image-backends.md: thumb-pack-survives-close). */
  async flush(): Promise<void> {
    await this.thumbnailService.flush();
  }

  dispose(): void {
    // Each panel's onDidDispose does its own cleanup and removes itself from the set.
    for (const state of [...this.panels]) {
      state.panel.dispose();
    }
    this.panels.clear();
    this.thumbnailService.dispose();
    this.thumbnailService.clearMemoryCache();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

}
