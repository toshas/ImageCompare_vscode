import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { scanForImages, readResultsFile, writeResultsFile, mapWinnersToIndices, disambiguateDirectoryNames } from './fileService';
import { ThumbnailService } from './thumbnailService';
import { parsePpmx, parsePpmxRaw, PpmxOrientationHint } from './ppmxParser';
import { renderWebviewHtml } from './webviewShell';
import { copyFilesToClipboard, clipboardFileCount, stageForUniqueNames } from './clipboardFiles';
import {
  ScanResult,
  TupleInfo,
  ImageTuple,
  ImageFile,
  WebViewMessage,
  ExtensionMessage,
  LoadedImage,
  isImageFile,
  PpmxColormap
} from './types';

const PPMX_COLORMAPS: PpmxColormap[] = ['grayscale', 'jet'];

function normalizePpmxColormap(value: string | undefined): PpmxColormap {
  if (value && PPMX_COLORMAPS.includes(value as PpmxColormap)) {
    return value as PpmxColormap;
  }
  return 'grayscale';
}

/**
 * Info about a recently deleted file (for rename detection)
 */
interface DeletedFileInfo {
  uri: vscode.Uri;
  tupleIndex: number;
  modalityIndex: number;
  timestamp: number;
}

interface PpmxRawCacheEntry {
  width: number;
  height: number;
  values: Float32Array;
  mtime: number;
  orientationKey: string;
}

/**
 * State associated with a single panel instance
 */
interface PanelState {
  panel: vscode.WebviewPanel;
  scanResult: ScanResult;
  loadedImages: Map<string, LoadedImage>;
  currentTupleIndex: number;
  fileWatchers: vscode.FileSystemWatcher[];
  nodeWatchers: fs.FSWatcher[];
  deleteCheckTimer?: ReturnType<typeof setInterval>; // Polling timer for delete detection
  watchedDirs: Set<string>;
  baseUri?: vscode.Uri; // Root directory for single-directory mode (mode 1)
  modalityDirs: Map<string, vscode.Uri>; // Modality name -> directory URI (for mode 2)
  recentlyDeleted: DeletedFileInfo[];
  winners: Map<number, number>; // tupleIndex -> modalityIndex (display index)
  votingEnabled: boolean; // true for mode 1 and 2 (directory-based modes)
  webviewReady: boolean;
  pendingDebugMessages: string[];
  ppmxColormap: PpmxColormap;
  ppmxRawCache: Map<string, PpmxRawCacheEntry>;
  tupleOrientationHints: Map<number, PpmxOrientationHint | null>;
}

/**
 * Provider for the ImageCompare WebView panel
 */
export class ImageCompareProvider {
  public static readonly viewType = 'imageCompare.viewer';

  private thumbnailService: ThumbnailService;
  private disposables: vscode.Disposable[] = [];
  // Track all open panels (for cleanup on deactivate)
  private panels: Set<PanelState> = new Set();
  private panelCounter = 0; // For fallback naming

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.thumbnailService = new ThumbnailService(context);
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    await this.thumbnailService.initialize();
  }

  /**
   * Open the ImageCompare viewer for the given URIs
   * Each call creates a new independent panel/tab
   */
  async openCompare(uris: vscode.Uri[]): Promise<void> {
    try {
      // Scan for images
      const scanResult = await scanForImages(uris);

      if (scanResult.tuples.length === 0) {
        vscode.window.showErrorMessage('No image tuples found');
        return;
      }

      // Derive a title - use common prefix from tuple names or folder name
      const title = this.deriveTitle(scanResult, uris);

      // Create a new panel
      const panel = vscode.window.createWebviewPanel(
        ImageCompareProvider.viewType,
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, 'dist')
          ]
        }
      );

      // Determine mode and set up directory tracking
      // Mode 1: Single directory with subdirectories -> baseUri is set
      // Mode 2: Multiple directories selected -> modalityDirs maps modality -> directory
      // Mode 3: Multiple files selected -> neither (no directory structure)
      let baseUri: vscode.Uri | undefined;
      const modalityDirs = new Map<string, vscode.Uri>();

      if (uris.length === 1) {
        // Mode 1: Single directory
        baseUri = uris[0];
      } else if (uris.length >= 2 && scanResult.isMultiTupleMode) {
        // Mode 2: Multiple directories - map modality names to directory URIs
        // Use disambiguated names (same logic as fileService scanning)
        const disambiguated = disambiguateDirectoryNames(uris);
        for (const { name, uri } of disambiguated) {
          if (scanResult.modalities.includes(name)) {
            modalityDirs.set(name, uri);
          }
        }
      }
      // Mode 3: Multiple files - no directory tracking needed

      // Collect directories to watch (per-modality for reliable event handling)
      const watchedDirs = new Set<string>();
      if (baseUri) {
        // Mode 1: watch base directory (for new modality detection) + each modality dir
        watchedDirs.add(baseUri.path);
      }
      if (modalityDirs.size > 0) {
        // Mode 2: watch each modality directory
        for (const dirUri of modalityDirs.values()) {
          watchedDirs.add(dirUri.path);
        }
      }
      // Always add directories that directly contain image files
      for (const tuple of scanResult.tuples) {
        for (const img of tuple.images) {
          const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
          if (dir) watchedDirs.add(dir);
        }
      }

      // Determine if voting is enabled (mode 1 or mode 2 - directory-based modes)
      const votingEnabled = baseUri !== undefined || modalityDirs.size > 0;
      const config = vscode.workspace.getConfiguration('imageCompare');
      const ppmxColormap = normalizePpmxColormap(config.get<string>('ppmxColormap', 'grayscale'));

      // Create panel-specific state
      const panelState: PanelState = {
        panel,
        scanResult,
        loadedImages: new Map<string, LoadedImage>(),
        currentTupleIndex: 0,
        fileWatchers: [],
        nodeWatchers: [],
        watchedDirs,
        baseUri,
        modalityDirs,
        recentlyDeleted: [],
        winners: new Map<number, number>(),
        votingEnabled,
        webviewReady: false,
        pendingDebugMessages: [],
        ppmxColormap,
        ppmxRawCache: new Map<string, PpmxRawCacheEntry>(),
        tupleOrientationHints: new Map<number, PpmxOrientationHint | null>()
      };

      // Set up file system watcher
      this.setupFileWatcher(panelState);

      // Track this panel
      this.panels.add(panelState);

      // Handle messages from webview (with panel-specific state)
      // IMPORTANT: Set up listener BEFORE setting HTML to avoid race condition
      panel.webview.onDidReceiveMessage(
        (message: WebViewMessage) => this.handlePanelMessage(panelState, message),
        null,
        this.disposables
      );

      // Set HTML content (this triggers webview JS to run and send 'ready')
      panel.webview.html = this.getHtmlContent(panel.webview);

      // Handle panel disposal
      panel.onDidDispose(
        () => {
          panelState.loadedImages.clear();
          panelState.ppmxRawCache.clear();
          panelState.tupleOrientationHints.clear();
          panelState.fileWatchers.forEach(w => w.dispose());
          panelState.nodeWatchers.forEach(w => w.close());
          if (panelState.deleteCheckTimer) clearInterval(panelState.deleteCheckTimer);
          this.panels.delete(panelState);
        },
        null,
        this.disposables
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
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
        // Flush any debug messages queued before webview was ready
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
        await this.sendImage(state, message.tupleIndex, message.modalityIndex);
        break;

      case 'requestPixelValue':
        await this.handleRequestPixelValue(state, message.tupleIndex, message.modalityIndex, message.x, message.y, message.requestId);
        break;

      case 'requestPpmxRaw':
        await this.handleRequestPpmxRaw(state, message.tupleIndex, message.modalityIndex, message.requestId);
        break;

      case 'navigateTo':
        state.currentTupleIndex = message.tupleIndex;
        // Don't prefetch immediately - wait for tuple to fully load first
        break;

      case 'setCurrentTuple':
        // Immediately update current tuple (used to cancel stale loads)
        state.currentTupleIndex = message.tupleIndex;
        break;

      case 'tupleFullyLoaded':
        // Only prefetch if this is still the current tuple (user hasn't navigated away)
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

      case 'setPpmxColormap':
        this.handleSetPpmxColormap(state, message.colormap);
        break;

      case 'deleteTuple':
        await this.handleDeleteTuple(state, message.tupleIndex);
        break;

      case 'exportPptx':
        await this.handleExportPptx(state, message.tupleIndices, message.winnerModalityIndices, message.modalityOrder);
        break;

      case 'copyFiles':
        await this.handleCopyFiles(state, message.items);
        break;

      case 'copyImageResult':
        if (message.ok) {
          vscode.window.setStatusBarMessage('ImageCompare: image copied to clipboard', 2000);
        } else {
          vscode.window.showWarningMessage(
            `ImageCompare: couldn't copy image — ${message.error ?? 'unknown error'}`,
          );
        }
        break;

      case 'log':
        // WebView debug messages (disabled in production)
        break;
    }
  }

  /**
   * Copy the selected images as FILES to the OS clipboard (multi-select copy).
   * Resolves (tupleIndex, modalityIndex) pairs to file paths, then delegates to
   * copyFilesToClipboard (native on macOS/Windows, text fallback + warning on Linux).
   */
  private async handleCopyFiles(
    state: PanelState,
    items: { tupleIndex: number; modalityIndex: number }[],
  ): Promise<void> {
    try {
      const resolved: { path: string; label: string }[] = [];
      for (const it of items) {
        const tuple = state.scanResult.tuples[it.tupleIndex];
        const modality = state.scanResult.modalities[it.modalityIndex];
        if (!tuple || !modality) continue;
        const img = this.findImageForModality(tuple, modality);
        if (img && img.uri.scheme === 'file') resolved.push({ path: img.uri.fsPath, label: modality });
      }
      if (resolved.length === 0) {
        state.panel.webview.postMessage({ type: 'copyError', error: 'No local files to copy' });
        return;
      }
      // Defend against BOTH failure modes that silently drop files at paste time:
      //  - duplicate PATHS (two tiles resolving to the same file): collapse them.
      //  - duplicate NAMES (same basename across modalities): stage copies with
      //    disambiguated names so every file pastes (see stageForUniqueNames).
      const seen = new Set<string>();
      const deduped = resolved.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
      const finalPaths = stageForUniqueNames(deduped);

      const res = await copyFilesToClipboard(finalPaths);
      state.panel.webview.postMessage({ type: 'copyComplete', count: res.count, method: res.method });

      // Diagnostic: counts along the pipeline so any drop is pinpointed.
      const v = (this.context.extension?.packageJSON?.version as string) ?? '?';
      const onClip = await clipboardFileCount();
      const uniquePaths = new Set(resolved.map((r) => r.path)).size;
      const uniqueNames = new Set(resolved.map((r) => path.basename(r.path))).size;
      vscode.window.setStatusBarMessage(
        `ImageCompare v${v}: items=${items.length} resolved=${resolved.length} uniquePaths=${uniquePaths} uniqueNames=${uniqueNames} copied=${res.count} onClipboard=${onClip}`,
        9000,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.panel.webview.postMessage({ type: 'copyError', error: msg });
      vscode.window.showErrorMessage(`ImageCompare: copy failed — ${msg}`);
    }
  }

  private async handleRequestPpmxRaw(
    state: PanelState,
    tupleIndex: number,
    modalityIndex: number,
    requestId: number
  ): Promise<void> {
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    if (!tuple || !modality) {
      return;
    }

    const imageFile = this.findImageForModality(tuple, modality);
    if (!imageFile || path.extname(imageFile.name).toLowerCase() !== '.ppmx') {
      return;
    }

    const raw = await this.getPpmxRawDataForTuple(state, imageFile.uri, tupleIndex);
    if (!raw) {
      return;
    }

    const valueBytes = Buffer.from(raw.values.buffer, raw.values.byteOffset, raw.values.byteLength);
    const msg: ExtensionMessage = {
      type: 'ppmxRawData',
      tupleIndex,
      modalityIndex,
      requestId,
      width: raw.width,
      height: raw.height,
      valuesBase64: valueBytes.toString('base64')
    };
    state.panel.webview.postMessage(msg);
  }

  private async handleRequestPixelValue(
    state: PanelState,
    tupleIndex: number,
    modalityIndex: number,
    x: number,
    y: number,
    requestId: number
  ): Promise<void> {
    const msgBase = { type: 'pixelValue' as const, tupleIndex, modalityIndex, x, y, requestId };
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    if (!tuple || !modality) {
      state.panel.webview.postMessage({ ...msgBase, value: null } as ExtensionMessage);
      return;
    }

    const imageFile = this.findImageForModality(tuple, modality);
    if (!imageFile || path.extname(imageFile.name).toLowerCase() !== '.ppmx') {
      state.panel.webview.postMessage({ ...msgBase, value: null } as ExtensionMessage);
      return;
    }

    const raw = await this.getPpmxRawDataForTuple(state, imageFile.uri, tupleIndex);
    if (!raw) {
      state.panel.webview.postMessage({ ...msgBase, value: null } as ExtensionMessage);
      return;
    }

    const clampedX = Math.max(0, Math.min(raw.width - 1, Math.round(x)));
    const clampedY = Math.max(0, Math.min(raw.height - 1, Math.round(y)));
    const idx = clampedY * raw.width + clampedX;
    const value = idx >= 0 && idx < raw.values.length ? raw.values[idx] : null;
    const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : null;

    state.panel.webview.postMessage({
      ...msgBase,
      x: clampedX,
      y: clampedY,
      value: safeValue
    } as ExtensionMessage);
  }

  private isPpmxImageFile(imageFile: ImageFile | undefined): boolean {
    if (!imageFile) return false;
    return path.extname(imageFile.name).toLowerCase() === '.ppmx';
  }

  private async getTupleOrientationHint(
    state: PanelState,
    tupleIndex: number
  ): Promise<PpmxOrientationHint | undefined> {
    if (state.tupleOrientationHints.has(tupleIndex)) {
      const cached = state.tupleOrientationHints.get(tupleIndex);
      return cached || undefined;
    }

    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) {
      state.tupleOrientationHints.set(tupleIndex, null);
      return undefined;
    }

    for (const imageFile of tuple.images) {
      if (this.isPpmxImageFile(imageFile)) continue;
      try {
        const dims = await this.thumbnailService.getImageDimensions(imageFile.uri);
        if (dims.width > 0 && dims.height > 0) {
          const hint = { width: dims.width, height: dims.height };
          state.tupleOrientationHints.set(tupleIndex, hint);
          return hint;
        }
      } catch {
        // Ignore and try next non-PPMX modality
      }
    }

    state.tupleOrientationHints.set(tupleIndex, null);
    return undefined;
  }

  private async getPpmxRawDataForTuple(
    state: PanelState,
    uri: vscode.Uri,
    tupleIndex?: number
  ): Promise<PpmxRawCacheEntry | null> {
    const orientationHint = typeof tupleIndex === 'number'
      ? await this.getTupleOrientationHint(state, tupleIndex)
      : undefined;
    const orientationKey = orientationHint
      ? `${orientationHint.width}x${orientationHint.height}`
      : 'none';

    const key = `${uri.toString()}|${orientationKey}`;
    let mtime = 0;
    try {
      mtime = (await vscode.workspace.fs.stat(uri)).mtime;
    } catch {
      return null;
    }

    const cached = state.ppmxRawCache.get(key);
    if (cached && cached.mtime === mtime && cached.orientationKey === orientationKey) {
      return cached;
    }

    try {
      const fileData = await vscode.workspace.fs.readFile(uri);
      const raw = parsePpmxRaw(Buffer.from(fileData), { orientationHint });
      const entry: PpmxRawCacheEntry = {
        width: raw.width,
        height: raw.height,
        values: raw.values,
        mtime,
        orientationKey
      };
      state.ppmxRawCache.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Handle setting or clearing a winner for a tuple
   */
  private async handleSetWinner(state: PanelState, tupleIndex: number, modalityIndex: number | null): Promise<void> {
    if (!state.votingEnabled) return;

    if (modalityIndex === null) {
      // Clear winner
      state.winners.delete(tupleIndex);
    } else {
      // Set winner
      state.winners.set(tupleIndex, modalityIndex);
    }

    // Notify webview
    const msg: ExtensionMessage = {
      type: 'winnerUpdated',
      tupleIndex,
      modalityIndex
    };
    state.panel.webview.postMessage(msg);

    // Persist to results.txt
    await this.saveResults(state);
  }

  /**
   * Handle delete tuple request: delete all image files for the given tuple from disk.
   * File watchers will detect the deletions and update the UI.
   */
  private handleSetPpmxColormap(state: PanelState, colormap: PpmxColormap): void {
    if (!PPMX_COLORMAPS.includes(colormap)) return;
    if (state.ppmxColormap === colormap) return;
    state.ppmxColormap = colormap;
    state.loadedImages.clear();
  }

  private getLoadedImageCacheKey(tupleIndex: number, modalityIndex: number, colormap: PpmxColormap): string {
    return `${tupleIndex}-${modalityIndex}-${colormap}`;
  }

  private clearLoadedImageCacheForSlot(state: PanelState, tupleIndex: number, modalityIndex: number): void {
    const keyPrefix = `${tupleIndex}-${modalityIndex}-`;
    for (const key of Array.from(state.loadedImages.keys())) {
      if (key.startsWith(keyPrefix)) {
        state.loadedImages.delete(key);
      }
    }
  }

  private async handleDeleteTuple(state: PanelState, tupleIndex: number): Promise<void> {
    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) return;

    // Delete files from disk
    for (const img of tuple.images) {
      try {
        await vscode.workspace.fs.delete(img.uri);
      } catch {
        // File may already be gone
      }
    }

    // Immediately remove from state — don't wait for filesystem watcher polling
    this.removeTuple(state, tupleIndex);
  }

  /**
   * Handle PPTX export request: generate a PowerPoint presentation for voted tuples.
   */
  private async handleExportPptx(
    state: PanelState,
    tupleIndices: number[],
    winnerModalityIndices: (number | null)[],
    modalityOrder: number[]
  ): Promise<void> {
    try {
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.title = 'ImageCompare Export';

      const slideWidth = 10; // inches (default for 16:9)
      const slideHeight = 5.625; // inches (default for 16:9)

      const barH = 0.35; // inches — height of the caption bar

      const addCaption = (slide: PptxGenJS.Slide, tupleName: string, modality: string, isWinner: boolean) => {
        // Semi-transparent white bar spanning full slide width at top
        slide.addShape('rect', {
          x: 0, y: 0, w: slideWidth, h: barH,
          fill: { color: 'D0D0D0', transparency: 50 },
        });

        // Tuple name — left-aligned
        slide.addText(tupleName, {
          x: 0.1, y: 0, w: slideWidth / 2, h: barH,
          fontSize: 10,
          fontFace: 'Arial',
          bold: true,
          color: '000000',
          valign: 'middle',
          align: 'left',
        });

        // Modality name — right-aligned
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

      // Helper to load image as base64
      const loadImageBase64 = async (uri: vscode.Uri, tupleIndex?: number): Promise<{ data: string; width: number; height: number } | null> => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const buffer = Buffer.from(bytes);
          const ext = path.extname(uri.path).toLowerCase();
          const sharp = (await import('./sharpLoader')).getSharp();
          if (sharp) {
            let img;
            if (ext === '.ppmx') {
              const orientationHint = typeof tupleIndex === 'number'
                ? await this.getTupleOrientationHint(state, tupleIndex)
                : undefined;
              const ppmx = parsePpmx(buffer, { colormap: state.ppmxColormap, orientationHint });
              img = sharp(ppmx.rgbBuffer, { raw: { width: ppmx.width, height: ppmx.height, channels: 3 } });
            } else {
              img = sharp(buffer);
            }
            const meta = await img.metadata();
            const pngBuffer = await img.png().toBuffer();
            return {
              data: `data:image/png;base64,${pngBuffer.toString('base64')}`,
              width: meta.width || 100,
              height: meta.height || 100
            };
          }
          // Fallback to raw base64 (may not work for all formats)
          return {
            data: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
            width: 100,
            height: 100
          };
        } catch {
          return null;
        }
      };

      // Helper to find crop tuples for a base tuple
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

      // Helper to find parent tuple for a crop tuple (strip _cropNN suffix)
      const findParentTuple = (cropName: string): number => {
        const match = cropName.match(/^(.+)_crop\d+$/);
        if (!match) return -1;
        return state.scanResult.tuples.findIndex(t => t.name === match[1]);
      };

      // Compute non-overlapping layout for crop slide: main image + callout thumbnail
      const computeCropLayout = (cropAspect: number, fullAspect: number) => {
        const gap = 0.15;
        const defaultThumbW = 2;
        const minThumbW = 1.2;

        // Contain-fit crop image to full slide
        let mainW: number, mainH: number;
        if (cropAspect > slideWidth / slideHeight) {
          mainW = slideWidth; mainH = slideWidth / cropAspect;
        } else {
          mainH = slideHeight; mainW = slideHeight * cropAspect;
        }
        let mainX = (slideWidth - mainW) / 2;
        let mainY = (slideHeight - mainH) / 2;
        const origArea = mainW * mainH;

        // Thumbnail in bottom-right
        let thumbW = defaultThumbW;
        let thumbH = thumbW / fullAspect;
        let thumbX = slideWidth - thumbW;
        let thumbY = slideHeight - thumbH;

        // Check overlap (with gap margin)
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

      // Helper: add a crop slide (crop image main + full image callout with red rect)
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
        const cropImgData = await loadImageBase64(cropImg.uri, cropTupleIdx);
        if (!cropImgData) return;

        const fullTuple = state.scanResult.tuples[fullTupleIdx];
        const fullImg = fullTuple.images.find(i => i.modality === modality);
        if (!fullImg) return;
        const fullImgData = await loadImageBase64(fullImg.uri, fullTupleIdx);
        if (!fullImgData) return;

        const cropAspect = cropImgData.width / cropImgData.height;
        const fullAspect = fullImgData.width / fullImgData.height;
        const layout = computeCropLayout(cropAspect, fullAspect);

        const slide = pptx.addSlide();
        slide.addImage({ data: cropImgData.data, x: layout.mainX, y: layout.mainY, w: layout.mainW, h: layout.mainH });
        slide.addImage({ data: fullImgData.data, x: layout.thumbX, y: layout.thumbY, w: layout.thumbW, h: layout.thumbH });

        // Read crop metadata from PNG to get exact coordinates
        const cropMeta = await this.thumbnailService.readCropMetadata(cropImg.uri);
        if (cropMeta) {
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

      // Process each voted tuple
      for (let idx = 0; idx < tupleIndices.length; idx++) {
        const tupleIndex = tupleIndices[idx];
        const winnerIdx = winnerModalityIndices[idx];
        const tuple = state.scanResult.tuples[tupleIndex];
        if (!tuple) continue;

        // Check if this voted tuple is itself a crop
        const parentIdx = findParentTuple(tuple.name);
        if (parentIdx >= 0) {
          // This is a crop tuple — show crop image + parent full image callout
          for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
            const originalModIdx = modalityOrder[displayIdx];
            const modality = state.scanResult.modalities[originalModIdx];
            if (!modality) continue;
            await addCropSlide(tupleIndex, parentIdx, modality, tuple.name, winnerIdx === originalModIdx);
          }
          continue;
        }

        // Non-crop tuple: check for crop children
        const cropTupleIndices = findCropTuples(tuple.name);
        const hasCrops = cropTupleIndices.length > 0;
        // If any crop child is also voted, show parent as simple slide (voted crops get their own slides)
        const hasVotedCrops = hasCrops && cropTupleIndices.some(ci => tupleIndices.includes(ci));

        // For each modality in display order
        for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
          const originalModIdx = modalityOrder[displayIdx];
          const modality = state.scanResult.modalities[originalModIdx];
          if (!modality) continue;
          const isWinner = winnerIdx === originalModIdx;

          if (!hasCrops || hasVotedCrops) {
            // Simple case: full image fit to slide
            // (no crops, or crop children are voted separately — they get their own slides)
            const img = tuple.images.find(i => i.modality === modality);
            if (!img) continue;
            const imgData = await loadImageBase64(img.uri, tupleIndex);
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
            // Only parent voted, exactly one crop — present as if the crop was voted
            await addCropSlide(cropTupleIndices[0], tupleIndex, modality, state.scanResult.tuples[cropTupleIndices[0]].name, isWinner);
          } else {
            // Multiple crop children, none voted: one slide per crop
            for (const cropTupleIdx of cropTupleIndices) {
              await addCropSlide(cropTupleIdx, tupleIndex, modality, state.scanResult.tuples[cropTupleIdx].name, isWinner);
            }
          }
        }
      }

      // Determine output path
      const baseDir = state.baseUri?.fsPath ||
        (state.modalityDirs.size > 0 ? Array.from(state.modalityDirs.values())[0].fsPath : undefined);

      if (!baseDir) {
        throw new Error('Cannot determine output directory');
      }

      const parentDir = state.baseUri ? baseDir : path.dirname(baseDir);

      // Find next available pptx number
      let pptxNum = 1;
      const existingFiles = await fs.promises.readdir(parentDir);
      const pptxPattern = /^comparison_(\d+)\.pptx$/;
      for (const f of existingFiles) {
        const match = f.match(pptxPattern);
        if (match) {
          pptxNum = Math.max(pptxNum, parseInt(match[1], 10) + 1);
        }
      }

      const outputPath = path.join(parentDir, `comparison_${String(pptxNum).padStart(2, '0')}.pptx`);
      await pptx.writeFile({ fileName: outputPath });

      state.panel.webview.postMessage({ type: 'pptxComplete', path: outputPath });
      vscode.window.showInformationMessage(`PPTX exported: ${outputPath}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      state.panel.webview.postMessage({ type: 'pptxError', error: errorMsg });
      vscode.window.showErrorMessage(`PPTX export failed: ${errorMsg}`);
    }
  }

  /**
   * Handle crop request: crop all modalities in the tuple at the given rectangle.
   */
  private async handleCropImages(
    state: PanelState,
    tupleIndex: number,
    cropRect: { x: number; y: number; w: number; h: number },
    srcWidth: number,
    srcHeight: number
  ): Promise<void> {
    const tuple = state.scanResult.tuples[tupleIndex];
    if (!tuple) return;

    // Use the tuple name (common core across modalities) as the crop basename.
    // This ensures all modalities produce the same output filename (e.g.
    // "img_00079_crop01.png") so the file watcher groups them into one tuple.
    const tupleName = tuple.name;

    // Determine the crop number once from the first modality's directory,
    // scanning for existing crops of the tuple name.
    const firstImage = tuple.images[0];
    const firstDirUri = vscode.Uri.joinPath(firstImage.uri, '..');
    const cropNum = await this.getNextCropNumber(firstDirUri, tupleName);
    const cropSuffix = `_crop${String(cropNum).padStart(2, '0')}`;
    const outputName = `${tupleName}${cropSuffix}.png`;

    // Convert crop rect to relative coordinates (0-1) based on source image,
    // so it can be scaled to each modality's actual resolution.
    const relRect = {
      x: cropRect.x / srcWidth,
      y: cropRect.y / srcHeight,
      w: cropRect.w / srcWidth,
      h: cropRect.h / srcHeight
    };

    let savedCount = 0;
    const savedPaths: string[] = [];

    const cropOne = async (imageFile: ImageFile) => {
      const dirUri = vscode.Uri.joinPath(imageFile.uri, '..');
      const outputUri = vscode.Uri.joinPath(dirUri, outputName);
      const orientationHint = this.isPpmxImageFile(imageFile)
        ? await this.getTupleOrientationHint(state, tupleIndex)
        : undefined;

      // Scale relative crop rect to this modality's actual dimensions
      const meta = await this.thumbnailService.getImageDimensions(imageFile.uri, orientationHint);
      const scaledRect = {
        x: Math.max(0, Math.round(relRect.x * meta.width)),
        y: Math.max(0, Math.round(relRect.y * meta.height)),
        w: Math.round(relRect.w * meta.width),
        h: Math.round(relRect.h * meta.height)
      };
      // Clamp to image bounds
      scaledRect.w = Math.min(scaledRect.w, meta.width - scaledRect.x);
      scaledRect.h = Math.min(scaledRect.h, meta.height - scaledRect.y);
      if (scaledRect.w <= 0 || scaledRect.h <= 0) return;

      const croppedBuffer = await this.thumbnailService.cropImage(
        imageFile.uri,
        scaledRect,
        meta.width,
        meta.height,
        state.ppmxColormap,
        orientationHint
      );
      await vscode.workspace.fs.writeFile(outputUri, croppedBuffer);
      savedCount++;
      savedPaths.push(outputUri.path);
    };

    await Promise.all(tuple.images.map(async (imageFile) => {
      try {
        await cropOne(imageFile);
      } catch (err: any) {
        console.error(`[ImageCompare] Failed to crop ${imageFile.name}:`, err?.message ?? err);
      }
    }));

    if (savedCount > 0) {
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
   * Get the base URI for saving results.txt
   * Returns undefined if voting is not enabled
   */
  private getResultsBaseUri(state: PanelState): vscode.Uri | undefined {
    // Mode 1: Single directory with subdirectories
    if (state.baseUri) {
      return state.baseUri;
    }

    // Mode 2: Multiple directories - use common parent or first directory's parent
    if (state.modalityDirs.size > 0) {
      const uris = Array.from(state.modalityDirs.values());
      // Try to find common parent
      const paths = uris.map(u => u.path);
      const firstParent = paths[0].substring(0, paths[0].lastIndexOf('/'));

      // Check if all paths share this parent
      const allSameParent = paths.every(p => p.startsWith(firstParent + '/'));
      if (allSameParent) {
        return vscode.Uri.file(firstParent).with({ scheme: uris[0].scheme });
      }

      // Fallback: use first directory's parent
      return vscode.Uri.file(firstParent).with({ scheme: uris[0].scheme });
    }

    return undefined;
  }

  /**
   * Save current winners to results.txt
   * If no winners remain, deletes the file
   */
  private async saveResults(state: PanelState): Promise<void> {
    const baseUri = this.getResultsBaseUri(state);
    if (!baseUri) return;

    const resultsUri = vscode.Uri.joinPath(baseUri, 'results.txt');

    // If no winners, delete the file
    if (state.winners.size === 0) {
      try {
        await vscode.workspace.fs.delete(resultsUri);
      } catch {
        // File doesn't exist or can't be deleted - that's OK
      }
      return;
    }

    // Convert winners from Map<tupleIndex, modalityIndex> to Map<tupleIndex, modalityName>
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
        state.scanResult.modalities
      );
    } catch (error) {
      // Silently fail - results file is optional
      console.error('Failed to save results.txt:', error);
    }
  }

  /**
   * Find an image file in a tuple for a specific modality
   */
  private findImageForModality(tuple: ImageTuple, modality: string): ImageFile | undefined {
    return tuple.images.find(img => img.modality === modality);
  }

  /**
   * Send initialization data to webview
   */
  private async sendInitData(state: PanelState): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const prefetchCount = config.get<number>('prefetchCount', 3);

    const allModalities = state.scanResult.modalities;

    // Load winners from results.txt if voting is enabled
    if (state.votingEnabled) {
      const baseUri = this.getResultsBaseUri(state);
      if (baseUri) {
        try {
          const savedWinners = await readResultsFile(baseUri);
          const indexedWinners = mapWinnersToIndices(
            savedWinners,
            state.scanResult.tuples,
            allModalities
          );
          state.winners = indexedWinners;
        } catch {
          // File doesn't exist or can't be read - that's OK
        }
      }
    }

    const tuples: TupleInfo[] = state.scanResult.tuples.map((tuple, tupleIndex) => ({
      name: tuple.name,
      images: allModalities.map((modality, modalityIndex) => {
        const img = this.findImageForModality(tuple, modality);
        return {
          name: img?.name || '',
          modality,
          tupleIndex,
          modalityIndex
        };
      })
    }));

    // Convert winners Map to Record for JSON serialization
    const winnersRecord: Record<number, number> = {};
    for (const [tupleIndex, modalityIndex] of state.winners) {
      winnersRecord[tupleIndex] = modalityIndex;
    }

    // Build full directory paths for each modality (for tooltips)
    const modalityPaths: string[] = allModalities.map(mod => {
      if (state.modalityDirs.size > 0) {
        const dirUri = state.modalityDirs.get(mod);
        return dirUri ? dirUri.fsPath : mod;
      }
      if (state.baseUri) {
        return vscode.Uri.joinPath(state.baseUri, mod).fsPath;
      }
      return mod;
    });

    const initMessage: ExtensionMessage = {
      type: 'init',
      tuples,
      modalities: allModalities,
      modalityPaths,
      config: { thumbnailSize, prefetchCount },
      winners: winnersRecord,
      votingEnabled: state.votingEnabled,
      ppmxColormap: state.ppmxColormap
    };

    state.panel.webview.postMessage(initMessage);
    void this.generateAllThumbnails(state);
  }

  /**
   * Generate thumbnails for all images in background
   */
  private async generateAllThumbnails(state: PanelState): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const allModalities = state.scanResult.modalities;

    // Build list of all images to thumbnail (using global modality indices)
    const items: Array<{ uri: vscode.Uri; tupleIndex: number; modalityIndex: number; orientationHint?: PpmxOrientationHint }> = [];
    // Track which slots are missing (no image file)
    const missingSlots: Array<{ tupleIndex: number; modalityIndex: number }> = [];

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      const tupleOrientationHint = await this.getTupleOrientationHint(state, tupleIndex);
      
      for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
        const modality = allModalities[modalityIndex];
        const imageFile = this.findImageForModality(tuple, modality);
        
        if (imageFile) {
          items.push({
            uri: imageFile.uri,
            tupleIndex,
            modalityIndex,
            orientationHint: this.isPpmxImageFile(imageFile) ? tupleOrientationHint : undefined
          });
        } else {
          // Mark as missing - will send error immediately
          missingSlots.push({ tupleIndex, modalityIndex });
        }
      }
    }

    // Send errors for missing slots immediately
    for (const { tupleIndex, modalityIndex } of missingSlots) {
      this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, 'Image not available');
    }

    // Queue thumbnail generation for existing images
    this.thumbnailService.queueThumbnails(
      items,
      thumbnailSize * 2, // Generate at 2x for retina
      state.ppmxColormap,
      (tupleIndex, modalityIndex, dataUrl) => {
        this.sendThumbnailMessage(state, tupleIndex, modalityIndex, dataUrl);
      },
      (tupleIndex, modalityIndex, error) => {
        this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, error);
      },
      (current, total) => {
        // Adjust progress to include missing slots as already "done"
        this.sendProgressMessage(state, current + missingSlots.length, total + missingSlots.length);
      }
    );
  }

  /**
   * Send thumbnails for specific tuple indices
   */
  private async sendThumbnails(state: PanelState, tupleIndices: number[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const allModalities = state.scanResult.modalities;

    for (const tupleIndex of tupleIndices) {
      if (tupleIndex < 0 || tupleIndex >= state.scanResult.tuples.length) continue;

      const tuple = state.scanResult.tuples[tupleIndex];
      
      for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
        const modality = allModalities[modalityIndex];
        const imageFile = this.findImageForModality(tuple, modality);
        
        if (!imageFile) {
          this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, 'Image not available');
          continue;
        }
        
        try {
          const orientationHint = this.isPpmxImageFile(imageFile)
            ? await this.getTupleOrientationHint(state, tupleIndex)
            : undefined;
          const dataUrl = await this.thumbnailService.getThumbnail(
            imageFile.uri,
            thumbnailSize * 2,
            state.ppmxColormap,
            orientationHint
          );
          this.sendThumbnailMessage(state, tupleIndex, modalityIndex, dataUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, message);
        }
      }
    }
  }

  /**
   * Send a full image to the webview
   */
  private async sendImage(state: PanelState, tupleIndex: number, modalityIndex: number): Promise<void> {
    const cacheKey = this.getLoadedImageCacheKey(tupleIndex, modalityIndex, state.ppmxColormap);

    // Check cache first
    if (state.loadedImages.has(cacheKey)) {
      const cached = state.loadedImages.get(cacheKey)!;
      const tuple = state.scanResult.tuples[tupleIndex];
      const modality = state.scanResult.modalities[modalityIndex];
      const imageFile = tuple ? this.findImageForModality(tuple, modality) : undefined;
      const isPpmx = !!imageFile && path.extname(imageFile.name).toLowerCase() === '.ppmx';
      const msg: ExtensionMessage = {
        type: 'image',
        tupleIndex,
        modalityIndex,
        dataUrl: cached.dataUrl,
        width: cached.width,
        height: cached.height,
        isPpmx
      };
      state.panel.webview.postMessage(msg);
      return;
    }

    // Skip loading if user has navigated away from this tuple
    if (tupleIndex !== state.currentTupleIndex) {
      return;
    }

    // Look up image by modality
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = this.findImageForModality(tuple, modality);

    if (!imageFile) {
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
      const orientationHint = this.isPpmxImageFile(imageFile)
        ? await this.getTupleOrientationHint(state, tupleIndex)
        : undefined;
      const { dataUrl, width, height } = await this.thumbnailService.loadFullImage(
        imageFile.uri,
        state.ppmxColormap,
        orientationHint
      );
      state.loadedImages.set(cacheKey, { dataUrl, width, height });
      const isPpmx = path.extname(imageFile.name).toLowerCase() === '.ppmx';

      if (tupleIndex === state.currentTupleIndex) {
        const msg: ExtensionMessage = {
          type: 'image',
          tupleIndex,
          modalityIndex,
          dataUrl,
          width,
          height,
          isPpmx
        };
        state.panel.webview.postMessage(msg);
      }
    } catch (error) {
      if (tupleIndex === state.currentTupleIndex) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const msg: ExtensionMessage = {
          type: 'imageError',
          tupleIndex,
          modalityIndex,
          error: message
        };
        state.panel.webview.postMessage(msg);
      }
    }
  }

  /**
   * Prefetch images around the current tuple
   */
  private async prefetchAround(state: PanelState, centerIndex: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const prefetchCount = config.get<number>('prefetchCount', 3);
    const allModalities = state.scanResult.modalities;

    // Prefetch ahead and behind
    for (let offset = 0; offset <= prefetchCount; offset++) {
      const indices = offset === 0 ? [centerIndex] : [centerIndex + offset, centerIndex - offset];

      for (const tupleIndex of indices) {
        if (tupleIndex >= 0 && tupleIndex < state.scanResult.tuples.length) {
          // Iterate over all modalities (using global indices)
          for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
            const cacheKey = this.getLoadedImageCacheKey(tupleIndex, modalityIndex, state.ppmxColormap);
            if (!state.loadedImages.has(cacheKey)) {
              // Load in background (don't await)
              this.loadImageToCache(state, tupleIndex, modalityIndex);
            }
          }
        }
      }
    }

    // Evict distant tuples from memory
    this.evictDistantTuples(state, centerIndex, prefetchCount + 2);
  }

  /**
   * Load an image into cache without sending to webview
   */
  private async loadImageToCache(state: PanelState, tupleIndex: number, modalityIndex: number): Promise<void> {
    const cacheKey = this.getLoadedImageCacheKey(tupleIndex, modalityIndex, state.ppmxColormap);
    if (state.loadedImages.has(cacheKey)) return;

    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = this.findImageForModality(tuple, modality);
    
    if (!imageFile) return;

    try {
      const orientationHint = this.isPpmxImageFile(imageFile)
        ? await this.getTupleOrientationHint(state, tupleIndex)
        : undefined;
      const { dataUrl, width, height } = await this.thumbnailService.loadFullImage(
        imageFile.uri,
        state.ppmxColormap,
        orientationHint
      );
      state.loadedImages.set(cacheKey, { dataUrl, width, height });
    } catch {
      // Silently fail for prefetch
    }
  }

  /**
   * Evict images that are too far from current position
   */
  private evictDistantTuples(state: PanelState, centerIndex: number, maxDistance: number): void {
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
    const msg: ExtensionMessage = { type: 'thumbnail', tupleIndex, modalityIndex, dataUrl };
    state.panel.webview.postMessage(msg);
  }

  /**
   * Send thumbnail error message to webview
   */
  private sendThumbnailErrorMessage(state: PanelState, tupleIndex: number, modalityIndex: number, error: string): void {
    const msg: ExtensionMessage = { type: 'thumbnailError', tupleIndex, modalityIndex, error };
    state.panel.webview.postMessage(msg);
  }

  /**
   * Send progress message to webview
   */
  private sendProgressMessage(state: PanelState, current: number, total: number): void {
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
   * Set up file system watchers for a panel
   * Creates one watcher per directory to support multiple independent directories
   */
  private setupFileWatcher(state: PanelState): void {
    if (state.watchedDirs.size === 0) return;

    // Get scheme from first available image URI
    const firstUri = state.scanResult.tuples[0]?.images[0]?.uri;
    if (!firstUri) return;
    const scheme = firstUri.scheme;

    // Collect leaf directories (directories directly containing images) for fs.watch
    const leafDirs = new Set<string>();
    for (const tuple of state.scanResult.tuples) {
      for (const img of tuple.images) {
        const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
        if (dir) leafDirs.add(dir);
      }
    }

    // Create a VS Code watcher for each directory (handles create + change reliably)
    for (const dir of state.watchedDirs) {
      // Use * for leaf dirs (direct children only), **/* for parent dirs
      const glob = leafDirs.has(dir) ? '*' : '*';
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(dir).with({ scheme }),
        glob
      );

      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      // VS Code onDidDelete is unreliable on some platforms — keep as fallback
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
    }

    // Node.js fs.watch on leaf directories for reliable delete detection.
    // VS Code's onDidDelete doesn't fire on some platforms (macOS + certain filesystems).
    if (scheme === 'file') {
      for (const dir of leafDirs) {
        try {
          const fsWatcher = fs.watch(dir, (eventType, filename) => {
            this.debugMsg(state, `fs.watch event: ${eventType} ${filename} in ${dir}`);
            if (eventType === 'rename' && filename) {
              const filePath = path.join(dir, filename);
              // Brief delay: distinguish create (file will exist) from delete (file won't)
              setTimeout(() => {
                try {
                  fs.accessSync(filePath);
                  // File exists — it's a create/rename, VS Code watcher handles it
                } catch {
                  // File gone — treat as deletion
                  const fileUri = vscode.Uri.file(filePath);
                  this.debugMsg(state, `fs.watch delete: ${filePath}`);
                  this.handleFileDeleted(state, fileUri);
                }
              }, 50);
            }
          });
          fsWatcher.on('error', (err) => {
            this.debugMsg(state, `fs.watch error on ${dir}: ${err.message}`);
          });
          this.debugMsg(state, `fs.watch setup OK: ${dir}`);
          state.nodeWatchers.push(fsWatcher);
        } catch {
          // fs.watch unavailable (remote FS, permission error) — VS Code watcher only
        }
      }
    }

    // Polling-based delete detection: check all tracked files every 2 seconds.
    // This is the most reliable approach across all filesystems (Google Drive, FUSE, etc.)
    // where neither VS Code's onDidDelete nor Node.js fs.watch fire reliably.
    this.startDeletePolling(state);
  }

  /**
   * Start polling for file deletions. Checks all known image URIs periodically.
   */
  private startDeletePolling(state: PanelState): void {
    if (state.deleteCheckTimer) return; // already running

    const firstUri = state.scanResult.tuples[0]?.images[0]?.uri;
    if (!firstUri || firstUri.scheme !== 'file') return; // only poll local files

    state.deleteCheckTimer = setInterval(() => {
      // Build list of files to check from current scan result
      for (let ti = 0; ti < state.scanResult.tuples.length; ti++) {
        const tuple = state.scanResult.tuples[ti];
        for (const img of tuple.images) {
          const filePath = img.uri.fsPath;
          try {
            fs.accessSync(filePath);
          } catch {
            // File is gone — fire delete handler
            this.debugMsg(state, `poll delete detected: ${filePath}`);
            this.handleFileDeleted(state, img.uri);
          }
        }
      }
    }, 2000);
  }

  /**
   * Clean up old entries from recentlyDeleted (older than 2 seconds)
   */
  private cleanupRecentlyDeleted(state: PanelState): void {
    const now = Date.now();
    state.recentlyDeleted = state.recentlyDeleted.filter(d => now - d.timestamp < 2000);
  }

  /**
   * Handle a file being deleted
   */
  private handleFileDeleted(state: PanelState, uri: vscode.Uri): void {
    state.ppmxRawCache.clear();
    state.tupleOrientationHints.clear();
    const uriStr = uri.toString();

    // Skip if already being processed (avoids duplicate detection from polling + watcher)
    if (state.recentlyDeleted.some(d => d.uri.toString() === uriStr)) return;

    // Check if this is a modality directory being deleted
    const deletedPath = uri.path;
    const modalityIndex = state.scanResult.modalities.findIndex(modality => {
      // Mode 1: Check against baseUri + modality name
      if (state.baseUri) {
        const modalityPath = vscode.Uri.joinPath(state.baseUri, modality).path;
        if (deletedPath === modalityPath) return true;
      }
      // Mode 2: Check against modalityDirs mapping
      const modalityUri = state.modalityDirs.get(modality);
      if (modalityUri && deletedPath === modalityUri.path) return true;
      return false;
    });
    
    if (modalityIndex >= 0) {
      // A modality directory was deleted
      this.removeModality(state, modalityIndex);
      return;
    }
    
    // Find which tuple/modality this file belongs to
    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (let modIdx = 0; modIdx < tuple.images.length; modIdx++) {
        if (tuple.images[modIdx].uri.toString() === uriStr) {
          // Use the global modality index (not the array position)
          const modalityName = tuple.images[modIdx].modality;
          const globalModIdx = state.scanResult.modalities.indexOf(modalityName);

          // Found the deleted file - track it for potential rename detection
          // Capture tuple reference so we can find it even after index shifts
          const capturedTuple = tuple;
          this.cleanupRecentlyDeleted(state);
          state.recentlyDeleted.push({
            uri,
            tupleIndex,
            modalityIndex: globalModIdx,
            timestamp: Date.now()
          });

          // Remove from loaded images cache
          this.clearLoadedImageCacheForSlot(state, tupleIndex, globalModIdx);

          // Wait a short time to see if this is a rename (create will follow quickly)
          setTimeout(() => {
            // Resolve current tuple index (may have shifted due to insertions)
            const currentTupleIndex = state.scanResult.tuples.indexOf(capturedTuple);
            if (currentTupleIndex < 0) return; // tuple already removed

            // Check if this file was "resurrected" (renamed to new location)
            const stillDeleted = state.recentlyDeleted.some(
              d => d.tupleIndex === currentTupleIndex && d.modalityIndex === globalModIdx
            );

            if (stillDeleted) {
              // Remove from recentlyDeleted
              state.recentlyDeleted = state.recentlyDeleted.filter(
                d => !(d.tupleIndex === currentTupleIndex && d.modalityIndex === globalModIdx)
              );

              // Remove the image from the tuple
              capturedTuple.images = capturedTuple.images.filter(img => img.modality !== modalityName);

              // Clear winner if it pointed to the deleted modality
              if (state.winners.get(currentTupleIndex) === globalModIdx) {
                state.winners.delete(currentTupleIndex);
                state.panel.webview.postMessage({
                  type: 'winnerUpdated',
                  tupleIndex: currentTupleIndex,
                  modalityIndex: null
                } as ExtensionMessage);
              }

              if (capturedTuple.images.length === 0) {
                // All images deleted - remove the tuple entirely
                this.removeTuple(state, currentTupleIndex);
              } else {
                // Notify webview of the deleted file
                const msg: ExtensionMessage = {
                  type: 'fileDeleted',
                  tupleIndex: currentTupleIndex,
                  modalityIndex: globalModIdx
                };
                state.panel.webview.postMessage(msg);

                // Persist updated winners
                if (state.votingEnabled) {
                  this.saveResults(state);
                }
              }

              // Check if all files for this modality are now gone
              if (globalModIdx >= 0) {
                this.checkModalityEmpty(state, globalModIdx);
              }
            }
          }, 500); // Wait 500ms to see if it's a rename

          return;
        }
      }
    }
  }

  /**
   * Remove a tuple entirely and notify webview
   */
  private removeTuple(state: PanelState, tupleIndex: number): void {
    state.scanResult.tuples.splice(tupleIndex, 1);
    state.tupleOrientationHints.clear();

    // Re-index loadedImages cache
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

    // Re-index winners
    const newWinners = new Map<number, number>();
    for (const [tIdx, mIdx] of state.winners) {
      if (tIdx > tupleIndex) {
        newWinners.set(tIdx - 1, mIdx);
      } else if (tIdx < tupleIndex) {
        newWinners.set(tIdx, mIdx);
      }
    }
    state.winners = newWinners;

    // Re-index recentlyDeleted
    state.recentlyDeleted = state.recentlyDeleted
      .filter(d => d.tupleIndex !== tupleIndex)
      .map(d => d.tupleIndex > tupleIndex ? { ...d, tupleIndex: d.tupleIndex - 1 } : d);

    // Adjust currentTupleIndex
    if (state.currentTupleIndex >= state.scanResult.tuples.length) {
      state.currentTupleIndex = Math.max(0, state.scanResult.tuples.length - 1);
    } else if (state.currentTupleIndex > tupleIndex) {
      state.currentTupleIndex--;
    }

    // Notify webview
    const msg: ExtensionMessage = { type: 'tupleDeleted', tupleIndex };
    state.panel.webview.postMessage(msg);

    // Persist updated winners
    if (state.votingEnabled) {
      this.saveResults(state);
    }
  }

  /**
   * Check if a modality has no more files and should be removed
   */
  private checkModalityEmpty(state: PanelState, modalityIndex: number): void {
    const modality = state.scanResult.modalities[modalityIndex];
    if (!modality) return;
    
    // Check if any tuple still has a file for this modality
    const hasFiles = state.scanResult.tuples.some(tuple => 
      tuple.images.some(img => img.modality === modality)
    );
    
    if (!hasFiles) {
      this.removeModality(state, modalityIndex);
    }
  }

  /**
   * Remove a modality from the state and notify webview
   */
  private async removeModality(state: PanelState, modalityIndex: number): Promise<void> {
    const modality = state.scanResult.modalities[modalityIndex];
    state.tupleOrientationHints.clear();

    // Remove from modalities list
    state.scanResult.modalities.splice(modalityIndex, 1);

    // Remove images for this modality from all tuples
    for (const tuple of state.scanResult.tuples) {
      tuple.images = tuple.images.filter(img => img.modality !== modality);
    }

    // Clear loaded images cache (indices have changed)
    state.loadedImages.clear();

    // Update winners - shift modality indices for winners pointing to modalities after the removed one
    const newWinners = new Map<number, number>();
    for (const [tupleIndex, winnerModalityIndex] of state.winners) {
      if (winnerModalityIndex === modalityIndex) {
        // This winner was for the removed modality - remove it
        continue;
      } else if (winnerModalityIndex > modalityIndex) {
        // Shift index down
        newWinners.set(tupleIndex, winnerModalityIndex - 1);
      } else {
        // Keep as-is
        newWinners.set(tupleIndex, winnerModalityIndex);
      }
    }
    state.winners = newWinners;

    // Notify webview
    const msg: ExtensionMessage = {
      type: 'modalityRemoved',
      modalityIndex
    };
    state.panel.webview.postMessage(msg);

    // Save updated results
    if (state.votingEnabled) {
      await this.saveResults(state);
    }
  }

  /**
   * Handle a file being created (could be new file, rename, or restoration)
   */
  private handleFileCreated(state: PanelState, uri: vscode.Uri): void {
    state.ppmxRawCache.clear();
    state.tupleOrientationHints.clear();
    // Check if this is an image file
    const filename = uri.path.split('/').pop() || '';
    if (!isImageFile(filename)) return;

    this.cleanupRecentlyDeleted(state);

    // First, check if this file restores an existing slot (exact URI match)
    const restoredSlot = this.findExistingSlotByUri(state, uri);
    if (restoredSlot) {
      const { tupleIndex, modalityIndex } = restoredSlot;
      
      // Clear cached data
      this.clearLoadedImageCacheForSlot(state, tupleIndex, modalityIndex);
      
      // Generate new thumbnail
      this.regenerateThumbnail(state, tupleIndex, modalityIndex);
      
      // Notify webview that file was restored
      const msg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex,
        modalityIndex
      };
      state.panel.webview.postMessage(msg);
      
      // If currently viewing this image, reload it
      if (tupleIndex === state.currentTupleIndex) {
        this.sendImage(state, tupleIndex, modalityIndex);
      }
      
      return;
    }

    // Check if this could be a rename of a recently deleted file
    // Try to match by filename pattern
    const deletedMatch = this.findMatchingDeletedFile(state, uri);
    
    if (deletedMatch) {
      // This is likely a rename - update the URI in place
      const { tupleIndex, modalityIndex } = deletedMatch;
      const tuple = state.scanResult.tuples[tupleIndex];
      // Look up image by modality name (modalityIndex is global, not array position)
      const modality = state.scanResult.modalities[modalityIndex];
      const img = tuple.images.find(i => i.modality === modality);
      if (img) {
        img.uri = uri;
        img.name = filename;
      }
      
      // Remove from recently deleted (it was a rename, not a delete)
      state.recentlyDeleted = state.recentlyDeleted.filter(
        d => !(d.tupleIndex === tupleIndex && d.modalityIndex === modalityIndex)
      );
      
      // Clear old cached data and reload
      this.clearLoadedImageCacheForSlot(state, tupleIndex, modalityIndex);
      
      // Generate new thumbnail
      this.regenerateThumbnail(state, tupleIndex, modalityIndex);
      
      // Notify webview (treat as restore since file is now available)
      const msg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex,
        modalityIndex
      };
      state.panel.webview.postMessage(msg);
      
      // If currently viewing this image, reload it
      if (tupleIndex === state.currentTupleIndex) {
        this.sendImage(state, tupleIndex, modalityIndex);
      }
      
      return;
    }

    // Not a rename or restore - try to add as a new file
    this.handleNewFile(state, uri, filename);
  }

  /**
   * Find an existing slot in tuples that matches this URI exactly
   */
  private findExistingSlotByUri(state: PanelState, uri: vscode.Uri): { tupleIndex: number; modalityIndex: number } | undefined {
    const uriStr = uri.toString();

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (const img of tuple.images) {
        if (img.uri.toString() === uriStr) {
          // Return the global modality index, not the array position
          const globalModIdx = state.scanResult.modalities.indexOf(img.modality);
          return { tupleIndex, modalityIndex: globalModIdx };
        }
      }
    }

    return undefined;
  }

  /**
   * Find a recently deleted file that matches the new file (for rename detection)
   */
  private findMatchingDeletedFile(state: PanelState, newUri: vscode.Uri): DeletedFileInfo | undefined {
    const newFilename = newUri.path.split('/').pop() || '';
    const newDir = newUri.path.substring(0, newUri.path.lastIndexOf('/'));
    
    // Try to find a deleted file in the same modality directory with similar name
    for (const deleted of state.recentlyDeleted) {
      const deletedDir = deleted.uri.path.substring(0, deleted.uri.path.lastIndexOf('/'));
      
      // Same directory = same modality, likely a rename
      if (newDir === deletedDir) {
        return deleted;
      }
      
      // Check if directories are sibling modalities under same parent
      const newParent = newDir.substring(0, newDir.lastIndexOf('/'));
      const deletedParent = deletedDir.substring(0, deletedDir.lastIndexOf('/'));
      
      if (newParent === deletedParent && state.scanResult.isMultiTupleMode) {
        // Same parent, different modality directories
        // Check if filenames match (common for batch renames)
        const deletedFilename = deleted.uri.path.split('/').pop() || '';
        if (newFilename === deletedFilename) {
          return deleted;
        }
      }
    }
    
    return undefined;
  }

  /**
   * Handle a genuinely new file (not a rename)
   * Works for both mode 1 (single directory with subdirs) and mode 2 (multiple directories)
   */
  private async handleNewFile(state: PanelState, uri: vscode.Uri, filename: string): Promise<void> {
    // Only handle multi-tuple mode
    if (!state.scanResult.isMultiTupleMode) {
      return;
    }

    const filePath = uri.path;
    let modalityName: string | undefined;

    // Mode 1: Single directory with subdirectories
    if (state.baseUri) {
      const basePath = state.baseUri.path;
      
      if (!filePath.startsWith(basePath)) {
        return;
      }

      // Extract modality from path (first subdirectory after base)
      const relativePath = filePath.substring(basePath.length + 1);
      const parts = relativePath.split('/');
      
      if (parts.length < 2) {
        // File directly in base dir, not in a modality subdirectory
        return;
      }

      modalityName = parts[0];
    }
    // Mode 2: Multiple directories selected
    else if (state.modalityDirs.size > 0) {
      // Find which modality directory this file belongs to
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
    // Mode 3: Multiple files - no directory structure to add to
    else {
      return;
    }

    let modalityIndex = state.scanResult.modalities.indexOf(modalityName!);
    
    // Check if this is a NEW modality directory
    if (modalityIndex === -1) {
      // New modality! Add it to the list
      modalityIndex = await this.addNewModality(state, modalityName);
      if (modalityIndex === -1) {
        return;
      }
    }

    // Try to find an existing tuple this file should belong to
    // by matching filename pattern with other tuples
    const baseFilename = filename.replace(/\.[^.]+$/, ''); // Remove extension
    
    // Find best matching tuple using longest-match-wins strategy.
    // Score each tuple by how specifically its name matches the new filename.
    // A longer matching name is more specific (e.g. "img001_crop01" beats "img001").
    // Among tuples at the same match length, prefer one with a free modality slot.
    // If the best match group has no free slot, create a new tuple instead of
    // falling back to a shorter (less specific) match.
    let matchingTupleIndex = -1;
    let bestMatchLen = -1;
    let bestSlotFree = false;

    for (let i = 0; i < state.scanResult.tuples.length; i++) {
      const tuple = state.scanResult.tuples[i];
      let matchLen = -1;

      // Check if tuple name is a substring of the new filename
      if (tuple.name && baseFilename.includes(tuple.name)) {
        matchLen = tuple.name.length;
      }

      // Exact basename match with an existing image in the tuple scores
      // the full baseFilename length (highest possible)
      for (const img of tuple.images) {
        const imgBase = img.name.replace(/\.[^.]+$/, '');
        if (imgBase === baseFilename) {
          matchLen = baseFilename.length;
          break;
        }
      }

      if (matchLen < 0) continue; // no match at all

      const slotFree = !tuple.images.find(img => img.modality === modalityName);

      if (matchLen > bestMatchLen) {
        // Longer match always wins — it's more specific
        matchingTupleIndex = i;
        bestMatchLen = matchLen;
        bestSlotFree = slotFree;
      } else if (matchLen === bestMatchLen && slotFree && !bestSlotFree) {
        // Same specificity but this one has a free slot — prefer it
        matchingTupleIndex = i;
        bestSlotFree = slotFree;
      }
    }

    // Only use the match if the modality slot is actually free;
    // otherwise create a new tuple (don't fall back to a less specific match)
    if (!bestSlotFree) {
      matchingTupleIndex = -1;
    }

    if (matchingTupleIndex >= 0) {
      // Add to existing tuple (we already verified the modality slot is free)
      const tuple = state.scanResult.tuples[matchingTupleIndex];
      tuple.images.push({
        uri,
        name: filename,
        modality: modalityName
      });

      // Sort images by modality order
      tuple.images.sort((a, b) =>
        state.scanResult.modalities.indexOf(a.modality) -
        state.scanResult.modalities.indexOf(b.modality)
      );

      // Regenerate thumbnail
      this.regenerateThumbnail(state, matchingTupleIndex, modalityIndex);

      // Notify webview that the slot is now filled (so it can re-render / clear spinner)
      // Include imageInfo so the webview can update its tuple data if the slot was unknown
      const restoredMsg: ExtensionMessage = {
        type: 'fileRestored',
        tupleIndex: matchingTupleIndex,
        modalityIndex,
        imageInfo: {
          name: filename,
          modality: modalityName,
          tupleIndex: matchingTupleIndex,
          modalityIndex
        }
      };
      state.panel.webview.postMessage(restoredMsg);
    }
    if (matchingTupleIndex < 0) {
      // Create a new tuple with just this one file
      // (Other modalities for this tuple might come later)
      const newTuple = {
        name: baseFilename,
        images: [{
          uri,
          name: filename,
          modality: modalityName
        }]
      };
      
      // Insert right after the current tuple (instead of appending at end)
      const insertIndex = state.currentTupleIndex + 1;
      state.scanResult.tuples.splice(insertIndex, 0, newTuple);
      const newTupleIndex = insertIndex;

      // Re-index loadedImages cache (shift keys at or above insertIndex up by 1)
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

      // Re-index winners (shift tuple indices at or above insertIndex up by 1)
      const newWinners = new Map<number, number>();
      for (const [tIdx, mIdx] of state.winners) {
        if (tIdx >= insertIndex) {
          newWinners.set(tIdx + 1, mIdx);
        } else {
          newWinners.set(tIdx, mIdx);
        }
      }
      state.winners = newWinners;

      // Re-index recentlyDeleted (shift tuple indices at or above insertIndex up by 1)
      for (const d of state.recentlyDeleted) {
        if (d.tupleIndex >= insertIndex) {
          d.tupleIndex++;
        }
      }

      // Adjust currentTupleIndex since we inserted before it
      if (state.currentTupleIndex >= insertIndex) {
        state.currentTupleIndex++;
      }
      
      // Notify webview of new tuple — include ALL modalities (matching sendInitData format)
      const tupleInfo: TupleInfo = {
        name: newTuple.name,
        images: state.scanResult.modalities.map((modality, mIdx) => {
          const img = this.findImageForModality(newTuple, modality);
          return {
            name: img?.name || '',
            modality,
            tupleIndex: newTupleIndex,
            modalityIndex: mIdx
          };
        })
      };

      const msg: ExtensionMessage = {
        type: 'tupleAdded',
        tuple: tupleInfo,
        tupleIndex: newTupleIndex
      };
      state.panel.webview.postMessage(msg);

      // Generate thumbnail for the modality that was just added
      const addedModalityIndex = state.scanResult.modalities.indexOf(modalityName);
      this.regenerateThumbnail(state, newTupleIndex, addedModalityIndex);
    }
  }

  /**
   * Add a new modality to the scan result
   * Returns the new modality index, or -1 on failure
   */
  private async addNewModality(state: PanelState, modalityName: string): Promise<number> {
    state.tupleOrientationHints.clear();
    // Add to modalities list (sorted alphabetically to maintain order)
    const modalities = state.scanResult.modalities;

    // Find insertion point to keep sorted
    let insertIndex = modalities.length;
    for (let i = 0; i < modalities.length; i++) {
      if (modalityName.localeCompare(modalities[i]) < 0) {
        insertIndex = i;
        break;
      }
    }

    // Insert the new modality
    modalities.splice(insertIndex, 0, modalityName);

    // CRITICAL: Clear the loaded images cache - indices have changed!
    // Old cache entries like "0-2" no longer map to the same modality
    state.loadedImages.clear();

    // Update winners - shift modality indices for winners pointing to modalities at or after insertIndex
    const newWinners = new Map<number, number>();
    for (const [tupleIndex, winnerModalityIndex] of state.winners) {
      if (winnerModalityIndex >= insertIndex) {
        // Shift index up
        newWinners.set(tupleIndex, winnerModalityIndex + 1);
      } else {
        // Keep as-is
        newWinners.set(tupleIndex, winnerModalityIndex);
      }
    }
    state.winners = newWinners;

    // Update all existing tuples to have a placeholder for this modality
    // (They'll be filled in when files arrive)
    for (const tuple of state.scanResult.tuples) {
      // The images array may need to be reordered to match new modality order
      tuple.images.sort((a, b) =>
        modalities.indexOf(a.modality) - modalities.indexOf(b.modality)
      );
    }

    // Add the directory to watched dirs
    if (state.baseUri) {
      const newDir = vscode.Uri.joinPath(state.baseUri, modalityName).path;
      state.watchedDirs.add(newDir);
    }

    // Notify webview of new modality
    const msg: ExtensionMessage = {
      type: 'modalityAdded',
      modality: modalityName,
      modalityIndex: insertIndex
    };
    state.panel.webview.postMessage(msg);

    // Save updated results (winner indices may have changed)
    if (state.votingEnabled && state.winners.size > 0) {
      await this.saveResults(state);
    }

    return insertIndex;
  }

  /**
   * Handle a file content change (re-load the image)
   */
  private handleFileChanged(state: PanelState, uri: vscode.Uri): void {
    state.ppmxRawCache.clear();
    state.tupleOrientationHints.clear();
    const uriStr = uri.toString();
    
    // Find which tuple/modality this file belongs to
    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (const imageFile of tuple.images) {
        if (imageFile.uri.toString() !== uriStr) continue;

        const globalModalityIndex = state.scanResult.modalities.indexOf(imageFile.modality);
        if (globalModalityIndex < 0) return;

        // Clear cached data
        this.clearLoadedImageCacheForSlot(state, tupleIndex, globalModalityIndex);

        // Regenerate thumbnail
        this.regenerateThumbnail(state, tupleIndex, globalModalityIndex);

        // If currently viewing this image, reload it
        if (tupleIndex === state.currentTupleIndex) {
          this.sendImage(state, tupleIndex, globalModalityIndex);
        }

        return;
      }
    }
  }

  /**
   * Regenerate thumbnail for a specific image
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

  private async regenerateThumbnail(state: PanelState, tupleIndex: number, modalityIndex: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    
    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    if (!tuple || !modality) return;

    const imageFile = this.findImageForModality(tuple, modality);
    if (!imageFile) {
      this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, 'Image not available');
      return;
    }
    
    try {
      const orientationHint = this.isPpmxImageFile(imageFile)
        ? await this.getTupleOrientationHint(state, tupleIndex)
        : undefined;
      const dataUrl = await this.thumbnailService.getThumbnail(
        imageFile.uri,
        thumbnailSize * 2,
        state.ppmxColormap,
        orientationHint
      );
      this.sendThumbnailMessage(state, tupleIndex, modalityIndex, dataUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendThumbnailErrorMessage(state, tupleIndex, modalityIndex, message);
    }
  }

  dispose(): void {
    // Dispose all open panels
    for (const state of this.panels) {
      state.panel.dispose();
      state.loadedImages.clear();
      state.fileWatchers.forEach(w => w.dispose());
      state.nodeWatchers.forEach(w => w.close());
      if (state.deleteCheckTimer) clearInterval(state.deleteCheckTimer);
    }
    this.panels.clear();
    this.thumbnailService.clearMemoryCache();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Derive a meaningful title for the panel
   */
  private deriveTitle(scanResult: ScanResult, uris: vscode.Uri[]): string {
    const MAX_LENGTH = 40;
    this.panelCounter++;

    // Generic names that shouldn't be used as titles
    const GENERIC_NAMES = new Set([
      'image', 'images', 'img', 'imgs', 'photo', 'photos', 'pic', 'pics', 'picture', 'pictures',
      'file', 'files', 'folder', 'folders', 'dir', 'directory', 'directories',
      'data', 'output', 'input', 'result', 'results', 'test', 'tests', 'tmp', 'temp',
      'new', 'old', 'copy', 'backup', 'untitled', 'unnamed'
    ]);

    const isGenericName = (name: string): boolean => {
      const lower = name.toLowerCase().replace(/[\s_\-./\\0-9]+/g, '');
      return GENERIC_NAMES.has(lower) || lower.length < 2;
    };

    const truncate = (str: string): string => {
      return str.length > MAX_LENGTH ? str.slice(0, MAX_LENGTH - 1) + '…' : str;
    };

    const findCommonPrefix = (names: string[]): string => {
      if (names.length === 0) return '';
      let commonPrefix = names[0];
      for (let i = 1; i < names.length && commonPrefix.length > 0; i++) {
        while (commonPrefix.length > 0 && !names[i].startsWith(commonPrefix)) {
          commonPrefix = commonPrefix.slice(0, -1);
        }
      }
      // Clean up trailing separators
      return commonPrefix.replace(/[\s_\-./\\]+$/, '').trim();
    };

    // Mode 3: Multiple files selected (not multi-tuple mode, uris are files)
    if (!scanResult.isMultiTupleMode && uris.length > 1) {
      const fileNames = uris.map(u => u.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '');
      const commonPrefix = findCommonPrefix(fileNames);
      
      if (commonPrefix.length >= 3 && !isGenericName(commonPrefix)) {
        return `Compare: ${truncate(commonPrefix)}`;
      }
      return `Compare: ${uris.length} files`;
    }

    // Mode 2: Multiple directories selected
    if (uris.length > 1) {
      const dirNames = uris.map(u => u.path.split('/').pop() || '');
      const commonPrefix = findCommonPrefix(dirNames);
      
      if (commonPrefix.length >= 3 && !isGenericName(commonPrefix)) {
        return `Compare: ${truncate(commonPrefix)}`;
      }
      return `Compare: ${uris.length} directories`;
    }

    // Mode 1: Single directory - try tuple names first, then fall back to dir name
    if (scanResult.tuples.length > 0) {
      const tupleNames = scanResult.tuples.map(t => t.name).filter(n => n && n !== 'Untitled');
      if (tupleNames.length > 0) {
        const commonPrefix = findCommonPrefix(tupleNames);
        
        if (commonPrefix.length >= 3 && !isGenericName(commonPrefix)) {
          return `Compare: ${truncate(commonPrefix)}`;
        }
      }
    }

    // Fallback to folder name from URI
    if (uris.length > 0) {
      const folderName = uris[0].path.split('/').pop() || '';
      if (folderName.length >= 2 && !isGenericName(folderName)) {
        return `Compare: ${truncate(folderName)}`;
      }
    }

    // Final fallback - use counter
    return `Compare: ${this.panelCounter}`;
  }
}
