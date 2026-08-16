import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { scanForImages, readResultsFile, writeResultsFile, mapWinnersToIndices, disambiguateDirectoryNames, RESULTS_FILENAME } from './fileService';
import { applyLabels, parseSessionFile, serializeSessionFile } from './sessionFile';
import { normalizeImageBytes } from './wireFormat';
import { matchDeletedFile, modalityInsertIndex, shiftIndexAfterRemoval, tupleInsertIndex } from './watcherLogic';
import { nextPanelKey, Priority, sharedWorkPool, TaskCancelled, WorkPool } from './workPool';
import { ThumbnailService } from './thumbnailService';
import { renderWebviewHtml } from './webviewShell';
import { parsePpmx } from './ppmxParser';
import {
  ScanResult,
  TupleInfo,
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
/** Re-list a known-barren directory this often, so a mount with a frozen directory mtime still gets picked up. */
const BARREN_RECHECK_SWEEPS = 6;

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
  poolKey: string; // work-pool cancellation key scoping this panel's tasks
  prefetchWaveKey: string; // key of the current prefetch wave (cancelled when superseded)
  prefetchWaveCounter: number;
  webviewReady: boolean;
  pendingDebugMessages: string[];
  lastTupleSwitchAt: number; // last setCurrentTuple arrival; recent = the user is scrubbing
  heldImagePosts: Map<string, Extract<ExtensionMessage, { type: 'image' }>>; // off-screen payloads parked during a scrub burst
  burstFlushTimer?: ReturnType<typeof setTimeout>;
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
    // Close during the scan would leak watchers/timers: the real onDidDispose is only attached after it.
    let closedDuringScan = false;
    const earlyDispose = panel.onDidDispose(() => { closedDuringScan = true; });
    try {
      const scanResult = await scanForImages(uris, labels);

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

      // Watched dirs: base (mode 1), each modality dir (mode 2), plus every leaf dir holding images.
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
        prefetchWaveCounter: 0
      };

      this.setupFileWatcher(panelState);
      this.panels.add(panelState);

      // Per-panel, not the provider-wide `disposables` array: those would accumulate across open/close.
      const panelSubscriptions: vscode.Disposable[] = [earlyDispose];

      // Listener must be attached BEFORE setting HTML, which starts the webview's 'ready' post.
      panelSubscriptions.push(panel.webview.onDidReceiveMessage(
        (message: WebViewMessage) => this.handlePanelMessage(panelState, message)
      ));

      // Only the prefetch wave may be dropped on hide (docs/loading-architecture.md: hidden-keeps-work).
      panelSubscriptions.push(panel.onDidChangeViewState(() => {
        panelState.visible = panel.visible;
        if (!panel.visible) {
          this.pool.cancel(panelState.prefetchWaveKey);
        }
      }));

      // Triggers the webview JS to run and post 'ready'.
      panel.webview.html = this.getHtmlContent(panel.webview);

      panel.onDidDispose(() => {
        panelState.disposed = true;
        // Both keys: pool.cancel matches exactly (docs/loading-architecture.md, "Lifecycle").
        this.pool.cancel(panelState.poolKey);
        this.pool.cancel(panelState.prefetchWaveKey);
        panelState.loadedImages.clear();
        panelState.heldImagePosts.clear();
        if (panelState.burstFlushTimer) clearTimeout(panelState.burstFlushTimer);
        panelState.fileWatchers.forEach(w => w.dispose());
        panelState.nodeWatchers.forEach(w => w.close());
        if (panelState.deleteCheckTimer) clearInterval(panelState.deleteCheckTimer);
        panelSubscriptions.forEach(d => d.dispose());
        this.panels.delete(panelState);
      });
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
   * Handle messages from the webview (panel-specific)
   */
  private async handlePanelMessage(state: PanelState, message: WebViewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
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
          message.sibling ? Priority.SIBLING : Priority.VISIBLE,
          message.forceReload
        );
        break;

      case 'setCurrentTuple':
        state.currentTupleIndex = message.tupleIndex;
        state.lastTupleSwitchAt = Date.now();
        // The user landed here: anything held for this tuple is delivered now, ahead of the burst flush.
        for (const [key, held] of state.heldImagePosts) {
          if (held.tupleIndex === message.tupleIndex) {
            state.heldImagePosts.delete(key);
            state.panel.webview.postMessage(held);
          }
        }
        break;

      case 'tupleFullyLoaded':
        if (message.tupleIndex === state.currentTupleIndex) {
          await this.prefetchAround(state, message.tupleIndex);
        }
        break;

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
    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) return;

    for (const img of tuple.images) {
      try {
        await vscode.workspace.fs.delete(img.uri);
      } catch {
        // File may already be gone
      }
    }

    // Remove eagerly rather than waiting on a watcher event, which may be up to a sweep away (docs/file-watching.md: self-writes-never-wait).
    /* Names, not indices: each checkModalityEmpty below splices the array an index would point into. */
    const modalityNames = tuple.images.map(img => img.modality);
    // The awaits above may have shifted rows; splice by identity, not the index we were called with.
    const liveIndex = state.scanResult.tuples.indexOf(tuple);
    if (liveIndex < 0) return;
    this.removeTuple(state, asTuple(liveIndex));
    for (const name of modalityNames) {
      const idx = state.scanResult.modalities.indexOf(name);
      if (idx >= 0) this.checkModalityEmpty(state, idx);
    }
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
    try {
      const saveUri = await this.suggestPptxUri(state);
      if (!saveUri) {
        throw new Error('Cannot determine output directory');
      }

      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.title = 'ImageCompare Export';

      const slideWidth = 10; // inches (default for 16:9)
      const slideHeight = 5.625; // inches (default for 16:9)

      const barH = 0.35; // inches — height of the caption bar

      const addCaption = (slide: PptxGenJS.Slide, tupleName: string, modality: string, isWinner: boolean) => {
        slide.addShape('rect', {
          x: 0, y: 0, w: slideWidth, h: barH,
          fill: { color: 'D0D0D0', transparency: 50 },
        });

        slide.addText(tupleName, {
          x: 0.1, y: 0, w: slideWidth / 2, h: barH,
          fontSize: 10,
          fontFace: 'Arial',
          bold: true,
          color: '000000',
          valign: 'middle',
          align: 'left',
        });

        const modLabel = isWinner ? `✓ ${modality}` : modality;
        slide.addText(modLabel, {
          x: slideWidth / 2, y: 0, w: slideWidth / 2 - 0.1, h: barH,
          fontSize: 10,
          fontFace: 'Arial',
          bold: true,
          color: isWinner ? '008800' : '000000',
          valign: 'middle',
          align: 'right',
        });
      };

      const loadImageBase64 = (uri: vscode.Uri): Promise<{ data: string; width: number; height: number } | null> => {
        // cancel() drains the queue once; a sequential producer must stop submitting itself.
        if (state.disposed) throw new TaskCancelled();
        return this.pool.submit(() => loadImageBase64Unpooled(uri), { priority: Priority.EXPORT, key: state.poolKey });
      };

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
              .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
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

      // `_crop\d+` here must keep matching the writer's format (docs/crop-and-pptx.md: cropnn-writer-reader-match).
      const findCropTuples = (baseTupleName: string): number[] => {
        const cropPattern = new RegExp(`^${baseTupleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_crop\\d+$`);
        const cropIndices: number[] = [];
        for (let i = 0; i < state.scanResult.tuples.length; i++) {
          if (cropPattern.test(state.scanResult.tuples[i].name)) {
            cropIndices.push(i);
          }
        }
        return cropIndices;
      };

      const findParentTuple = (cropName: string): number => {
        const match = cropName.match(/^(.+)_crop\d+$/);
        if (!match) return -1;
        return state.scanResult.tuples.findIndex(t => t.name === match[1]);
      };

      // Ordering and constants are tuned, not derived (docs/crop-and-pptx.md).
      const computeCropLayout = (cropAspect: number, fullAspect: number) => {
        const gap = 0.15;
        const defaultThumbW = 2;
        const minThumbW = 1.2;

        let mainW: number, mainH: number;
        if (cropAspect > slideWidth / slideHeight) {
          mainW = slideWidth; mainH = slideWidth / cropAspect;
        } else {
          mainH = slideHeight; mainW = slideHeight * cropAspect;
        }
        let mainX = (slideWidth - mainW) / 2;
        let mainY = (slideHeight - mainH) / 2;
        const origArea = mainW * mainH;

        let thumbW = defaultThumbW;
        let thumbH = thumbW / fullAspect;
        let thumbX = slideWidth - thumbW;
        let thumbY = slideHeight - thumbH;

        if (mainX + mainW > thumbX - gap && mainY + mainH > thumbY - gap) {
          const tryFit = (tw: number) => {
            const th = tw / fullAspect;
            const tx = slideWidth - tw;
            const avail = tx - gap;
            let w: number, h: number;
            if (cropAspect > avail / slideHeight) {
              w = avail; h = avail / cropAspect;
            } else {
              h = slideHeight; w = slideHeight * cropAspect;
            }
            return {
              mainW: w, mainH: h, mainX: (avail - w) / 2, mainY: slideHeight - h,
              thumbW: tw, thumbH: th, thumbX: tx, thumbY: slideHeight - th
            };
          };

          let fit = tryFit(defaultThumbW);
          if (fit.mainW * fit.mainH < origArea * 0.7) {
            fit = tryFit(minThumbW);
          }
          if (fit.mainW * fit.mainH >= origArea * 0.5) {
            return fit;
          }
        }

        return { mainW, mainH, mainX, mainY, thumbW, thumbH, thumbX, thumbY };
      };

      // Crop image, plus a full-image callout thumbnail with the region marked in red.
      const addCropSlide = async (
        cropTupleIdx: number,
        fullTupleIdx: number,
        modality: string,
        tupleName: string,
        isWinner: boolean
      ) => {
        const cropTuple = state.scanResult.tuples[cropTupleIdx];
        const cropImg = cropTuple.images.find(i => i.modality === modality);
        if (!cropImg) return;
        const cropImgData = await loadImageBase64(cropImg.uri);
        if (!cropImgData) return;

        const fullTuple = state.scanResult.tuples[fullTupleIdx];
        const fullImg = fullTuple.images.find(i => i.modality === modality);
        if (!fullImg) return;
        const fullImgData = await loadImageBase64(fullImg.uri);
        if (!fullImgData) return;

        const cropAspect = cropImgData.width / cropImgData.height;
        const fullAspect = fullImgData.width / fullImgData.height;
        const layout = computeCropLayout(cropAspect, fullAspect);

        const slide = pptx.addSlide();
        slide.addImage({ data: cropImgData.data, x: layout.mainX, y: layout.mainY, w: layout.mainW, h: layout.mainH });
        slide.addImage({ data: fullImgData.data, x: layout.thumbX, y: layout.thumbY, w: layout.thumbW, h: layout.thumbH });

        // The red rect comes from metadata, never re-derived (docs/crop-and-pptx.md: callout-from-metadata).
        if (state.disposed) throw new TaskCancelled();
        const cropMeta = await this.pool.submit(() => this.thumbnailService.readCropMetadata(cropImg.uri), { priority: Priority.EXPORT, key: state.poolKey });
        // A zero srcW/srcH would put Infinity into the slide XML, which corrupts the whole deck.
        if (cropMeta && cropMeta.srcW > 0 && cropMeta.srcH > 0) {
          const scaleX = layout.thumbW / cropMeta.srcW;
          const scaleY = layout.thumbH / cropMeta.srcH;
          slide.addShape('rect', {
            x: layout.thumbX + cropMeta.x * scaleX,
            y: layout.thumbY + cropMeta.y * scaleY,
            w: cropMeta.w * scaleX,
            h: cropMeta.h * scaleY,
            line: { color: 'FF0000', width: 2 },
            fill: { type: 'none' }
          });
        }

        addCaption(slide, tupleName, modality, isWinner);
      };

      // Parent/crop pairing: a voted crop never ships without its parent (docs/crop-and-pptx.md: one-slide-per-region).
      for (let idx = 0; idx < tupleIndices.length; idx++) {
        if (state.disposed) return;
        const tupleIndex = tupleIndices[idx];
        const winnerIdx = winnerModalityIndices[idx];
        const tuple = state.scanResult.tuples[tupleIndex];
        if (!tuple) continue;

        // A voted crop is rendered against its parent even if the parent was never voted.
        const parentIdx = findParentTuple(tuple.name);
        if (parentIdx >= 0) {
          for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
            const originalModIdx = modalityOrder[displayIdx];
            const modality = state.scanResult.modalities[originalModIdx];
            if (!modality) continue;
            await addCropSlide(tupleIndex, parentIdx, modality, tuple.name, winnerIdx === originalModIdx);
          }
          continue;
        }

        const cropTupleIndices = findCropTuples(tuple.name);
        const hasCrops = cropTupleIndices.length > 0;
        // A voted crop child already gets its own slide, so the parent falls back to a plain one.
        const hasVotedCrops = hasCrops && cropTupleIndices.some(ci => tupleIndices.includes(asTuple(ci)));

        for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
          const originalModIdx = modalityOrder[displayIdx];
          const modality = state.scanResult.modalities[originalModIdx];
          if (!modality) continue;
          const isWinner = winnerIdx === originalModIdx;

          if (!hasCrops || hasVotedCrops) {
            const img = tuple.images.find(i => i.modality === modality);
            if (!img) continue;
            const imgData = await loadImageBase64(img.uri);
            if (!imgData) continue;

            const slide = pptx.addSlide();
            const imgAspect = imgData.width / imgData.height;
            const slideAspect = slideWidth / slideHeight;
            let imgW: number, imgH: number, imgX: number, imgY: number;
            if (imgAspect > slideAspect) {
              imgW = slideWidth;
              imgH = slideWidth / imgAspect;
              imgX = 0;
              imgY = (slideHeight - imgH) / 2;
            } else {
              imgH = slideHeight;
              imgW = slideHeight * imgAspect;
              imgX = (slideWidth - imgW) / 2;
              imgY = 0;
            }
            slide.addImage({ data: imgData.data, x: imgX, y: imgY, w: imgW, h: imgH });
            addCaption(slide, tuple.name, modality, isWinner);
          } else if (cropTupleIndices.length === 1) {
            // Only parent voted, exactly one crop — present as if the crop was voted.
            await addCropSlide(cropTupleIndices[0], tupleIndex, modality, state.scanResult.tuples[cropTupleIndices[0]].name, isWinner);
          } else {
            // Several crops, none voted: resolve the ambiguity by breadth, one slide each.
            for (const cropTupleIdx of cropTupleIndices) {
              await addCropSlide(cropTupleIdx, tupleIndex, modality, state.scanResult.tuples[cropTupleIdx].name, isWinner);
            }
          }
        }
      }

      // One buffer, one write: a streamed write racing the completion notification is how a half-flushed deck gets opened.
      const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
      if (state.disposed) return;
      await vscode.workspace.fs.writeFile(saveUri, buffer);

      if (state.disposed) return;
      // Exactly one complete/error per request on a live panel (docs/crop-and-pptx.md: export-always-answers).
      state.panel.webview.postMessage({ type: 'pptxComplete', path: saveUri.fsPath });
      const choice = await vscode.window.showInformationMessage(`PPTX exported: ${saveUri.fsPath}`, 'Reveal in Explorer');
      if (choice) void vscode.commands.executeCommand('revealInExplorer', saveUri);
    } catch (err) {
      // A closed panel is not a failure: every other pooled await filters this the same way.
      if (err instanceof TaskCancelled || state.disposed) return;
      const errorMsg = err instanceof Error ? err.message : String(err);
      state.panel.webview.postMessage({ type: 'pptxError', error: errorMsg });
      vscode.window.showErrorMessage(`PPTX export failed: ${errorMsg}`);
    }
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
    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) return;

    // Tuple name, not source filename, so the watcher regroups (docs/crop-and-pptx.md: shared-crop-filename).
    const tupleName = tuple.name;

    /* Max across every modality dir: a cancelled crop leaves them out of step, and the lower number would overwrite (docs/crop-and-pptx.md: shared-crop-filename). */
    if (tuple.images.length === 0) return;
    const cropNums = await Promise.all(
      tuple.images.map(img => this.getNextCropNumber(vscode.Uri.joinPath(img.uri, '..'), tupleName))
    );
    // Resolved once, outside the per-modality loop, or one crop splits into N tuples (docs/crop-and-pptx.md: shared-crop-filename).
    const cropNum = Math.max(...cropNums);
    // Zero-padded `_cropNN`: every `_crop\d+` reader depends on this format (docs/crop-and-pptx.md: cropnn-writer-reader-match).
    const cropSuffix = `_crop${String(cropNum).padStart(2, '0')}`;
    const outputName = `${tupleName}${cropSuffix}.png`;

    // Relative (0-1) is the only form that may cross modalities (docs/crop-and-pptx.md: relative-coords-only).
    const relRect = {
      x: cropRect.x / srcWidth,
      y: cropRect.y / srcHeight,
      w: cropRect.w / srcWidth,
      h: cropRect.h / srcHeight
    };

    let savedCount = 0;
    let cancelled = 0;
    const savedPaths: string[] = [];
    const savedUris: vscode.Uri[] = [];

    const cropOne = async (imageFile: ImageFile) => {
      const dirUri = vscode.Uri.joinPath(imageFile.uri, '..');
      const outputUri = vscode.Uri.joinPath(dirUri, outputName);

      // True dimensions are re-read from disk per modality; the webview's are only a denominator (docs/crop-and-pptx.md: srcdims-are-denominator).
      const meta = await this.thumbnailService.getImageDimensions(imageFile.uri);
      const scaledRect = {
        x: Math.max(0, Math.round(relRect.x * meta.width)),
        y: Math.max(0, Math.round(relRect.y * meta.height)),
        w: Math.round(relRect.w * meta.width),
        h: Math.round(relRect.h * meta.height)
      };
      scaledRect.w = Math.min(scaledRect.w, meta.width - scaledRect.x);
      scaledRect.h = Math.min(scaledRect.h, meta.height - scaledRect.y);
      // NaN fails every comparison, so it would slip past a plain <= 0 test into sharp.extract.
      if (!(scaledRect.w > 0) || !(scaledRect.h > 0)) return; // scaled to nothing: skip, not an error

      const croppedBuffer = await this.thumbnailService.cropImage(imageFile.uri, scaledRect, meta.width, meta.height);
      await vscode.workspace.fs.writeFile(outputUri, croppedBuffer);
      savedCount++;
      savedPaths.push(outputUri.path);
      savedUris.push(outputUri);
    };

    // Pooled per modality: a wide tuple would otherwise fan out full-res decodes without bound (docs/loading-architecture.md: visible-never-starved).
    await Promise.all(tuple.images.map(async (imageFile) => {
      try {
        await this.pool.submit(() => cropOne(imageFile), { priority: Priority.EXPORT, key: state.poolKey });
      } catch (err: any) {
        if (err instanceof TaskCancelled) { cancelled++; return; }
        console.error(`[ImageCompare] Failed to crop ${imageFile.name}:`, err?.message ?? err);
      }
    }));

    // A cancelled crop is a closed panel, not a failure to report.
    if (state.disposed || cancelled > 0) return;
    if (savedCount > 0) {
      // Place the crops now — a self-write never waits on its own event (docs/file-watching.md: self-writes-never-wait).
      for (const uri of savedUris) this.handleFileCreated(state, uri);
      state.panel.webview.postMessage({
        type: 'cropComplete',
        tupleIndex,
        count: savedCount,
        paths: savedPaths
      } as ExtensionMessage);
    } else {
      state.panel.webview.postMessage({
        type: 'cropError',
        tupleIndex,
        error: 'Failed to crop any images'
      } as ExtensionMessage);
    }
  }

  /** Export output target: comparison_NN.pptx (max existing + 1) in the base dir or the first modality's parent. */
  private async suggestPptxUri(state: PanelState): Promise<vscode.Uri | undefined> {
    const baseDir = state.baseUri?.fsPath ||
      (state.modalityDirs.size > 0 ? Array.from(state.modalityDirs.values())[0].fsPath : undefined);
    if (!baseDir) return undefined;
    const parentDir = state.baseUri ? baseDir : path.dirname(baseDir);
    // Scan-and-increment, unlocked — same pattern (and same race) as crop numbering.
    let pptxNum = 1;
    try {
      const existingFiles = await fs.promises.readdir(parentDir);
      const pptxPattern = /^comparison_(\d+)\.pptx$/;
      for (const f of existingFiles) {
        const match = f.match(pptxPattern);
        if (match) pptxNum = Math.max(pptxNum, parseInt(match[1], 10) + 1);
      }
    } catch {
      // unreadable dir: the dialog still opens there with the default name
    }
    return vscode.Uri.file(path.join(parentDir, `comparison_${String(pptxNum).padStart(2, '0')}.pptx`));
  }

  /**
   * Scan a directory for existing _cropNN files and return the next number.
   */
  private async getNextCropNumber(dirUri: vscode.Uri, basename: string): Promise<number> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cropPattern = new RegExp(`^${escaped}_crop(\\d+)\\.`);
      let maxNum = 0;
      for (const [name] of entries) {
        const match = name.match(cropPattern);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      }
      return maxNum + 1;
    } catch {
      return 1;
    }
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

    // Delete rather than leave an empty stub.
    if (state.winners.size === 0) {
      try {
        await vscode.workspace.fs.delete(resultsUri);
      } catch {
        // File doesn't exist or can't be deleted - that's OK
      }
      return;
    }

    // Stays tuple-index-keyed; writeResultsFile converts to the durable tuple name (fileService.ts).
    const winnersWithNames = new Map<number, string>();
    for (const [tupleIndex, modalityIndex] of state.winners) {
      const modality = state.scanResult.modalities[modalityIndex];
      if (modality) {
        winnersWithNames.set(tupleIndex, modality);
      }
    }

    try {
      await writeResultsFile(
        baseUri,
        state.scanResult.tuples,
        winnersWithNames,
        state.scanResult.modalities,
        filename
      );
    } catch (error) {
      // Non-fatal: the results file is optional.
      console.error('Failed to save results.txt:', error);
    }
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

    const tuples: TupleInfo[] = state.scanResult.tuples.map((tuple, tupleIndex) => ({
      name: tuple.name,
      // Dense for the webview: a modality the sparse tuple lacks becomes a `name: ''` placeholder (docs/tuple-matching.md: sparse-vs-dense-tuples).
      images: allModalities.map((modality, modalityIndex) => {
        const img = this.findImageForModality(tuple, modality);
        return {
          name: img?.name || '',
          modality,
          tupleIndex: asTuple(tupleIndex),
          modalityIndex: asOriginal(modalityIndex)
        };
      })
    }));

    // Convert winners Map to Record for JSON serialization
    const winnersRecord: Record<number, OriginalModalityIndex> = {};
    for (const [tupleIndex, modalityIndex] of state.winners) {
      winnersRecord[tupleIndex] = modalityIndex;
    }

    const modalityPaths: string[] = allModalities.map(mod => this.resolveModalityPath(state, mod));

    const modalityColors: string[] = allModalities.map((mod, i) => this.resolveModalityColor(state, mod, i));

    const initMessage: ExtensionMessage = {
      type: 'init',
      tuples,
      modalities: allModalities,
      modalityPaths,
      modalityColors,
      config: { thumbnailSize, prefetchCount, keepZoomOnTupleChange },
      winners: winnersRecord,
      votingEnabled: state.votingEnabled,
      labelsExplicit: state.labelsExplicit
    };

    state.panel.webview.postMessage(initMessage);
    this.generateAllThumbnails(state);
  }

  /**
   * One-shot open-time sweep of every slot. Not visibility-gated and not cancellable:
   * nothing re-enqueues, so skipping it leaves blank thumbnails for the session
   * (docs/loading-architecture.md, "Thumbnails").
   */
  private generateAllThumbnails(state: PanelState): void {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const allModalities = state.scanResult.modalities;

    const items: Array<{ uri: vscode.Uri; tupleIndex: number; modalityIndex: number; modality: string }> = [];
    const missingSlots: Array<{ tupleIndex: number; modalityIndex: number }> = [];

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      
      for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
        const modality = allModalities[modalityIndex];
        const imageFile = this.findImageForModality(tuple, modality);
        
        if (imageFile) {
          items.push({
            uri: imageFile.uri,
            modality,
            tupleIndex,
            modalityIndex
          });
        } else {
          missingSlots.push({ tupleIndex, modalityIndex });
        }
      }
    }

    for (const { tupleIndex, modalityIndex } of missingSlots) {
      this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, 'Image not available');
    }

    // With nothing to enqueue no per-item `.finally` fires, so post the terminal tick here or the bar hangs.
    if (items.length === 0) {
      if (!state.disposed) this.sendProgressMessage(state, missingSlots.length, missingSlots.length);
      return;
    }

    // Scanline order + FIFO-within-priority fills top-to-bottom (docs/loading-architecture.md: thumbnails-scanline-order).
    let done = 0;
    const total = items.length;
    for (const item of items) {
      const { tupleIndex, modalityIndex, modality, uri } = item;
      void this.pool
        .submit(() => this.thumbnailService.getThumbnail(uri, thumbnailSize * 2), {
          // Ranks below on-demand THUMBNAIL so scrolling can't queue behind the sweep.
          priority: Priority.THUMBNAIL_BULK,
          key: state.poolKey
        })
        .then(
          dataUrl => {
            const slot = this.resolveSlotForUri(state, tupleIndex, modality, uri);
            if (slot && slot.modalityIndex >= 0) {
              this.sendThumbnailMessage(state, slot.tupleIndex, slot.modalityIndex, dataUrl);
            }
          },
          error => {
            if (error instanceof TaskCancelled || state.disposed) return;
            const slot = this.resolveSlotForUri(state, tupleIndex, modality, uri);
            if (!slot || slot.modalityIndex < 0) return;
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.sendThumbnailErrorMessage(state, slot.tupleIndex, slot.modalityIndex, message);
          }
        )
        .finally(() => {
          if (state.disposed) return;
          done++;
          this.sendProgressMessage(state, done + missingSlots.length, total + missingSlots.length);
        });
    }
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
          const dataUrl = await this.pool.submit(
            () => this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2),
            { priority: Priority.THUMBNAIL, key: state.poolKey }
          );
          const okSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
          if (!okSlot || okSlot.modalityIndex < 0) continue;
          this.sendThumbnailMessage(state, okSlot.tupleIndex, okSlot.modalityIndex, dataUrl);
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
  private postImage(state: PanelState, msg: Extract<ExtensionMessage, { type: 'image' }>): void {
    const tight = normalizeImageBytes(msg.bytes);
    if (tight !== msg.bytes) msg = { ...msg, bytes: tight };
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
    state.panel.webview.postMessage(msg);
  }

  /** Re-arms while the scrub continues, then drains ONE payload per tick so each owns a quiet frame; dispose and the cap eviction in postImage are the only discards (docs/loading-architecture.md: held-payloads-always-flush). */
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
      state.panel.webview.postMessage(first.value[1]);
      if (state.heldImagePosts.size > 0) this.scheduleBurstFlush(state, 32);
    }, delayMs);
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
      state.loadedImages.delete(cacheKey);
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

    // Range-guarded: an out-of-range index would throw before the try below, replying nothing.
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;

    if (!imageFile) {
      if (state.disposed) return;
      const msg: ExtensionMessage = {
        type: 'imageError',
        tupleIndex,
        modalityIndex,
        error: 'Image not available'
      };
      state.panel.webview.postMessage(msg);
      return;
    }

    try {
      const { bytes, mime, width, height } = await this.pool.submit(
        () => this.thumbnailService.loadFullImage(imageFile.uri),
        { priority, key: state.poolKey }
      );
      // Guards the cache write only — never the reply below.
      if (this.slotMatchesUri(state, tupleIndex, modalityIndex, imageFile.uri)) {
        state.loadedImages.set(cacheKey, { bytes, mime, width, height });
      }

      /* Not gated on currentTupleIndex — the request is authoritative — but addressed at delivery, since a splice would otherwise file these pixels under a neighbour's name (docs/loading-architecture.md: reply-exactly-once). */
      const replySlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (state.disposed) return;
      if (replySlot && replySlot.modalityIndex >= 0) {
        this.postImage(state, {
          type: 'image',
          tupleIndex: replySlot.tupleIndex,
          modalityIndex: asOriginal(replySlot.modalityIndex),
          bytes,
          mime,
          width,
          height
        });
        return;
      }
      // The file left the view mid-load. The waiting slot still needs a terminal reply or it spins forever.
      this.postVacatedSlotError(state, tupleIndex, modalityIndex, 'Image not available');
    } catch (error) {
      // Only reachable on dispose: hide never cancels image work (docs/loading-architecture.md: hidden-keeps-work).
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
   * Load `centerIndex ± prefetchCount` × all modalities at PREFETCH priority, superseding
   * the previous wave (docs/loading-architecture.md, "Prefetch").
   */
  private async prefetchAround(state: PanelState, centerIndex: TupleIndex): Promise<void> {
    if (state.disposed) return;

    // Supersede first, even if we bail below: stale neighbours would delay the new ones.
    this.pool.cancel(state.prefetchWaveKey);
    state.prefetchWaveKey = `${state.poolKey}-prefetch-${++state.prefetchWaveCounter}`;

    if (!state.visible) return; // hidden panels don't speculate

    const config = vscode.workspace.getConfiguration('imageCompare');
    const prefetchCount = config.get<number>('prefetchCount', 3);
    const allModalities = state.scanResult.modalities;

    for (let offset = 0; offset <= prefetchCount; offset++) {
      const indices = offset === 0 ? [centerIndex] : [asTuple(centerIndex + offset), asTuple(centerIndex - offset)];

      for (const tupleIndex of indices) {
        if (tupleIndex >= 0 && tupleIndex < state.scanResult.tuples.length) {
          for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
            const cacheKey = `${tupleIndex}-${modalityIndex}`;
            if (!state.loadedImages.has(cacheKey)) {
              void this.loadImageToCache(state, tupleIndex, modalityIndex, state.prefetchWaveKey);
            }
          }
        }
      }
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
    if (state.loadedImages.has(cacheKey)) return;

    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = tuple && modality ? this.findImageForModality(tuple, modality) : undefined;

    if (!imageFile) return;

    try {
      // Keyed by wave, so navigating elsewhere cancels the whole wave.
      const { bytes, mime, width, height } = await this.pool.submit(
        () => this.thumbnailService.loadFullImage(imageFile.uri),
        { priority: Priority.PREFETCH, key: waveKey }
      );
      if (!this.slotMatchesUri(state, tupleIndex, modalityIndex, imageFile.uri)) return;
      state.loadedImages.set(cacheKey, { bytes, mime, width, height });

      // Only push if still nearby: multi-MB images for tuples the user has left delay the one they want.
      const config = vscode.workspace.getConfiguration('imageCompare');
      const prefetchCount = config.get<number>('prefetchCount', 3);
      const stillNearby = Math.abs(tupleIndex - state.currentTupleIndex) <= prefetchCount;
      if (!state.disposed && state.visible && stillNearby) {
        this.postImage(state, { type: 'image', tupleIndex, modalityIndex: asOriginal(modalityIndex), bytes, mime, width, height });
      }
    } catch {
      // Prefetch is best-effort (including TaskCancelled when a wave is superseded).
    }
  }

  /**
   * Evict images that are too far from current position
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
  private sendThumbnailMessage(state: PanelState, tupleIndex: number, modalityIndex: number, dataUrl: string): void {
    if (state.disposed) return;
    const msg: ExtensionMessage = { type: 'thumbnail', tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex), dataUrl };
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
    if (state.scanResult.modalities.includes(name)) return;
    // A dot dir is never a modality; all three detectors converge here, so the guard belongs here.
    if (name.startsWith('.')) return;
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
        if (!(stat.type & vscode.FileType.Directory)) return;
        /* Skips re-listing a huge image-less sibling, but never permanently — some mounts pin directory mtime (docs/file-watching.md: barren-dirs-memoized). */
        const memo = state.barrenDirs.get(dirUri.path);
        if (memo && memo.mtime === stat.mtime && memo.sweeps < BARREN_RECHECK_SWEEPS) {
          memo.sweeps++;
          return;
        }
        entries = await vscode.workspace.fs.readDirectory(dirUri);
        if (state.disposed) return;

        const hasImages = entries.some(([n, t]) => (t & vscode.FileType.File) && isImageFile(n));
        if (!hasImages) {
          state.barrenDirs.set(dirUri.path, { mtime: stat.mtime, sweeps: 0 });
          return;
        }
        state.barrenDirs.delete(dirUri.path);

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

      const images = entries.filter(([n, t]) => (t & vscode.FileType.File) && isImageFile(n));
      this.debugMsg(state, `adopted new modality dir: ${dirUri.path} (${images.length} images)`);
      for (const [entryName] of images) {
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
    try {
      const fsWatcher = fs.watch(dir, (eventType, filename) => {
        this.debugMsg(state, `fs.watch event: ${eventType} ${filename} in ${dir}`);
        if (eventType === 'rename' && filename) {
          const filePath = path.join(dir, filename);
          // 'rename' = appeared or vanished; probe async, a sync stat blocks the extension host.
          setTimeout(() => {
            if (state.disposed) return;
            fs.promises.access(filePath).then(
              () => {
                if (state.disposed) return;
                // On mounts where the VS Code watcher is silent, this is the only create signal (docs/file-watching.md: new-modality-dir-adopted).
                if (state.baseUri && dir === state.baseUri.path) {
                  void this.adoptNewModalityDir(state, vscode.Uri.file(filePath), filename);
                }
              },
              () => {
                if (state.disposed) return;
                const fileUri = vscode.Uri.file(filePath);
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
    const live = new Set(entries.map(([name]) => vscode.Uri.joinPath(state.baseUri!, name).path));
    for (const path of state.barrenDirs.keys()) {
      if (!live.has(path)) state.barrenDirs.delete(path);
    }

    for (const [name, type] of entries) {
      if (state.disposed) return;
      if (!(type & vscode.FileType.Directory)) continue;
      if (state.scanResult.modalities.includes(name)) continue;
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
    this.debugMsg(state, `pool ${this.pool.stats()}`);
    try {
      // Snapshot: watcher events may mutate the arrays while we await.
      const uris: vscode.Uri[] = [];
      // Known files per leaf dir, so the listing pass below can spot arrivals the silent watchers never report.
      const knownByDir = new Map<string, Set<string>>();
      for (const dir of state.watchedDirs) {
        if (dir !== state.baseUri?.path) knownByDir.set(dir, new Set());
      }
      for (const tuple of state.scanResult.tuples) {
        for (const img of tuple.images) {
          uris.push(img.uri);
          const cut = img.uri.path.lastIndexOf('/');
          knownByDir.get(img.uri.path.substring(0, cut))?.add(img.uri.path.substring(cut + 1));
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
          .submit(async () => {
            if (state.disposed) return;
            let entries: [string, vscode.FileType][];
            try {
              entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
            } catch {
              return; // dir gone or unreadable: the per-file checks below report the deletions
            }
            for (const [name, type] of entries) {
              if (state.disposed) return;
              if (!(type & vscode.FileType.File)) continue;
              if (known.has(name) || !isImageFile(name)) continue;
              this.debugMsg(state, `sweep new file: ${dir}/${name}`);
              this.handleFileCreated(state, vscode.Uri.file(`${dir}/${name}`));
            }
          }, { priority: Priority.POLL, key: state.poolKey })
          .catch(() => undefined)
      );

      const checks = uris.map(uri =>
        this.pool
          .submit(async () => {
            try {
              // Async, never accessSync: a sync sweep blocks the host for seconds (docs/loading-architecture.md: no-sync-blocking).
              await fs.promises.access(uri.fsPath);
              return;
            } catch {
              // True only at this instant: re-verify before reporting (docs/file-watching.md: sweep-reverifies-before-report).
            }
            if (state.disposed) return;
            try {
              await fs.promises.access(uri.fsPath);
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

      await Promise.all([...dirChecks, ...checks]);
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

          const cacheKey = `${tupleIndex}-${globalModIdx}`;
          state.loadedImages.delete(cacheKey);

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

              capturedTuple.images = capturedTuple.images.filter(img => img.modality !== modalityName);
        // A load that resolved inside the window re-populated this key; clear it or it is served as a ghost.
        const committedIdx = state.scanResult.tuples.indexOf(capturedTuple);
        const committedMod = state.scanResult.modalities.indexOf(modalityName);
        if (committedIdx >= 0 && committedMod >= 0) state.loadedImages.delete(`${committedIdx}-${committedMod}`);

              if (state.winners.get(currentTupleIndex) === currentModIdx) {
                state.winners.delete(currentTupleIndex);
                state.panel.webview.postMessage({
                  type: 'winnerUpdated',
                  tupleIndex: currentTupleIndex,
                  modalityIndex: null
                } as ExtensionMessage);
              }

              if (capturedTuple.images.length === 0) {
                this.removeTuple(state, currentTupleIndex);
              } else {
                const msg: ExtensionMessage = {
                  type: 'fileDeleted',
                  tupleIndex: currentTupleIndex,
                  modalityIndex: asOriginal(currentModIdx)
                };
                state.panel.webview.postMessage(msg);

                if (state.votingEnabled) {
                  this.saveResults(state);
                }
              }

              this.checkModalityEmpty(state, currentModIdx);
            }
          }, 500); // rename window

          return;
        }
      }
    }
  }

  /**
   * Remove a tuple, re-indexing loadedImages/winners/recentlyDeleted in the same operation
   * as the splice (docs/file-watching.md: reindex-in-lockstep), and notify the webview.
   */
  private removeTuple(state: PanelState, tupleIndex: TupleIndex): void {
    if (state.disposed) return;
    state.scanResult.tuples.splice(tupleIndex, 1);

    const newLoadedImages = new Map<string, LoadedImage>();
    for (const [key, value] of state.loadedImages) {
      const [tIdx, mIdx] = key.split('-').map(Number);
      if (tIdx > tupleIndex) {
        newLoadedImages.set(`${tIdx - 1}-${mIdx}`, value);
      } else if (tIdx < tupleIndex) {
        newLoadedImages.set(key, value);
      }
      // tIdx === tupleIndex: discard (tuple removed)
    }
    state.loadedImages = newLoadedImages;

    const newWinners = new Map<TupleIndex, OriginalModalityIndex>();
    for (const [tIdx, mIdx] of state.winners) {
      const shifted = shiftIndexAfterRemoval(tIdx, tupleIndex);
      if (shifted !== null) newWinners.set(asTuple(shifted), mIdx);
    }
    state.winners = newWinners;

    state.recentlyDeleted = state.recentlyDeleted.flatMap(d => {
      const shifted = shiftIndexAfterRemoval(d.tupleIndex, tupleIndex);
      return shifted === null ? [] : [{ ...d, tupleIndex: asTuple(shifted) }];
    });

    if (state.currentTupleIndex >= state.scanResult.tuples.length) {
      state.currentTupleIndex = asTuple(Math.max(0, state.scanResult.tuples.length - 1));
    } else if (state.currentTupleIndex > tupleIndex) {
      state.currentTupleIndex--;
    }

    const msg: ExtensionMessage = { type: 'tupleDeleted', tupleIndex };
    state.panel.webview.postMessage(msg);

    // A structural mutation must not strand the current view (docs/file-watching.md: mutation-never-strands-view).
    this.refreshCurrentTupleImages(state);

    if (state.votingEnabled) {
      this.saveResults(state);
    }
  }

  /**
   * Re-send the current tuple's images (cached ones serve immediately). Call after any
   * mutation that shifts indices under an in-flight load.
   */
  private refreshCurrentTupleImages(state: PanelState): void {
    if (state.disposed) return;
    const tupleIndex = state.currentTupleIndex;
    if (!state.scanResult.tuples[tupleIndex]) return;
    for (let m = 0; m < state.scanResult.modalities.length; m++) {
      void this.sendImage(state, tupleIndex, asOriginal(m));
    }
  }

  /**
   * Drop a modality once its last file is gone — reaches the same end state as a
   * modality-directory delete, but from below.
   */
  private checkModalityEmpty(state: PanelState, modalityIndex: number): void {
    const modality = state.scanResult.modalities[modalityIndex];
    if (!modality) return;

    const hasFiles = state.scanResult.tuples.some(tuple =>
      tuple.images.some(img => img.modality === modality)
    );
    
    if (!hasFiles) {
      this.removeModality(state, modalityIndex);
    }
  }

  /**
   * Remove a modality column, re-indexing every index-keyed structure alongside the splice
   * (docs/file-watching.md: reindex-in-lockstep).
   */
  private async removeModality(state: PanelState, modalityIndex: number): Promise<void> {
    const modality = state.scanResult.modalities[modalityIndex];

    this.unwatchModalityDir(state, modality);
    state.scanResult.modalities.splice(modalityIndex, 1);

    for (const tuple of state.scanResult.tuples) {
      tuple.images = tuple.images.filter(img => img.modality !== modality);
    }

    // Cleared wholesale: every key past the removed column is wrong, and the column is gone.
    state.loadedImages.clear();

    // Drop winners pointing at the removed modality, shift those after it.
    const newWinners = new Map<TupleIndex, OriginalModalityIndex>();
    for (const [tupleIndex, winnerModalityIndex] of state.winners) {
      const shifted = shiftIndexAfterRemoval(winnerModalityIndex, modalityIndex);
      if (shifted !== null) newWinners.set(tupleIndex, asOriginal(shifted));
    }
    state.winners = newWinners;

    state.recentlyDeleted = state.recentlyDeleted.flatMap(d => {
      const shifted = shiftIndexAfterRemoval(d.modalityIndex, modalityIndex);
      return shifted === null ? [] : [{ ...d, modalityIndex: shifted }];
    });

    const msg: ExtensionMessage = {
      type: 'modalityRemoved',
      modalityIndex: asOriginal(modalityIndex)
    };
    state.panel.webview.postMessage(msg);

    if (state.votingEnabled) {
      await this.saveResults(state);
    }
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

      const cacheKey = `${tupleIndex}-${modalityIndex}`;
      state.loadedImages.delete(cacheKey);

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

      const cacheKey = `${tupleIndex}-${modalityIndex}`;
      state.loadedImages.delete(cacheKey);

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

    const baseFilename = filename.replace(/\.[^.]+$/, '');

    // Longest-match-wins, ties toward a free slot; not the trie matcher (docs/file-watching.md).
    let matchingTupleIndex = -1;
    let bestMatchLen = -1;
    let bestSlotFree = false;

    for (let i = 0; i < state.scanResult.tuples.length; i++) {
      const tuple = state.scanResult.tuples[i];
      let matchLen = -1;

      if (tuple.name && baseFilename.includes(tuple.name)) {
        matchLen = tuple.name.length;
      }

      // An exact basename match scores the maximum possible length.
      for (const img of tuple.images) {
        const imgBase = img.name.replace(/\.[^.]+$/, '');
        if (imgBase === baseFilename) {
          matchLen = baseFilename.length;
          break;
        }
      }

      if (matchLen < 0) continue;

      const slotFree = !tuple.images.find(img => img.modality === modalityName);

      if (matchLen > bestMatchLen) {
        matchingTupleIndex = i;
        bestMatchLen = matchLen;
        bestSlotFree = slotFree;
      } else if (matchLen === bestMatchLen && slotFree && !bestSlotFree) {
        matchingTupleIndex = i;
        bestSlotFree = slotFree;
      }
    }

    // A taken slot means a new tuple, never a looser match (docs/tuple-matching.md: one-file-per-modality).
    if (!bestSlotFree) {
      matchingTupleIndex = -1;
    }

    if (matchingTupleIndex >= 0) {
      const tuple = state.scanResult.tuples[matchingTupleIndex];
      tuple.images.push({
        uri,
        name: filename,
        modality: modalityName
      });

      tuple.images.sort((a, b) =>
        state.scanResult.modalities.indexOf(a.modality) -
        state.scanResult.modalities.indexOf(b.modality)
      );

      this.regenerateThumbnail(state, matchingTupleIndex, modalityIndex);

      // imageInfo lets the webview fill in a slot it did not know about.
      const restoredMsg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex: asTuple(matchingTupleIndex),
        modalityIndex,
        imageInfo: {
          name: filename,
          modality: modalityName,
          tupleIndex: asTuple(matchingTupleIndex),
          modalityIndex
        }
      };
      state.panel.webview.postMessage(restoredMsg);
    }
    if (matchingTupleIndex < 0) {
      // Suffix collisions ` (2)`, `(3)`… like the scan path, or one results line votes for every same-named tuple (docs/session-files.md: durable-vote-key).
      const existingNames = new Set(state.scanResult.tuples.map(t => t.name));
      let uniqueName = baseFilename;
      for (let n = 2; existingNames.has(uniqueName); n++) {
        uniqueName = `${baseFilename} (${n})`;
      }

      // One file for now; other modalities may arrive later.
      const newTuple = {
        name: uniqueName,
        images: [{
          uri,
          name: filename,
          modality: modalityName
        }]
      };
      
      // Sorted insertion, not current+1: the create can arrive a whole sweep after the user navigated away (docs/file-watching.md: rows-insert-in-order).
      const insertIndex = asTuple(tupleInsertIndex(state.scanResult.tuples.map(t => t.name), uniqueName));
      state.scanResult.tuples.splice(insertIndex, 0, newTuple);
      const newTupleIndex = insertIndex;

      // Insertion shifts every index-keyed structure up, in lockstep with the splice (docs/file-watching.md: reindex-in-lockstep).
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

      const newWinners = new Map<TupleIndex, OriginalModalityIndex>();
      for (const [tIdx, mIdx] of state.winners) {
        if (tIdx >= insertIndex) {
          newWinners.set(asTuple(tIdx + 1), mIdx);
        } else {
          newWinners.set(tIdx, mIdx);
        }
      }
      state.winners = newWinners;

      for (const d of state.recentlyDeleted) {
        if (d.tupleIndex >= insertIndex) {
          d.tupleIndex++;
        }
      }

      // The >= guard shifts the current index with the splice (docs/file-watching.md: mutation-never-strands-view).
      if (state.currentTupleIndex >= insertIndex) {
        state.currentTupleIndex++;
      }

      // Dense over ALL modalities, like sendInitData: webview position *is* the global index.
      const tupleInfo: TupleInfo = {
        name: newTuple.name,
        images: state.scanResult.modalities.map((modality, mIdx) => {
          const img = this.findImageForModality(newTuple, modality);
          return {
            name: img?.name || '',
            modality,
            tupleIndex: newTupleIndex,
            modalityIndex: asOriginal(mIdx)
          };
        })
      };

      const msg: ExtensionMessage = {
        type: 'tupleAdded',
        tuple: tupleInfo,
        tupleIndex: newTupleIndex
      };
      state.panel.webview.postMessage(msg);

      const addedModalityIndex = state.scanResult.modalities.indexOf(modalityName);
      this.regenerateThumbnail(state, newTupleIndex, addedModalityIndex);
    }
  }

  /**
   * Insert a new modality column: at the caller's position in mode 2, alphabetically in mode 1
   * (best-effort — see the caveat in docs/file-watching.md). Returns its index, or -1 on failure.
   */
  private async addNewModality(state: PanelState, modalityName: string): Promise<number> {
    const modalities = state.scanResult.modalities;

    // A mode-2 re-add keeps the caller's slot from modalityDirs key order (docs/tuple-matching.md: modality-order-is-callers); mode 1 has no caller order.
    const callerOrder = state.modalityDirs.size > 0 ? Array.from(state.modalityDirs.keys()) : undefined;
    const insertIndex = modalityInsertIndex(modalities, modalityName, callerOrder);

    modalities.splice(insertIndex, 0, modalityName);

    // Insertion invalidates every key: "0-2" no longer names the same modality (docs/file-watching.md: reindex-in-lockstep).
    state.loadedImages.clear();

    const newWinners = new Map<TupleIndex, OriginalModalityIndex>();
    for (const [tupleIndex, winnerModalityIndex] of state.winners) {
      if (winnerModalityIndex >= insertIndex) {
        newWinners.set(tupleIndex, asOriginal(winnerModalityIndex + 1));
      } else {
        newWinners.set(tupleIndex, winnerModalityIndex);
      }
    }
    state.winners = newWinners;

    state.recentlyDeleted = state.recentlyDeleted.map(d =>
      d.modalityIndex >= insertIndex ? { ...d, modalityIndex: d.modalityIndex + 1 } : d
    );

    // Re-sort each tuple's sparse images into the new modality order.
    for (const tuple of state.scanResult.tuples) {
      tuple.images.sort((a, b) =>
        modalities.indexOf(a.modality) - modalities.indexOf(b.modality)
      );
    }

    if (state.baseUri && !state.disposed) {
      const newDir = vscode.Uri.joinPath(state.baseUri, modalityName).path;
      const scheme = state.scanResult.tuples[0]?.images[0]?.uri.scheme;
      // Setup runs once at open, so a dir discovered later must be watched here or never (docs/file-watching.md: watched-dirs-have-watchers).
      if (scheme && !state.watchedDirs.has(newDir)) {
        state.watchedDirs.add(newDir);
        this.watchDirectory(state, newDir, scheme, true);
      }
    }

    const msg: ExtensionMessage = {
      type: 'modalityAdded',
      modality: modalityName,
      modalityPath: this.resolveModalityPath(state, modalityName),
      modalityColors: state.scanResult.modalities.map((mod, i) => this.resolveModalityColor(state, mod, i)),
      modalityIndex: asOriginal(insertIndex)
    };
    state.panel.webview.postMessage(msg);

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
        const cacheKey = `${tupleIndex}-${modalityIndex}`;
        state.loadedImages.delete(cacheKey);
        this.regenerateThumbnail(state, tupleIndex, modalityIndex);
        if (tupleIndex === state.currentTupleIndex) {
          this.sendImage(state, asTuple(tupleIndex), modalityIndex);
        }
        return;
      }
    }
  }

  /**
   * Post a message to the webview's console when `imageCompare.debug` is on, queueing
   * it if the webview has not signalled 'ready' yet.
   */
  private debugMsg(state: PanelState, msg: string): void {
    const debug = vscode.workspace.getConfiguration('imageCompare').get<boolean>('debug', false);
    if (!debug) return;
    if (state.webviewReady) {
      state.panel.webview.postMessage({ type: '_debug', msg });
    } else {
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
      const dataUrl = await this.pool.submit(
        () => this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2),
        { priority: Priority.THUMBNAIL, key: state.poolKey }
      );
      const okSlot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (!okSlot || okSlot.modalityIndex < 0) return;
      this.sendThumbnailMessage(state, okSlot.tupleIndex, okSlot.modalityIndex, dataUrl);
    } catch (error) {
      if (error instanceof TaskCancelled || state.disposed) return;
      const slot = this.resolveSlotForUri(state, tupleIndex, modality, imageFile.uri);
      if (!slot || slot.modalityIndex < 0) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendThumbnailErrorMessage(state, slot.tupleIndex, slot.modalityIndex, message);
    }
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
