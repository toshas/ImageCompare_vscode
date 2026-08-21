/** Standalone IO backend + protocol host for the real webview bundle: it decides nothing — matching, naming, ordering, results format, crop math and deck layout are imports (docs/standalone.md: adapter-contains-no-logic). */
import { FileType, Uri, setStandaloneFs, StandaloneFs } from './shims/vscode';
import { createDroppedEntryBackend, createFsaBackend, createFileListBackend, OpenedRoot } from './fsBackends';
import { scanForImages, mapWinnersToIndices, RESULTS_FILENAME } from '../src/fileService';
import { parseResults, persistResults } from '../src/resultsFile';
import { passthroughMime } from '../src/imageMime';
import { ImageServeIo, ImageServeReply, refreshTupleImages, serveImage } from '../src/imageServe';
import { parsePpmx } from '../src/ppmxParser';
import { pngReadText, parseCropMeta, CROP_RECT_KEYWORD } from '../src/pngText';
import { performCrop } from '../src/cropFlow';
import { applyArrival, planArrival } from '../src/arrivalPlan';
import { adoptableImages, applyModalityInsert, newModalityDirCandidates } from '../src/adoptionPlan';
import { commitSlotRemoval, deleteTupleFlow, removeModalityStep, removeTupleStep } from '../src/removalPlan';
import { diffSnapshots, pairRenames, PollEntry, SnapshotEntry } from '../src/pollPlan';
import { DeckIo, DECK_IMAGE_MAX_DIM, DECK_JPEG_QUALITY, exportDeck } from '../src/pptxDeck';
import { planThumbnails, runThumbnailSweep, SWEEP_REQUEUE, ThumbnailBytes } from '../src/thumbnailPlan';
// Where the sweep aims and when that settles is the shared policy's, never this host's (docs/loading-architecture.md: sweep-centre-dwells).
import { SweepAimPolicy } from '../src/sweepAimPolicy';
import { normalizeImageBytes } from '../src/wireFormat';
import { buildInitPayload } from '../src/initPayload';
import { nextPanelKey, poolWidth, Priority, TaskCancelled, WorkPool } from '../src/workPool';
import { configureDebugLog, resetDebugClock } from '../src/debugLog';
import type PptxGenJS from 'pptxgenjs';
import {
  ScanResult,
  ImageTuple,
  ImageFile,
  WebViewMessage,
  ExtensionMessage,
  OriginalModalityIndex,
  TupleIndex,
  asOriginal,
  asTuple,
  isImageFile,
} from '../src/types';

declare const __IC_VERSION__: string;

interface StandaloneState {
  fs: StandaloneFs;
  basePath: string;
  scan: ScanResult;
  winners: Map<number, number>;
  currentTupleIndex: number;
  /** This session's sweep aim: raw reports in, a settled tile out — the provider's policy, same instance shape (docs/loading-architecture.md: sweep-centre-dwells, thumbnails-centre-out). */
  sweepAim: SweepAimPolicy;
  poolKey: string;
  /** Live per-tuple image-load keys, like the provider's (docs/loading-architecture.md: stale-tuple-loads-cancelled). */
  imageLoadKeys: Set<string>;
  /** Set before a re-open cancels this session's work, so its sweep settles those slots instead of re-dispatching them (docs/loading-architecture.md: sweep-cancels-on-reaim). */
  closed?: boolean;
  /** Retained per-modality-dir listing (with lazy fingerprints) the next poll cycle diffs against. */
  snapshots: Map<string, SnapshotEntry[]>;
  /** results.txt fingerprint, refreshed after own writes so they never read back as external edits. */
  resultsFp?: { mtime?: number; size?: number };
  pollTimer?: ReturnType<typeof setInterval>;
  observer?: { disconnect(): void };
  pollBusy: boolean;
}

let state: StandaloneState | undefined;
let webviewReady = false;

// The provider's scheduler with the browser's core count; decodes run in-page, so the shared clamp bounds them (docs/loading-architecture.md: pool-width-hides-latency).
const pool = new WorkPool(poolWidth(navigator.hardwareConcurrency || 4));

// `?debug` in the URL is this product's `imageCompare.debug`; the devtools console is its output channel (docs/standalone.md).
resetDebugClock();
configureDebugLog({
  enabled: /[?&]debug\b/.test(location.search) || location.hash.includes('debug'),
  verbose: /[?&]debug=verbose\b/.test(location.search),
  sink: line => console.log(line)
});

// Same config the provider reads from settings; the standalone has no settings UI, so these are the extension's defaults.
const THUMBNAIL_SIZE = 100;
const PREFETCH_COUNT = 3;

// The stub must exist before the webview bundle's top-level `acquireVsCodeApi()` call runs.
(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebViewMessage) => { void handleWebviewMessage(m); },
  getState: () => undefined,
  setState: (_s: unknown) => undefined,
});

/** Deliver an extension→webview message asynchronously, like the real postMessage (never re-enters the webview's dispatch). */
function post(msg: ExtensionMessage): void {
  setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: msg })), 0);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

function findImageForModality(tuple: ImageTuple, modality: string): ImageFile | undefined {
  return tuple.images.find(img => img.modality === modality);
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** Decode file bytes for canvas use: browser-native formats via createImageBitmap, PPMX via the real parser. */
async function decodeFile(bytes: Uint8Array, name: string): Promise<Decoded> {
  const ext = extOf(name);
  if (ext === '.ppmx') {
    const { width, height, rgbBuffer } = parsePpmx(Buffer.from(bytes));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      imageData.data[i * 4] = rgbBuffer[i * 3];
      imageData.data[i * 4 + 1] = rgbBuffer[i * 3 + 1];
      imageData.data[i * 4 + 2] = rgbBuffer[i * 3 + 2];
      imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return { source: canvas, width, height, close: () => undefined };
  }
  const mime = passthroughMime(ext);
  if (!mime) {
    throw new Error(`${ext || name} is not decodable in the browser`);
  }
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
}

function drawScaled(dec: Decoded, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(dec.width, dec.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(dec.width * scale));
  canvas.height = Math.max(1, Math.round(dec.height * scale));
  canvas.getContext('2d')!.drawImage(dec.source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error(`${mime} encode failed`));
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject);
    }, mime, quality);
  });
}

const canvasToPngBytes = (canvas: HTMLCanvasElement): Promise<Uint8Array> => canvasToBytes(canvas, 'image/png');

/** Thumbnail at the same decode target the provider uses (thumbnailSize * 2 longest side), on the provider's binary wire shape. */
async function thumbnailBytes(s: StandaloneState, img: ImageFile): Promise<ThumbnailBytes> {
  const bytes = await s.fs.readFile(img.uri.path);
  const dec = await decodeFile(bytes, img.name);
  const canvas = drawScaled(dec, THUMBNAIL_SIZE * 2);
  dec.close();
  const mime = extOf(img.name) === '.png' ? 'image/png' : 'image/jpeg';
  // Same normalization as the provider's post path (docs/loading-architecture.md: image-payload-normalized).
  return { bytes: normalizeImageBytes(await canvasToBytes(canvas, mime, 0.8)), mime };
}

/** The host's whole contribution to the aim: two timer primitives, no decision (docs/standalone.md: host-supplies-data-not-policy, docs/loading-architecture.md: sweep-centre-dwells). */
function newSweepAimPolicy(): SweepAimPolicy {
  return new SweepAimPolicy({
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  });
}

/** Open-time sweep: slots, order, totals and wire traffic come from the shared planner/runner; each decode is pooled at bulk priority exactly like the provider's (docs/standalone.md: adapter-contains-no-logic). */
function generateAllThumbnails(s: StandaloneState): Promise<void> {
  // The sweep opens aimed where the session opened; the dwell governs moves only (docs/loading-architecture.md: sweep-centre-dwells).
  s.sweepAim.noteSweepStart(s.currentTupleIndex);
  return runThumbnailSweep(planThumbnails(s.scan.tuples, s.scan.modalities), {
    makeThumbnail: item =>
      pool
        // The session is the fair-share bucket, as the panel is in the provider (docs/loading-architecture.md: bulk-sweeps-share-the-pool).
        .submit(() => thumbnailBytes(s, item.image), { priority: Priority.THUMBNAIL_BULK, key: sweepPoolKey(s), group: s.poolKey })
        .catch(error => {
          // A live session's cancellation is the sweep's own re-aim drop; a re-open settles the slot silently, like the provider's disposed panel (docs/loading-architecture.md: sweep-cancels-on-reaim).
          if (error instanceof TaskCancelled) return s.closed ? null : SWEEP_REQUEUE;
          throw error;
        }),
    // The mechanism is the pool's; the decision to use it is the shared module's (docs/loading-architecture.md: sweep-cancels-on-reaim).
    dropQueued: () => pool.cancel(sweepPoolKey(s)),
  }, post, {
    // The host supplies only where the user is; the ordering it implies is the shared module's (docs/loading-architecture.md: thumbnails-centre-out).
    centre: () => s.sweepAim.aim(),
    // A re-opened root abandons this session's sweep: the rest of the grid is never decoded (docs/loading-architecture.md: sweep-stops-when-host-abandons).
    abandoned: () => s.closed === true,
  });
}

async function sendThumbnails(s: StandaloneState, tupleIndices: TupleIndex[]): Promise<void> {
  for (const tupleIndex of tupleIndices) {
    if (tupleIndex < 0 || tupleIndex >= s.scan.tuples.length) continue;
    for (let modalityIndex = 0; modalityIndex < s.scan.modalities.length; modalityIndex++) {
      const img = findImageForModality(s.scan.tuples[tupleIndex], s.scan.modalities[modalityIndex]);
      if (!img) {
        post({ type: 'thumbnailError', tupleIndex, modalityIndex: asOriginal(modalityIndex), error: 'Image not available' });
        continue;
      }
      try {
        // On-demand priority, ranked above the open-time bulk sweep — the provider's class for these re-requests.
        const thumb = await pool.submit(() => thumbnailBytes(s, img), { priority: Priority.THUMBNAIL, key: s.poolKey });
        post({ type: 'thumbnail', tupleIndex, modalityIndex: asOriginal(modalityIndex), bytes: thumb.bytes, mime: thumb.mime });
      } catch (err) {
        if (err instanceof TaskCancelled) continue;
        post({ type: 'thumbnailError', tupleIndex, modalityIndex: asOriginal(modalityIndex), error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
  }
}

/** The sweep's own cancellation key, as the provider's: a re-aim drops queued thumbnail decodes only (docs/loading-architecture.md: sweep-cancels-on-reaim). */
function sweepPoolKey(s: StandaloneState): string {
  return `${s.poolKey}-sweep`;
}

function imageLoadKey(s: StandaloneState, tupleIndex: TupleIndex): string {
  return `${s.poolKey}-image-${tupleIndex}`;
}

/** Drop every queued image load except `keepTupleIndex`'s (docs/loading-architecture.md: stale-tuple-loads-cancelled). */
function cancelImageLoads(s: StandaloneState, keepTupleIndex?: TupleIndex): void {
  const keep = keepTupleIndex === undefined ? undefined : imageLoadKey(s, keepTupleIndex);
  for (const key of s.imageLoadKeys) {
    if (key === keep) continue;
    pool.cancel(key);
    s.imageLoadKeys.delete(key);
  }
}

/** Reply exactly once — `image` or `imageError` — via the shared serve skeleton; only decode IO lives here (docs/loading-architecture.md: reply-exactly-once). */
async function sendImage(s: StandaloneState, tupleIndex: TupleIndex, modalityIndex: OriginalModalityIndex, priority: Priority = Priority.VISIBLE): Promise<void> {
  const tuple = s.scan.tuples[tupleIndex];
  const modality = s.scan.modalities[modalityIndex];
  const img = tuple && modality ? findImageForModality(tuple, modality) : undefined;
  const io: ImageServeIo<ImageFile> = {
    loadRaw: async image => ({ bytes: await s.fs.readFile(image.uri.path), ext: extOf(image.name) }),
    // Passthrough policy: original bytes on the wire, dims from a browser decode (docs/image-backends.md: passthrough-no-backend).
    probePassthrough: async bytes => {
      const dec = await decodeFile(bytes, img!.name);
      dec.close();
      return { width: dec.width, height: dec.height };
    },
    convert: async (bytes, ext) => {
      if (ext === '.ppmx') {
        const dec = await decodeFile(bytes, img!.name);
        const pngBytes = await canvasToPngBytes(dec.source as HTMLCanvasElement);
        return { bytes: pngBytes, mime: 'image/png', width: dec.width, height: dec.height };
      }
      throw new Error(`${ext} is not supported in the browser`);
    },
  };
  const deliver = (reply: ImageServeReply): void => {
    if (reply.kind === 'image') post({ type: 'image', tupleIndex, modalityIndex, bytes: reply.bytes, mime: reply.mime, width: reply.width, height: reply.height });
    else post({ type: 'imageError', tupleIndex, modalityIndex, error: reply.error });
  };
  if (!img) {
    // A missing slot answers immediately, never queued behind pool work — the provider's rule.
    await serveImage(img, io, deliver);
    return;
  }
  const loadKey = imageLoadKey(s, tupleIndex);
  s.imageLoadKeys.add(loadKey);
  try {
    // One pool task spans read + decode + delivery, at the provider's class for this request (docs/loading-architecture.md: visible-never-starved).
    await pool.submit(() => serveImage(img, io, deliver), { priority, key: loadKey });
  } catch (error) {
    if (error instanceof TaskCancelled) return;
    // serveImage replies terminally itself, so this is defensive parity with the provider (docs/loading-architecture.md: reply-exactly-once).
    post({ type: 'imageError', tupleIndex, modalityIndex, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

function resultsPath(s: StandaloneState): string {
  return `${s.basePath}/${RESULTS_FILENAME}`;
}

/** Persist winners exactly like the provider — empty-deletes, naming and serialization are the shared persist flow; only the write/delete IO lives here (docs/standalone.md: results-format-shared). */
async function saveResults(s: StandaloneState): Promise<void> {
  if (!s.fs.writable) return;
  await persistResults(s.scan.tuples, s.scan.modalities, s.winners, {
    writeText: text => s.fs.writeFile(resultsPath(s), new TextEncoder().encode(text)),
    deleteFile: () => s.fs.delete(resultsPath(s)),
  });
  await refreshResultsFingerprint(s);
}

/** Re-baseline the results.txt fingerprint, so the poll reports only edits we did not make ourselves. */
async function refreshResultsFingerprint(s: StandaloneState): Promise<void> {
  try {
    s.resultsFp = await s.fs.fingerprint?.(resultsPath(s));
  } catch {
    s.resultsFp = undefined;
  }
}

async function handleSetWinner(s: StandaloneState, tupleIndex: TupleIndex, modalityIndex: OriginalModalityIndex | null): Promise<void> {
  if (!s.fs.writable) return;
  if (modalityIndex === null) s.winners.delete(tupleIndex);
  else s.winners.set(tupleIndex, modalityIndex);
  post({ type: 'winnerUpdated', tupleIndex, modalityIndex });
  await saveResults(s);
}

function refreshCurrentTupleImages(s: StandaloneState): void {
  refreshTupleImages(s.scan.tuples[s.currentTupleIndex], s.scan.modalities, m => {
    void sendImage(s, asTuple(s.currentTupleIndex), m);
  });
}

/** Execute the shared tuple-removal step with this adapter's io — the one wiring both the delete flow and the poll use. */
function removeTupleAt(s: StandaloneState, tupleIndex: TupleIndex): void {
  removeTupleStep(s.scan, s.winners, s.currentTupleIndex, tupleIndex, {
    post,
    // A structural mutation must not strand the current view (docs/file-watching.md: mutation-never-strands-view).
    refreshCurrentTuple: current => {
      s.currentTupleIndex = current;
      refreshCurrentTupleImages(s);
    },
    saveResults: () => { void saveResults(s); },
  });
}

/** Execute the shared modality-removal step with this adapter's io. */
function removeModalityAt(s: StandaloneState, modalityIndex: OriginalModalityIndex): void {
  removeModalityStep(s.scan, s.winners, modalityIndex, { post, saveResults: () => { void saveResults(s); } });
}

/** Delete a tuple through the shared flow — file deletes, live-index re-plan, step order and per-step re-saves are the flow's, not the adapter's (docs/file-watching.md: delete-message-order). */
async function handleDeleteTuple(s: StandaloneState, tupleIndex: TupleIndex): Promise<void> {
  if (!s.fs.writable) return;
  await deleteTupleFlow<ImageFile>(s.scan, tupleIndex, {
    deleteFile: img => s.fs.delete(img.uri.path),
    removeTuple: idx => removeTupleAt(s, idx),
    removeModality: idx => removeModalityAt(s, idx),
  });
}

/** The crop sequence is the shared flow's; only FSA reads/writes, the canvas render and the pooled scheduling live here (docs/standalone.md: adapter-contains-no-logic). */
async function handleCropImages(
  s: StandaloneState,
  tupleIndex: TupleIndex,
  cropRect: { x: number; y: number; w: number; h: number },
  srcWidth: number,
  srcHeight: number
): Promise<void> {
  if (!s.fs.writable) {
    post({ type: 'cropError', tupleIndex, error: 'This directory was opened read-only' });
    return;
  }
  let newTupleIndex = -1;
  await performCrop<ImageFile, { path: string; name: string; modality: string }>(s.scan, { tupleIndex, cropRect, srcWidth, srcHeight }, {
    listDirNames: async img => {
      const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
      return (await s.fs.readDirectory(dir)).map(([name]) => name);
    },
    getDimensions: async img => {
      const dec = await decodeFile(await s.fs.readFile(img.uri.path), img.name);
      dec.close();
      return { width: dec.width, height: dec.height };
    },
    renderCrop: async (img, rect) => {
      const dec = await decodeFile(await s.fs.readFile(img.uri.path), img.name);
      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      canvas.getContext('2d')!.drawImage(dec.source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      const png = await canvasToPngBytes(canvas);
      dec.close();
      return png;
    },
    writeCrop: async (img, outputName, bytes) => {
      const dir = img.uri.path.substring(0, img.uri.path.lastIndexOf('/'));
      const outPath = `${dir}/${outputName}`;
      await s.fs.writeFile(outPath, bytes);
      return { path: outPath, name: outputName, modality: img.modality };
    },
    // Pooled per modality like the provider: a wide tuple would otherwise fan out full-res decodes without bound (docs/loading-architecture.md: visible-never-starved).
    schedule: work => pool.submit(work, { priority: Priority.EXPORT, key: s.poolKey }),
    isCancelled: err => err instanceof TaskCancelled,
    isAborted: () => state !== s,
    // Each saved file lands via the shared arrival planner — first one a sparse tupleAdded, the rest fileRestored (docs/crop-and-pptx.md: post-crop-message-order).
    arriveFile: f => {
      const imageFile: ImageFile = { uri: Uri.file(f.path), name: f.name, modality: f.modality };
      const plan = planArrival(s.scan.tuples, s.scan.modalities, imageFile);
      if (!plan) return;
      const applied = applyArrival(s.scan, s.winners, s.currentTupleIndex, plan, imageFile);
      s.currentTupleIndex = applied.currentTupleIndex;
      newTupleIndex = plan.kind === 'new-tuple' ? plan.insertIndex : plan.tupleIndex;
      post(applied.message);
    },
    post,
    postCropThumbnails: async saved => {
      const newTuple: ImageTuple | undefined = s.scan.tuples[newTupleIndex];
      for (const f of saved) {
        const modalityIndex = s.scan.modalities.indexOf(f.modality);
        const img = newTuple ? findImageForModality(newTuple, f.modality) : undefined;
        if (!img || modalityIndex < 0) continue;
        try {
          // Post-crop thumbnails at on-demand priority, the provider's class for a regenerated slot.
          const thumb = await pool.submit(() => thumbnailBytes(s, img), { priority: Priority.THUMBNAIL, key: s.poolKey });
          post({ type: 'thumbnail', tupleIndex: asTuple(newTupleIndex), modalityIndex: asOriginal(modalityIndex), bytes: thumb.bytes, mime: thumb.mime });
        } catch (err) {
          if (err instanceof TaskCancelled) continue;
          post({ type: 'thumbnailError', tupleIndex: asTuple(newTupleIndex), modalityIndex: asOriginal(modalityIndex), error: err instanceof Error ? err.message : 'Unknown error' });
        }
      }
    },
  });
}

type PptxCtor = new () => PptxGenJS;
let pptxGenPromise: Promise<PptxCtor> | undefined;

/** The lazy pptxgenjs CDN script is the artifact's ONLY permitted network dependency (docs/standalone.md: standalone-single-file). */
function loadPptxGen(): Promise<PptxCtor> {
  if (!pptxGenPromise) {
    pptxGenPromise = new Promise<PptxCtor>((resolve, reject) => {
      const w = window as unknown as { PptxGenJS?: PptxCtor };
      if (w.PptxGenJS) return resolve(w.PptxGenJS);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js';
      script.onload = () => {
        if (w.PptxGenJS) resolve(w.PptxGenJS);
        else {
          pptxGenPromise = undefined;
          reject(new Error('pptxgenjs loaded but exposed no constructor'));
        }
      };
      script.onerror = () => {
        pptxGenPromise = undefined;
        reject(new Error('Could not load pptxgenjs from the CDN (are you offline?)'));
      };
      document.head.appendChild(script);
    });
  }
  return pptxGenPromise;
}

/** The export sequence (name, build, save, one answer) is the shared flow's; only the CDN load, FSA reads and the download live here (docs/standalone.md: adapter-contains-no-logic). */
async function handleExportPptx(
  s: StandaloneState,
  tupleIndices: TupleIndex[],
  winnerModalityIndices: (OriginalModalityIndex | null)[],
  modalityOrder: OriginalModalityIndex[]
): Promise<void> {
  const deckIo: DeckIo = {
    loadImage: async (tupleIndex, modalityOriginalIndex) => {
      const tuple = s.scan.tuples[tupleIndex];
      const modality = s.scan.modalities[modalityOriginalIndex];
      const img = tuple && modality ? findImageForModality(tuple, modality) : undefined;
      if (!img) return null;
      // cancel() drains the queue once; a sequential producer must stop submitting itself.
      if (state !== s) throw new TaskCancelled();
      return pool.submit(async () => {
        try {
          const dec = await decodeFile(await s.fs.readFile(img.uri.path), img.name);
          // Capped and JPEG-recompressed, never full-res PNG (docs/crop-and-pptx.md: deck-images-bounded).
          const canvas = drawScaled(dec, DECK_IMAGE_MAX_DIM);
          dec.close();
          return { data: canvas.toDataURL('image/jpeg', DECK_JPEG_QUALITY / 100), width: dec.width, height: dec.height };
        } catch {
          return null;
        }
      }, { priority: Priority.EXPORT, key: s.poolKey });
    },
    readCropMeta: async (tupleIndex, modality) => {
      const tuple = s.scan.tuples[tupleIndex];
      const img = tuple ? findImageForModality(tuple, modality) : undefined;
      if (!img || extOf(img.name) !== '.png') return null;
      if (state !== s) throw new TaskCancelled();
      return pool.submit(async () => {
        try {
          const value = pngReadText(Buffer.from(await s.fs.readFile(img.uri.path)), CROP_RECT_KEYWORD);
          return value ? parseCropMeta(value) : null;
        } catch {
          return null;
        }
      }, { priority: Priority.EXPORT, key: s.poolKey });
    },
  };
  // Name, build, save and the exactly-one answer are sequenced by the shared flow (docs/crop-and-pptx.md: export-always-answers) (docs/standalone.md: deck-layout-shared).
  await exportDeck(s.scan.tuples, s.scan.modalities, { tupleIndices, winnerModalityIndices, modalityOrder }, {
    getPptx: loadPptxGen,
    listExistingNames: async () => {
      try {
        return (await s.fs.readDirectory(s.basePath)).map(([name]) => name);
      } catch {
        return []; // unreadable dir: keep the default name
      }
    },
    deckIo,
    saveDeck: async (pptx, name) => {
      // writeFile in a browser is a download — allowed even in read-only mode.
      await pptx.writeFile({ fileName: name });
      return name;
    },
    post,
    // A replaced root is not a failure: same filter the provider applies for a closed panel.
    isCancelled: err => err instanceof TaskCancelled || state !== s,
  });
}

/** Mirror the provider's sendInitData: winners from results.txt via the shared parser, payload from the shared builder (docs/standalone.md: adapter-contains-no-logic). */
async function sendInit(s: StandaloneState): Promise<void> {
  const votingEnabled = s.fs.writable;
  if (votingEnabled) {
    try {
      const text = new TextDecoder().decode(await s.fs.readFile(resultsPath(s)));
      // IO wrapper only: the format is decided in resultsFile.ts (docs/standalone.md: results-format-shared).
      s.winners = new Map(mapWinnersToIndices(parseResults(text), s.scan.tuples, s.scan.modalities));
    } catch { /* no results.txt yet */ }
    // Baseline for the poll: only edits after this point are external.
    await refreshResultsFingerprint(s);
  }
  post(buildInitPayload({
    tuples: s.scan.tuples,
    modalities: s.scan.modalities,
    modalityPaths: s.scan.modalities.map(m => `${s.basePath}/${m}`),
    winners: s.winners,
    config: { thumbnailSize: THUMBNAIL_SIZE, prefetchCount: PREFETCH_COUNT, keepZoomOnTupleChange: false },
    votingEnabled,
    labelsExplicit: false,
    version: __IC_VERSION__,
  }));
  void generateAllThumbnails(s);
}

async function handleWebviewMessage(message: WebViewMessage): Promise<void> {
  if (message.type === 'ready') {
    webviewReady = true;
    if (state) await sendInit(state);
    return;
  }
  const s = state;
  if (!s) return;
  switch (message.type) {
    case 'requestThumbnails':
      await sendThumbnails(s, message.tupleIndices);
      break;
    case 'requestImage':
      // The webview's own rank, mapped exactly as the provider maps it (docs/loading-architecture.md: sibling-tail-never-competes).
      await sendImage(s, message.tupleIndex, message.modalityIndex, message.tail ? Priority.SIBLING_TAIL : message.sibling ? Priority.SIBLING : Priority.VISIBLE);
      break;
    case 'setCurrentTuple':
      // Same starvation, same cure: queued loads of the tuple left behind die (docs/loading-architecture.md: stale-tuple-loads-cancelled).
      cancelImageLoads(s, message.tupleIndex);
      s.currentTupleIndex = message.tupleIndex;
      s.sweepAim.noteTuple(message.tupleIndex);
      break;
    case 'setWinner':
      await handleSetWinner(s, message.tupleIndex, message.modalityIndex);
      break;
    case 'cropImages':
      await handleCropImages(s, message.tupleIndex, message.cropRect, message.srcWidth, message.srcHeight);
      break;
    case 'deleteTuple':
      await handleDeleteTuple(s, message.tupleIndex);
      break;
    case 'exportPptx':
      await handleExportPptx(s, message.tupleIndices, message.winnerModalityIndices, message.modalityOrder);
      break;
    case 'tupleFullyLoaded': {
      // No prefetch here, but the same report carries the sweep's column aim (docs/loading-architecture.md: thumbnails-centre-out).
      s.sweepAim.noteStrip(message);
      break;
    }
    case 'saveSessionAs':
    case 'log':
      break;
  }
}

// ---- External-change detection: poll loop + observer (docs/file-watching.md, "The standalone poll") ----

/** A polled file plus the modality its directory maps to. */
interface PolledFile extends PollEntry {
  modality: string;
}

/** The slot holding `path`, in global modality space (docs/file-watching.md: modality-index-is-global). */
function findSlotByPath(s: StandaloneState, path: string): { tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex } | undefined {
  for (let tupleIndex = 0; tupleIndex < s.scan.tuples.length; tupleIndex++) {
    for (const img of s.scan.tuples[tupleIndex].images) {
      if (img.uri.path === path) {
        const modalityIndex = s.scan.modalities.indexOf(img.modality);
        if (modalityIndex >= 0) return { tupleIndex: asTuple(tupleIndex), modalityIndex: asOriginal(modalityIndex) };
      }
    }
  }
  return undefined;
}

/** Regenerate one slot's thumbnail at on-demand priority — the provider's class for a changed/restored slot. */
async function postSlotThumbnail(s: StandaloneState, tupleIndex: TupleIndex, modalityIndex: OriginalModalityIndex): Promise<void> {
  const tuple = s.scan.tuples[tupleIndex];
  const modality = s.scan.modalities[modalityIndex];
  const img = tuple && modality ? findImageForModality(tuple, modality) : undefined;
  if (!img) return;
  try {
    const thumb = await pool.submit(() => thumbnailBytes(s, img), { priority: Priority.THUMBNAIL, key: s.poolKey });
    post({ type: 'thumbnail', tupleIndex, modalityIndex, bytes: thumb.bytes, mime: thumb.mime });
  } catch (err) {
    if (err instanceof TaskCancelled) return;
    post({ type: 'thumbnailError', tupleIndex, modalityIndex, error: err instanceof Error ? err.message : 'Unknown error' });
  }
}

/** The provider's exact-URI restore traffic: fileRestored, fresh thumbnail, re-serve if visible (docs/file-watching.md: duplicate-reports-idempotent). */
function restoreSlot(s: StandaloneState, slot: { tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex }): void {
  post({ type: 'fileRestored', tupleIndex: slot.tupleIndex, modalityIndex: slot.modalityIndex });
  void postSlotThumbnail(s, slot.tupleIndex, slot.modalityIndex);
  if (slot.tupleIndex === s.currentTupleIndex) void sendImage(s, slot.tupleIndex, slot.modalityIndex);
}

/** Execute a paired rename the provider's way: uri/name updated in place, slot/winner kept, fileRestored posted (docs/file-watching.md, "Claiming a pending delete"). */
function applyExternalRename(s: StandaloneState, from: PolledFile, to: PolledFile): void {
  const slot = findSlotByPath(s, `${from.dir}/${from.name}`);
  if (!slot) {
    applyExternalArrival(s, to);
    return;
  }
  const img = findImageForModality(s.scan.tuples[slot.tupleIndex], s.scan.modalities[slot.modalityIndex]);
  if (!img) return;
  img.uri = Uri.file(`${to.dir}/${to.name}`);
  img.name = to.name;
  restoreSlot(s, slot);
}

/** Commit a confirmed external removal through the shared commit — strip, winner clear, tuple/column follow-ups (docs/file-watching.md: delete-message-order). */
function applyExternalRemoval(s: StandaloneState, entry: PolledFile): void {
  const slot = findSlotByPath(s, `${entry.dir}/${entry.name}`);
  // Already gone from state (e.g. our own delete flow ran first): one state change however many reports (docs/file-watching.md: duplicate-reports-idempotent).
  if (!slot) return;
  commitSlotRemoval(s.scan, s.winners, slot.tupleIndex, slot.modalityIndex, {
    post,
    removeTuple: idx => removeTupleAt(s, idx),
    removeModality: idx => removeModalityAt(s, idx),
    saveResults: () => { void saveResults(s); },
  });
}

/** Place an externally arrived file exactly like the provider's create path: exact-URI absorb, else the shared arrival planner. */
function applyExternalArrival(s: StandaloneState, entry: PolledFile): void {
  const path = `${entry.dir}/${entry.name}`;
  const existing = findSlotByPath(s, path);
  if (existing) {
    restoreSlot(s, existing);
    return;
  }
  const imageFile: ImageFile = { uri: Uri.file(path), name: entry.name, modality: entry.modality };
  // Placement is the shared planner's decision (docs/standalone.md: adapter-contains-no-logic).
  const plan = planArrival(s.scan.tuples, s.scan.modalities, imageFile);
  if (!plan) return;
  const applied = applyArrival(s.scan, s.winners, s.currentTupleIndex, plan, imageFile);
  s.currentTupleIndex = applied.currentTupleIndex;
  post(applied.message);
  const tupleIndex = plan.kind === 'new-tuple' ? plan.insertIndex : plan.tupleIndex;
  void postSlotThumbnail(s, asTuple(tupleIndex), plan.modalityIndex);
}

/** Mirror the provider's handleFileChanged: fresh thumbnail, and a re-serve only for the visible tuple. */
function applyExternalChange(s: StandaloneState, entry: PolledFile): void {
  const slot = findSlotByPath(s, `${entry.dir}/${entry.name}`);
  if (!slot) return;
  void postSlotThumbnail(s, slot.tupleIndex, slot.modalityIndex);
  if (slot.tupleIndex === s.currentTupleIndex) void sendImage(s, slot.tupleIndex, slot.modalityIndex);
}

/** An externally edited (or deleted) results.txt resets the winners wholesale via the shared parser (docs/standalone.md: results-format-shared). */
async function pollResults(s: StandaloneState): Promise<void> {
  let fp: { mtime?: number; size?: number } | undefined;
  try {
    fp = await s.fs.fingerprint?.(resultsPath(s));
  } catch {
    fp = undefined;
  }
  const prev = s.resultsFp;
  const unchanged = prev === undefined && fp === undefined
    ? true
    : prev !== undefined && fp !== undefined && prev.mtime === fp.mtime && prev.size === fp.size;
  if (unchanged) return;
  s.resultsFp = fp;
  let text = '';
  try {
    text = new TextDecoder().decode(await s.fs.readFile(resultsPath(s)));
  } catch { /* deleted externally: parse of '' clears the winners */ }
  s.winners = new Map(mapWinnersToIndices(parseResults(text), s.scan.tuples, s.scan.modalities));
  const winners: Record<number, OriginalModalityIndex> = {};
  for (const [t, m] of s.winners) winners[t] = asOriginal(m);
  post({ type: 'winnersReset', winners });
}

/** The state-known names of one modality — the first cycle's baseline, so the boot listing is never re-reported. */
function knownEntries(s: StandaloneState, modality: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const tuple of s.scan.tuples) {
    const img = findImageForModality(tuple, modality);
    if (img) entries.push({ name: img.name });
  }
  return entries;
}

/** Adopt modality dirs that appeared under the root: qualification and column mutations are the shared planner's, arrivals the shared arrival path's (docs/file-watching.md: new-modality-dir-adopted). */
async function adoptNewModalityDirs(s: StandaloneState): Promise<void> {
  // Mode 1 is the only shape whose subdirectories are columns by definition (docs/file-watching.md, "Events by mode").
  if (s.scan.mode !== 1) return;
  let rootEntries: Array<[string, FileType]>;
  try {
    rootEntries = await s.fs.readDirectory(s.basePath);
  } catch {
    return; // root unreadable this instant; the next cycle retries
  }
  const candidates = newModalityDirCandidates(
    rootEntries.map(([name, type]) => ({ name, isDirectory: (type & FileType.Directory) !== 0 })),
    s.scan.modalities
  );
  for (const name of candidates) {
    if (state !== s) return;
    const dir = `${s.basePath}/${name}`;
    let entries: Array<[string, FileType]>;
    try {
      entries = await s.fs.readDirectory(dir);
    } catch {
      continue; // raced away; the next cycle settles it
    }
    // FSA dirs expose no mtime to memoize by, so a barren dir is simply re-listed next cycle.
    const images = adoptableImages(entries.map(([n, t]) => ({ name: n, isFile: (t & FileType.File) !== 0 })));
    if (images.length === 0) continue;
    const { message } = applyModalityInsert(s.scan, s.winners, name, undefined, {
      modalityPath: n => `${s.basePath}/${n}`,
    });
    post(message);
    // Winner columns may have shifted with the insert — the provider re-saves here too.
    if (s.winners.size > 0) void saveResults(s);
    // Seed the retained snapshot with the dispatched names, so the next cycle does not re-report them.
    s.snapshots.set(dir, images.map(n => ({ name: n })));
    for (const n of images) {
      if (state !== s) return;
      applyExternalArrival(s, { dir, name: n, modality: name });
    }
  }
}

/** One poll cycle: list, diff via the shared planner (names first, fingerprints after), re-verify removals, pair renames, execute; adoption after removals; results.txt last. */
async function runPollCycle(s: StandaloneState): Promise<void> {
  if (state !== s) return;
  const removedRaw: PolledFile[] = [];
  const added: PolledFile[] = [];
  const changed: PolledFile[] = [];
  for (const modality of [...s.scan.modalities]) {
    if (state !== s) return;
    const dir = `${s.basePath}/${modality}`;
    let names: string[];
    try {
      // Listed-but-not-a-file (a dangling symlink) is a removal candidate, exactly as in the provider's sweep (docs/file-watching.md: sweep-derives-deletions-from-listings).
      names = (await s.fs.readDirectory(dir))
        .filter(([n, t]) => (t & FileType.File) !== 0 && isImageFile(n))
        .map(([n]) => n);
    } catch {
      names = []; // dir gone/unreadable: every retained entry becomes a removal candidate, re-verified below (docs/file-watching.md: sweep-derives-deletions-from-listings)
    }
    const prev = s.snapshots.get(dir) ?? knownEntries(s, modality);
    // Fingerprints only after the name listing and never for removed entries (docs/file-watching.md: poll-diff-names-first).
    const next: SnapshotEntry[] = [];
    for (const name of names) {
      let fp: { mtime?: number; size?: number } | undefined;
      try {
        fp = await s.fs.fingerprint?.(`${dir}/${name}`);
      } catch { /* raced away; the next cycle settles it */ }
      next.push({ name, ...fp });
    }
    const diff = diffSnapshots(prev, next);
    s.snapshots.set(dir, next);
    for (const name of diff.removed) removedRaw.push({ dir, name, modality });
    for (const name of diff.added) added.push({ dir, name, modality });
    for (const name of diff.changed) changed.push({ dir, name, modality });
  }
  if (state !== s) return;
  const removedConfirmed: PolledFile[] = [];
  for (const entry of removedRaw) {
    // A queued observation is stale by pickup: report only what is still gone (docs/file-watching.md: sweep-reverifies-before-report).
    try {
      await s.fs.stat(`${entry.dir}/${entry.name}`);
    } catch {
      removedConfirmed.push(entry);
    }
  }
  if (state !== s) return;
  // Same-cycle rename pairing is the shared planner's decision (docs/file-watching.md: rename-never-guessed).
  const pairing = pairRenames(removedConfirmed, added, s.scan.isMultiTupleMode);
  for (const rename of pairing.renames) applyExternalRename(s, rename.from, rename.to);
  for (const entry of pairing.removed) applyExternalRemoval(s, entry);
  for (const entry of pairing.added) applyExternalArrival(s, entry);
  for (const entry of changed) applyExternalChange(s, entry);
  // After removals, so a same-cycle dir rename executes as remove-then-adopt (docs/file-watching.md: new-modality-dir-adopted).
  await adoptNewModalityDirs(s);
  if (state !== s) return;
  // The snapshot map tracks the live dir set: entries whose column is gone are dropped, so a re-created dir adopts from scratch.
  const liveDirs = new Set(s.scan.modalities.map(m => `${s.basePath}/${m}`));
  for (const dir of [...s.snapshots.keys()]) {
    if (!liveDirs.has(dir)) s.snapshots.delete(dir);
  }
  await pollResults(s);
}

/** Schedule one non-overlapping cycle at POLL priority through the shared pool — the provider's sweep scheduling (docs/loading-architecture.md, "Filesystem watching"). */
function schedulePollCycle(s: StandaloneState): void {
  if (state !== s || s.pollBusy) return;
  s.pollBusy = true;
  pool
    .submit(() => runPollCycle(s), { priority: Priority.POLL, key: s.poolKey })
    .catch(() => undefined)
    .finally(() => { s.pollBusy = false; });
}

function stopPolling(s: StandaloneState): void {
  if (s.pollTimer !== undefined) {
    clearInterval(s.pollTimer);
    s.pollTimer = undefined;
  }
  try {
    s.observer?.disconnect();
  } catch { /* already gone */ }
  s.observer = undefined;
}

/** Arm the interval poll (plus the FileSystemObserver accelerator when the browser has one) for a writable root. */
function startPolling(s: StandaloneState, root: OpenedRoot): void {
  // Read-only roots are static File lists — there is nothing to re-list, so they never poll.
  if (!s.fs.writable) return;
  s.pollTimer = setInterval(() => schedulePollCycle(s), seam.pollIntervalMs);
  const Observer = (window as unknown as {
    FileSystemObserver?: new (cb: () => void) => { observe(h: FileSystemDirectoryHandle, opts?: { recursive?: boolean }): unknown; disconnect(): void };
  }).FileSystemObserver;
  if (typeof Observer !== 'function' || !root.handle) return;
  try {
    // Observer events only accelerate the next cycle; the diff stays the single source of truth (docs/file-watching.md: poll-observer-accelerates).
    const observer = new Observer(() => schedulePollCycle(s));
    Promise.resolve(observer.observe(root.handle, { recursive: true })).catch(() => {
      try { observer.disconnect(); } catch { /* noop */ }
    });
    s.observer = observer;
  } catch { /* observer unavailable mid-detect: interval-only */ }
}

async function openRoot(root: OpenedRoot): Promise<void> {
  // Re-open stops the old poll and drops the previous root's queued (not running) work, as the provider does per panel (docs/loading-architecture.md: panel-keys-never-reused).
  if (state) {
    stopPolling(state);
    state.closed = true; // set BEFORE the cancel: the rejections it delivers must read it as a close, not as a re-aim.
    state.sweepAim.dispose(); // a dwell must not fire against a closed session (docs/loading-architecture.md: sweep-centre-dwells)
    pool.cancel(state.poolKey);
    pool.cancel(sweepPoolKey(state));
    cancelImageLoads(state);
  }
  setStandaloneFs(root.fs);
  const scan = await scanForImages([Uri.file(root.rootPath)]);
  const s: StandaloneState = {
    fs: root.fs,
    basePath: scan.roots[0].path,
    scan,
    winners: new Map(),
    currentTupleIndex: 0,
    sweepAim: newSweepAimPolicy(),
    poolKey: nextPanelKey(),
    imageLoadKeys: new Set(),
    snapshots: new Map(),
    pollBusy: false,
  };
  state = s;
  hideLanding();
  if (webviewReady) await sendInit(s);
  if (state === s) startPolling(s, root);
}

// ---- Landing chrome (standalone-only UI) ----

// Visual design ported from the legacy hand-written standalone's dropzone; wiring below is this build's own.
const LANDING_CSS = `
#ic-landing {
  position: absolute; inset: 0; z-index: 1000;
  display: flex; background: var(--vscode-editor-background, #1a1a1a);
}
#ic-landing.hidden { display: none; }
.ic-dropframe {
  flex: 1; display: flex; align-items: center; justify-content: center;
  border: 3px dashed #444; margin: 20px; border-radius: 12px;
  transition: border-color 0.2s, background 0.2s;
}
#ic-drop.ic-over { border-color: #0af; background: rgba(0, 170, 255, 0.1); }
.ic-drop-text { text-align: center; color: #888; padding: 24px; }
.ic-drop-text h2 { font-size: 24px; margin-bottom: 10px; }
.ic-drop-text .ic-version { margin-top: 26px; font-size: 12px; color: #666; font-weight: normal; }
.ic-drop-text p { font-size: 14px; }
.ic-drop-text .ic-actions { margin-top: 12px; }
.ic-btn {
  display: inline-block; margin: 0 5px; padding: 10px 24px;
  border: none; border-radius: 6px; cursor: pointer; font-size: 14px;
}
.ic-btn:hover { opacity: 0.9; }
.ic-btn-primary { background: #0af; color: #000; }
.ic-btn-secondary { background: #444; color: #fff; }
#ic-landing input[type=file] { display: none; }
.ic-drop-text .ic-hints { margin-top: 20px; color: #666; font-size: 12px; line-height: 1.8; }
#ic-warn { margin-top: 16px; margin-left: auto; margin-right: auto; max-width: 560px; color: #c90; font-size: 13px; line-height: 1.5; }
#ic-error { margin-top: 16px; margin-left: auto; margin-right: auto; max-width: 560px; color: #f66; white-space: pre-wrap; }
`;

function landingEl(): HTMLElement | null {
  return document.getElementById('ic-landing');
}

function hideLanding(): void {
  landingEl()?.classList.add('hidden');
}

function showLandingError(err: unknown): void {
  const el = document.getElementById('ic-error');
  if (el) el.textContent = err instanceof Error ? err.message : String(err);
}

function buildLanding(): void {
  const style = document.createElement('style');
  style.textContent = LANDING_CSS;
  document.head.appendChild(style);

  const fsaSupported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const el = document.createElement('div');
  el.id = 'ic-landing';
  // The whole frame is a live drop target in BOTH cases: FSA drops open writable, webkit-entry drops open read-only.
  el.innerHTML = `
    <div id="ic-drop" class="ic-dropframe">
      <div class="ic-drop-text">
        <h2>${fsaSupported ? 'Drop' : 'Drop or Open'} a Folder to Compare</h2>
        <p>Open a directory whose subdirectories are the modalities to compare
           (each subdirectory holds one variant of every image)</p>
        <p class="ic-actions">
          ${fsaSupported
            ? '<button id="ic-open" class="ic-btn ic-btn-primary">Select Folder</button>'
            : '<label class="ic-btn ic-btn-primary ic-file-btn">Open Folder (read-only)<input type="file" id="ic-open-ro" webkitdirectory multiple></label>'}
        </p>
        ${fsaSupported ? '' : `<div id="ic-warn">This browser has no File System Access API, so folders open read-only:
           voting, crop and delete are disabled (PPTX export still works).</div>`}
        <p class="ic-hints">
          &larr;&rarr;: modality | &uarr;&darr;: tuple | Space: flip | 1-9: jump to modality<br>
          [ ]: reorder modality | Enter: toggle winner | C: crop | Del: delete tuple<br>
          Scroll: zoom | Drag: pan | Esc: reset
        </p>
        <div id="ic-error"></div>
        <div class="ic-version">v${__IC_VERSION__} — standalone build</div>
      </div>
    </div>`;
  document.body.appendChild(el);

  document.getElementById('ic-open')?.addEventListener('click', async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'readwrite' });
      await openRoot(createFsaBackend(handle));
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') showLandingError(err);
    }
  });

  const drop = document.getElementById('ic-drop');
  drop?.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('ic-over');
  });
  drop?.addEventListener('dragleave', () => drop.classList.remove('ic-over'));
  drop?.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('ic-over');
    try {
      const item = (e as DragEvent).dataTransfer?.items?.[0];
      if (item?.getAsFileSystemHandle) {
        const handle = await item.getAsFileSystemHandle();
        if (!handle || handle.kind !== 'directory') throw new Error('Drop a directory, not a file');
        await openRoot(createFsaBackend(handle as FileSystemDirectoryHandle));
        return;
      }
      // Firefox/Safari: no FSA handles from a drop — walk the webkit entry tree into the read-only backend.
      const entry = item?.webkitGetAsEntry?.();
      if (!entry || !entry.isDirectory) throw new Error('Drop a directory, not a file');
      await openRoot(await createDroppedEntryBackend(entry as FileSystemDirectoryEntry));
    } catch (err) {
      showLandingError(err);
    }
  });

  document.getElementById('ic-open-ro')?.addEventListener('change', async (e) => {
    try {
      const input = e.target as HTMLInputElement;
      const files = input.files ? [...input.files] : [];
      if (files.length === 0) return;
      await openRoot(createFileListBackend(files));
    } catch (err) {
      showLandingError(err);
    }
  });
}

buildLanding();

// Programmatic entry for the smoke spec (and any embedder): boot straight from a directory handle.
const seam = {
  version: __IC_VERSION__,
  // Injectable so tests can shrink the wait; read each time the poll timer is armed.
  pollIntervalMs: 4000,
  open: (handle: FileSystemDirectoryHandle) => openRoot(createFsaBackend(handle)),
  // The drop handler's non-FSA branch, exposed because a synthetic DataTransfer cannot carry entries.
  openDroppedEntry: async (entry: FileSystemDirectoryEntry) => openRoot(await createDroppedEntryBackend(entry)),
};
(window as unknown as { __ic_standalone: unknown }).__ic_standalone = seam;
