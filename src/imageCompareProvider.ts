import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { scanForImages, readResultsFile, writeResultsFile, mapWinnersToIndices, disambiguateDirectoryNames } from './fileService';
import { ThumbnailService } from './thumbnailService';
import { parsePpmx } from './ppmxParser';
import {
  ScanResult,
  TupleInfo,
  ImageTuple,
  ImageFile,
  WebViewMessage,
  ExtensionMessage,
  LoadedImage,
  isImageFile
} from './types';

/**
 * Info about a recently deleted file (for rename detection)
 */
interface DeletedFileInfo {
  uri: vscode.Uri;
  tupleIndex: number;
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
        pendingDebugMessages: []
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

      case 'deleteTuple':
        await this.handleDeleteTuple(state, message.tupleIndex);
        break;

      case 'exportPptx':
        await this.handleExportPptx(state, message.tupleIndices, message.winnerModalityIndices, message.modalityOrder);
        break;

      case 'log':
        // WebView debug messages (disabled in production)
        break;
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
      const loadImageBase64 = async (uri: vscode.Uri): Promise<{ data: string; width: number; height: number } | null> => {
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

      // Scale relative crop rect to this modality's actual dimensions
      const meta = await this.thumbnailService.getImageDimensions(imageFile.uri);
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

      const croppedBuffer = await this.thumbnailService.cropImage(imageFile.uri, scaledRect, meta.width, meta.height);
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
      votingEnabled: state.votingEnabled
    };

    state.panel.webview.postMessage(initMessage);
    this.generateAllThumbnails(state);
  }

  /**
   * Generate thumbnails for all images in background
   */
  private generateAllThumbnails(state: PanelState): void {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const thumbnailSize = config.get<number>('thumbnailSize', 100);
    const allModalities = state.scanResult.modalities;

    // Build list of all images to thumbnail (using global modality indices)
    const items: Array<{ uri: vscode.Uri; tupleIndex: number; modalityIndex: number }> = [];
    // Track which slots are missing (no image file)
    const missingSlots: Array<{ tupleIndex: number; modalityIndex: number }> = [];

    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      
      for (let modalityIndex = 0; modalityIndex < allModalities.length; modalityIndex++) {
        const modality = allModalities[modalityIndex];
        const imageFile = this.findImageForModality(tuple, modality);
        
        if (imageFile) {
          items.push({
            uri: imageFile.uri,
            tupleIndex,
            modalityIndex
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
          const dataUrl = await this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2);
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
    const cacheKey = `${tupleIndex}-${modalityIndex}`;

    // Check cache first
    if (state.loadedImages.has(cacheKey)) {
      const cached = state.loadedImages.get(cacheKey)!;
      const msg: ExtensionMessage = {
        type: 'image',
        tupleIndex,
        modalityIndex,
        dataUrl: cached.dataUrl,
        width: cached.width,
        height: cached.height
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
      const { dataUrl, width, height } = await this.thumbnailService.loadFullImage(imageFile.uri);
      state.loadedImages.set(cacheKey, { dataUrl, width, height });

      if (tupleIndex === state.currentTupleIndex) {
        const msg: ExtensionMessage = {
          type: 'image',
          tupleIndex,
          modalityIndex,
          dataUrl,
          width,
          height
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
            const cacheKey = `${tupleIndex}-${modalityIndex}`;
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
    const cacheKey = `${tupleIndex}-${modalityIndex}`;
    if (state.loadedImages.has(cacheKey)) return;

    const tuple = state.scanResult.tuples[tupleIndex];
    const modality = state.scanResult.modalities[modalityIndex];
    const imageFile = this.findImageForModality(tuple, modality);
    
    if (!imageFile) return;

    try {
      const { dataUrl, width, height } = await this.thumbnailService.loadFullImage(imageFile.uri);
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>ImageCompare</title>
  <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--vscode-editor-background, #1a1a1a);
  color: var(--vscode-editor-foreground, #fff);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground, #888);
}
#loading.hidden { display: none; }

#viewer {
  display: none;
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
}
#viewer.active { display: block; }
#viewer.dragging { cursor: grabbing; }

#canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

#image-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  z-index: 5;
  pointer-events: none;
}
#image-loader.active { display: flex; }
#viewer.has-carousel #image-loader {
  left: calc(50% + var(--carousel-offset, 0px) / 2);
}
#loader-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--vscode-editor-background, #333);
  border-top-color: var(--vscode-textLink-foreground, #0af);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
#canvas.preview {
  opacity: 0.5;
  filter: blur(2px);
}

/* Floating panel (navigator + crop) */
#floating-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid var(--vscode-panel-border, #444);
  border-radius: 6px;
  z-index: 20;
  min-width: 160px;
  max-width: 168px;
  user-select: none;
}
#fp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1px 6px;
  cursor: pointer;
  background: rgba(255,255,255,0.18);
  border-radius: 6px 6px 0 0;
  font-size: 11px;
  font-weight: 600;
  color: #ccc;
  letter-spacing: 0.3px;
}
#fp-collapse-btn {
  cursor: pointer;
  font-size: 18px;
  padding: 0 2px;
  line-height: 1;
  color: #fff;
}
#fp-body { padding: 4px; }
#floating-panel.collapsed #fp-body { display: none; }
#floating-panel.collapsed { min-width: auto; }
#floating-panel.collapsed #fp-header { border-radius: 6px; }
#fp-minimap {
  position: relative;
  margin-bottom: 4px;
}
#thumb-canvas {
  display: block;
  margin: 0 auto;
  max-width: 160px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
#thumb-viewport {
  position: absolute;
  border: 2px solid #f0f;
  pointer-events: none;
  box-sizing: border-box;
  display: none;
}
#fp-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
#crop-btn {
  padding: 3px 8px;
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
#crop-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
#crop-btn.active {
  background: var(--vscode-button-background, #0078d4);
  color: var(--vscode-button-foreground, #fff);
}
#delete-btn, #pptx-btn {
  padding: 3px 8px;
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
#delete-btn:hover { background: #a33; }
#pptx-btn:hover { background: #383; }

/* Crop overlay */
#crop-overlay {
  position: absolute;
  inset: 0;
  z-index: 15;
  cursor: crosshair;
}
.crop-dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.crop-rect {
  position: absolute;
  border: 2px solid #0f0;
  box-sizing: border-box;
  pointer-events: none;
}
.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 1px solid #333;
  border-radius: 2px;
  z-index: 16;
}
.crop-toolbar {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  z-index: 16;
}
.crop-toolbar-btn {
  padding: 3px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.crop-confirm {
  background: #2ea043;
  color: #fff;
}
.crop-confirm:hover { background: #3fb950; }
.crop-cancel {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
}
.crop-cancel:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }

#info {
  background: var(--vscode-sideBar-background, #2a2a2a);
  padding: 6px 12px;
  display: flex;
  align-items: center;
  font-size: 13px;
  flex-shrink: 0;
  min-height: 36px;
  gap: 12px;
  border-top: 1px solid var(--vscode-panel-border, #333);
}
#info.hidden { display: none; }

#modality-selector {
  display: flex;
  gap: 2px 4px;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  min-width: 0;
}

#status {
  color: var(--vscode-descriptionForeground, #888);
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  line-height: 1.2;
}
#status-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
#status-info {
  flex-shrink: 0;
  white-space: nowrap;
}

.modality-btn {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s;
  border: none;
  color: #000;
  user-select: none;
  position: relative;
  flex-shrink: 0;
  white-space: nowrap;
}
.modality-btn:hover { transform: scale(1.05); }
.modality-btn.active {
  opacity: 1;
  box-shadow: 0 0 0 2px var(--vscode-focusBorder, #fff);
}
.modality-btn.inactive { opacity: 0.4; }

#reorder-buttons {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  align-items: center;
}
.reorder-btn {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.reorder-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
.reorder-btn:disabled { opacity: 0.3; cursor: default; }

#help-btn {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 50%;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
#help-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }

#progress-container {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--vscode-notifications-background, rgba(0, 0, 0, 0.8));
  border: 1px solid var(--vscode-panel-border, #444);
  border-radius: 8px;
  padding: 12px 20px;
  z-index: 50;
  display: none;
  min-width: 250px;
  text-align: center;
}
#progress-container.active { display: block; }
#progress-text {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #aaa);
}
#progress-bar {
  width: 100%;
  height: 6px;
  background: var(--vscode-progressBar-background, #333);
  border-radius: 3px;
  overflow: hidden;
}
#progress-fill {
  height: 100%;
  background: var(--vscode-progressBar-background, #0af);
  width: 0%;
  transition: width 0.1s;
}

/* Carousel styles */
#carousel {
  display: none;
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--vscode-sideBar-background, rgba(0, 0, 0, 0.85));
  border-right: 1px solid var(--vscode-panel-border, #333);
  overflow-y: overlay;
  overflow-x: hidden;
  z-index: 10;
}
#carousel.active { display: block; }
#carousel::-webkit-scrollbar { width: 6px; }
#carousel::-webkit-scrollbar-track { background: transparent; }
#carousel::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
  transition: background 0.3s;
}
#carousel:hover::-webkit-scrollbar-thumb,
#carousel.scrolling::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-activeBackground, #444);
}

.carousel-row {
  display: flex;
  gap: 2px;
  padding: 4px 6px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-panel-border, #222);
  transition: background 0.15s;
}
.carousel-row:hover { background: rgba(255, 255, 255, 0.05); }
.carousel-row.current { background: rgba(255, 255, 255, 0.1); }

.carousel-thumb {
  object-fit: contain;
  background: #111;
  border-radius: 3px;
  border: 2px solid transparent;
  transition: border-color 0.15s, opacity 0.15s;
  opacity: 0.6;
  flex-shrink: 0;
}
.carousel-thumb:hover { opacity: 1; }
.carousel-thumb.active { opacity: 1; }
.carousel-thumb.selected { border-color: #f0f; }
.carousel-thumb.placeholder {
  background: var(--vscode-input-background, #333);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground, #666);
  font-size: 10px;
}
.carousel-thumb.missing {
  opacity: 0.5;
  filter: grayscale(1);
}
.carousel-thumb.missing.selected {
  filter: grayscale(1) drop-shadow(0 0 2px #f0f);
  opacity: 0.8;
}
.carousel-thumb.selected {
  outline: 2px solid #f0f;
  outline-offset: -2px;
}

/* Winner voting indicators */
.carousel-thumb-container {
  position: relative;
}
.winner-circle {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 7px;
  height: 7px;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: all 0.15s;
  z-index: 5;
}
.winner-circle:hover {
  background: rgba(255, 255, 255, 0.4);
  border-color: rgba(255, 255, 255, 0.6);
}
.winner-circle.winner {
  background: #0f0;
  border-color: #fff;
  box-shadow: 0 0 3px rgba(0, 255, 0, 0.5);
}
.winner-circle.winner:hover {
  background: #0c0;
  border-color: #fff;
}

#carousel-resize {
  display: none;
  position: absolute;
  left: 216px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  background: transparent;
  z-index: 11;
}
#carousel-resize.active { display: block; }
#carousel-resize:hover,
#carousel-resize.dragging { background: var(--vscode-focusBorder, rgba(0, 170, 255, 0.3)); }

#help-modal {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.8);
  align-items: center;
  justify-content: center;
  z-index: 100;
}
#help-modal.active { display: flex; }
.modal-content {
  background: var(--vscode-notifications-background, #2a2a2a);
  padding: 30px;
  border-radius: 12px;
  text-align: center;
  max-width: 450px;
  border: 1px solid var(--vscode-panel-border, #444);
}
.modal-content h3 {
  color: var(--vscode-textLink-foreground, #0af);
  margin-bottom: 15px;
}
.modal-content table {
  width: 100%;
  text-align: left;
  border-collapse: collapse;
}
.modal-content td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.modal-content td:first-child {
  color: var(--vscode-textLink-foreground, #0af);
  font-family: monospace;
  white-space: nowrap;
}
.btn {
  padding: 10px 24px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.btn-primary {
  background: var(--vscode-button-background, #0af);
  color: var(--vscode-button-foreground, #000);
}
.btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div id="loading">Loading images...</div>

  <div id="viewer">
    <div id="carousel"></div>
    <div id="carousel-resize"></div>
    <div id="progress-container">
      <div id="progress-text">Loading thumbnails...</div>
      <div id="progress-bar"><div id="progress-fill"></div></div>
    </div>
    <canvas id="canvas"></canvas>
    <div id="image-loader">
      <div id="loader-spinner"></div>
    </div>
    <div id="floating-panel">
      <div id="fp-header">
        <span id="fp-title">Tools</span>
        <span id="fp-collapse-btn">&#9662;</span>
      </div>
      <div id="fp-body">
        <div id="fp-minimap">
          <canvas id="thumb-canvas" width="160" height="100"></canvas>
          <div id="thumb-viewport"></div>
        </div>
        <div id="fp-actions">
          <button id="crop-btn" title="Crop all modalities (C)">Crop</button>
          <button id="delete-btn" title="Delete current tuple files (Del)">Delete</button>
          <button id="pptx-btn" title="Export voted tuples to PPTX">PPTX</button>
        </div>
      </div>
    </div>
  </div>

  <div id="info" class="hidden">
    <div id="reorder-buttons">
      <button id="reorder-left" class="reorder-btn" title="Move modality left ([)">\u2190</button>
      <button id="reorder-right" class="reorder-btn" title="Move modality right (])">\u2192</button>
    </div>
    <div id="modality-selector"></div>
    <span id="status"><span id="status-name">Loading...</span><span id="status-info"></span></span>
    <button id="help-btn" title="Keyboard shortcuts">?</button>
  </div>

  <div id="help-modal">
    <div class="modal-content">
      <h3>Keyboard Shortcuts</h3>
      <table>
        <tr><td>\u2190 \u2192</td><td>Switch modality</td></tr>
        <tr><td>\u2191 \u2193</td><td>Previous/next tuple</td></tr>
        <tr><td>Space</td><td>Flip to previous modality (hold)</td></tr>
        <tr><td>1-9</td><td>Jump to modality N</td></tr>
        <tr><td>[ ]</td><td>Reorder current modality</td></tr>
        <tr><td>Enter</td><td>Toggle winner for current modality</td></tr>
        <tr><td>Scroll</td><td>Zoom in/out</td></tr>
        <tr><td>Drag</td><td>Pan image</td></tr>
        <tr><td>C</td><td>Toggle crop mode</td></tr>
        <tr><td>Esc</td><td>Reset zoom / cancel crop</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <button class="btn btn-primary" id="close-help-btn">Close</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
          const cacheKey = `${tupleIndex}-${globalModIdx}`;
          state.loadedImages.delete(cacheKey);

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
    // Check if this is an image file
    const filename = uri.path.split('/').pop() || '';
    if (!isImageFile(filename)) return;

    this.cleanupRecentlyDeleted(state);

    // First, check if this file restores an existing slot (exact URI match)
    const restoredSlot = this.findExistingSlotByUri(state, uri);
    if (restoredSlot) {
      const { tupleIndex, modalityIndex } = restoredSlot;
      
      // Clear cached data
      const cacheKey = `${tupleIndex}-${modalityIndex}`;
      state.loadedImages.delete(cacheKey);
      
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
      const cacheKey = `${tupleIndex}-${modalityIndex}`;
      state.loadedImages.delete(cacheKey);
      
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
      const newModalityIndex = tuple.images.findIndex(img => img.uri.toString() === uri.toString());
      this.regenerateThumbnail(state, matchingTupleIndex, newModalityIndex);

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
    const uriStr = uri.toString();
    
    // Find which tuple/modality this file belongs to
    for (let tupleIndex = 0; tupleIndex < state.scanResult.tuples.length; tupleIndex++) {
      const tuple = state.scanResult.tuples[tupleIndex];
      for (let modalityIndex = 0; modalityIndex < tuple.images.length; modalityIndex++) {
        if (tuple.images[modalityIndex].uri.toString() === uriStr) {
          // Clear cached data
          const cacheKey = `${tupleIndex}-${modalityIndex}`;
          state.loadedImages.delete(cacheKey);
          
          // Regenerate thumbnail
          this.regenerateThumbnail(state, tupleIndex, modalityIndex);
          
          // If currently viewing this image, reload it
          if (tupleIndex === state.currentTupleIndex) {
            this.sendImage(state, tupleIndex, modalityIndex);
          }
          
          return;
        }
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
    if (!tuple || !tuple.images[modalityIndex]) return;
    
    const imageFile = tuple.images[modalityIndex];
    
    try {
      const dataUrl = await this.thumbnailService.getThumbnail(imageFile.uri, thumbnailSize * 2);
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
