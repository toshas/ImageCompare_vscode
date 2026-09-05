/**
 * WebView main script for ImageCompare
 * Handles all UI rendering and user interactions
 */

import * as crop from './crop';
import { nextVisibleModality, isVoteClickable, displayOrderAfterInsert } from './modalityVisibility';
import { shiftIndexAfterRemoval } from '../watcherLogic';
import { ThumbUrlCache, BLANK_THUMB } from './thumbUrlCache';
import { ColumnReportGate, LOAD_DEBOUNCE_MS, SlotRank, rankCovers, tupleArrivalPlan } from './tupleLoadPlan';
import { emptyNotice } from './emptyNotice';
import {
  HostCapabilities,
  MenuActionId,
  MenuContext,
  NO_HOST_CAPABILITIES,
  buildContextMenu,
  contextMenuHelpText,
} from './contextMenuModel';
import { closeContextMenu, isContextMenuOpen, openContextMenu } from './contextMenu';
import { NoticeEvent, buildNotice } from './noticeChannel';
import { centreOffset, scrollStep, zoomFactor } from './axisScroll';

// VSCode API
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// Types (duplicated from extension for webview isolation)
interface ImageInfo {
  name: string;
  modality: string;
  tupleIndex: TupleIndex;
  modalityIndex: OriginalModalityIndex;
}

interface TupleInfo {
  name: string;
  images: ImageInfo[];
}

interface WebViewConfig {
  thumbnailSize: number;
  prefetchCount: number;
  keepZoomOnTupleChange: boolean;
}

interface LoadedImage {
  img: HTMLImageElement;
  name: string;
  modality: string;
  width: number;
  height: number;
}

// Modality colors
const MODALITY_COLORS = [
  '#0f0', '#f60', '#0af', '#f0f', '#ff0', '#f44', '#4f4', '#44f'
];

// Branded index spaces, re-declared here because the webview compiles alone (docs/tuple-matching.md trap 2).
type OriginalModalityIndex = number & { readonly __brand: 'OriginalModalityIndex' };
type DisplayModalityIndex = number & { readonly __brand: 'DisplayModalityIndex' };
// Tuple index is a single space (no display/original split); the brand guards it against modality indices.
type TupleIndex = number & { readonly __brand: 'TupleIndex' };
// Mint a brand at a real boundary (a wire value known to be original/display, or a fresh tuple/display position).
const asOriginal = (n: number): OriginalModalityIndex => n as OriginalModalityIndex;
const asDisplay = (n: number): DisplayModalityIndex => n as DisplayModalityIndex;
const asTuple = (n: number): TupleIndex => n as TupleIndex;
// The only sanctioned conversions: modalityOrder is the one bridge (order[display] = original).
function toOriginal(display: DisplayModalityIndex, order: readonly OriginalModalityIndex[]): OriginalModalityIndex {
  return order[display];
}
function toDisplay(original: OriginalModalityIndex, order: readonly OriginalModalityIndex[]): DisplayModalityIndex {
  return asDisplay(order.indexOf(original));
}

// DOM Elements
const loadingEl = document.getElementById('loading')!;
const viewerEl = document.getElementById('viewer')!;
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvasEl.getContext('2d')!;
const infoEl = document.getElementById('info')!;
const statusEl = document.getElementById('status')!;
const statusNameEl = document.getElementById('status-name')!;
const statusInfoEl = document.getElementById('status-info')!;
const modalitySelectorEl = document.getElementById('modality-selector')!;
const pillTooltipEl = document.getElementById('pill-tooltip')!;
const copyToastEl = document.getElementById('copy-toast')!;
const floatingPanelEl = document.getElementById('floating-panel')!;
const fpHeaderEl = document.getElementById('fp-header')!;
const fpCollapseBtn = document.getElementById('fp-collapse-btn')!;
const cropBtn = document.getElementById('crop-btn')!;
const deleteBtn = document.getElementById('delete-btn')!;
const pptxBtn = document.getElementById('pptx-btn')!;
const thumbCanvasEl = document.getElementById('thumb-canvas') as HTMLCanvasElement;
const thumbCtx = thumbCanvasEl.getContext('2d')!;
const thumbViewportEl = document.getElementById('thumb-viewport')!;
const carouselEl = document.getElementById('carousel')!;
const carouselResizeEl = document.getElementById('carousel-resize')!;
const progressContainerEl = document.getElementById('progress-container')!;
const progressTextEl = document.getElementById('progress-text')!;
const progressFillEl = document.getElementById('progress-fill')!;
const helpModalEl = document.getElementById('help-modal')!;
const helpVersionEl = document.getElementById('help-version')!;
const helpBtn = document.getElementById('help-btn')!;
const helpContextMenuItemsEl = document.getElementById('help-contextmenu-items')!;
const helpRowSaveSessionEl = document.getElementById('help-row-savesession')!;
const closeHelpBtn = document.getElementById('close-help-btn')!;
const reorderLeftBtn = document.getElementById('reorder-left')!;
const reorderRightBtn = document.getElementById('reorder-right')!;
const imageLoaderEl = document.getElementById('image-loader')!;
const emptyNoticeEl = document.getElementById('empty-notice')!;
const emptyNoticeTitleEl = document.getElementById('empty-notice-title')!;
const emptyNoticeDetailEl = document.getElementById('empty-notice-detail')!;

// Constants
const THUMB_MAX_SIZE = 150;

// Placeholder image for missing/error thumbnails (simple gray X)
const PLACEHOLDER_THUMB = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 50;
  canvas.height = 50;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, 50, 50);
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(15, 15);
  ctx.lineTo(35, 35);
  ctx.moveTo(35, 15);
  ctx.lineTo(15, 35);
  ctx.stroke();
  return canvas.toDataURL();
})();

// State
let tuples: TupleInfo[] = [];
let modalities: string[] = [];
let modalityPaths: string[] = [];
let modalityColors: string[] = [];
let config: WebViewConfig = { thumbnailSize: 100, prefetchCount: 3, keepZoomOnTupleChange: false };

let currentTupleIndex: TupleIndex = asTuple(0);
let currentModalityIndex: DisplayModalityIndex = asDisplay(0);
let previousModalityIndex: DisplayModalityIndex = asDisplay(0);

let rootMissingPath: string | null = null; // the comparison's folder, once the host says it is gone (docs/file-watching.md: root-loss-reported-as-an-edge)
let images: (LoadedImage | undefined)[] = []; // Current tuple's loaded images (may have undefined slots)
let loadedTuples: Map<TupleIndex, LoadedImage[]> = new Map();
// "tupleIdx-modIdx" -> object url (or the ✕ placeholder data url): it owns every url a row shows (docs/loading-architecture.md: thumb-url-owned-by-cache).
const thumbnailUrls = new ThumbUrlCache(url => URL.revokeObjectURL(url));

let zoom = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let spaceDown = false;

let CAROUSEL_WIDTH = 220;
let CAROUSEL_THUMB_SIZE = 50;

let isMultiTupleMode = false;
let modalityOrder: OriginalModalityIndex[] = []; // maps display position -> original modality index
let loadDebounceTimer: number | null = null; // debounce timer for loading full images
let lastNavAt = 0; // timestamp of the previous tuple navigation (for leading-edge debounce)
// Armed on arrival, cleared by the next navigation: siblings of a tuple scrolled past are never asked for (docs/loading-architecture.md: siblings-dwell-gated).
let siblingDwellTimer: number | null = null;
// Slots asked for and not yet answered, each with the rank it was asked at, so a repaint cannot re-ask but a promotion can (docs/loading-architecture.md: siblings-dwell-gated, request-rank-upgrades).
const requestedSlots = new Map<string, SlotRank>();

// Winner voting state
let winners: Map<TupleIndex, DisplayModalityIndex> = new Map(); // tupleIndex -> modalityIndex (display index)
// Presentation only — nothing but pill styling, the menu label, and keyboard cycling reads this set (docs/session-files.md: hidden-is-presentation-only).
let hiddenModalities: Set<OriginalModalityIndex> = new Set();
const hiddenByDisplay = (): boolean[] => modalityOrder.map(o => hiddenModalities.has(o));
let votingEnabled = false;

// Busy until the provider answers; safe only because it always does (docs/crop-and-pptx.md: export-always-answers).
let pptxBusy = false;
function setPptxBusy(busy: boolean): void {
  pptxBusy = busy;
  pptxBtn.classList.toggle('busy', busy);
}

// Session-file labels are user-authored: show them in full, never truncated.
let labelsExplicit = false;

// What this host can serve. Capability, never identity: no branch here asks whether it is VS Code (docs/standalone.md: affordances-rendered-by-the-webview).
let capabilities: HostCapabilities = NO_HOST_CAPABILITIES;

// Read-only state snapshot for the Playwright webview testbed (test/webview); inert unless the harness sets __ic_test_enabled — see docs/testing.md.
if (typeof window !== 'undefined' && (window as unknown as { __ic_test_enabled?: boolean }).__ic_test_enabled) {
  (window as unknown as { __ic_test: unknown }).__ic_test = {
    getState: () => ({
      currentTupleIndex,
      currentModalityIndex,
      currentTupleName: tuples[currentTupleIndex]?.name ?? null,
      tupleCount: tuples.length,
      modalityCount: modalities.length,
      modalityOrder: modalityOrder.slice(),
      modalityPaths: modalityPaths.slice(),
      hiddenModalities: Array.from(hiddenModalities),
      zoom,
      panX,
      panY,
      cropMode: crop.cropMode,
      cropRect: crop.cropRect ? { ...crop.cropRect } : null,
      winners: Array.from(winners.entries()),
      votingEnabled,
      pptxBusy,
      thumbUrlsLive: thumbnailUrls.liveCount,
      capabilities: { ...capabilities },
    }),
  };
}

// Floating panel drag state
let fpDragging = false;
let fpDragStartX = 0;
let fpDragStartY = 0;
let fpDragStartLeft = 0;
let fpDragStartTop = 0;

// Helper to update status bar with consistent layout
function updateStatus(name: string, info: string, tupleIndex?: number) {
  let prefix = '';
  if (isMultiTupleMode && tupleIndex !== undefined) {
    prefix = `[${tupleIndex + 1}/${tuples.length}] `;
  }
  statusNameEl.textContent = prefix + name;
  statusInfoEl.textContent = info;
}

// Initialize
function init() {
  // Send ready message to extension
  vscode.postMessage({ type: 'ready' });

  // Set up event listeners
  setupEventListeners();

  // Focus the document so keyboard shortcuts work immediately
  document.body.tabIndex = -1;
  document.body.focus();
}

function setupEventListeners() {
  // Help modal
  helpBtn.addEventListener('click', () => helpModalEl.classList.add('active'));
  closeHelpBtn.addEventListener('click', () => helpModalEl.classList.remove('active'));

  // Reorder buttons
  reorderLeftBtn.addEventListener('click', () => moveCurrentModality(-1));
  reorderRightBtn.addEventListener('click', () => moveCurrentModality(1));

  // Keyboard
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);

  // Mouse wheel zoom
  viewerEl.addEventListener('wheel', handleWheel, { passive: false });

  // Mouse drag pan
  viewerEl.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('copy', handleCopyEvent);

  // Carousel wheel; the wall is not a native scroll container, so there is no scroll event to hook.
  carouselEl.addEventListener('wheel', handleCarouselWheel, { passive: false });
  modalitySelectorEl.addEventListener('wheel', handlePillWheel, { passive: false });

  // Carousel resize
  setupCarouselResize();

  // The visible-row window is computed from clientHeight, which is 0 until the viewer unhides — and changes on vertical panel resizes. The one paint-path re-centre the rule allows, height-only: width drags must not re-center, the resize anchor owns those (docs/loading-architecture.md: selection-centres-on-navigation).
  let lastCarouselViewH = 0;
  new ResizeObserver(() => {
    const h = carouselEl.clientHeight;
    if (h === lastCarouselViewH) return;
    lastCarouselViewH = h;
    if (isMultiTupleMode && carouselWallEl) scrollCarouselToCurrentTuple();
  }).observe(carouselEl);

  // Window resize
  window.addEventListener('resize', () => {
    if (images.length) render();
  });

  // Floating panel: drag to move, click (without drag) to collapse/expand
  let fpDidDrag = false;
  fpHeaderEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fpDragging = true;
    fpDidDrag = false;
    fpDragStartX = e.clientX;
    fpDragStartY = e.clientY;
    const rect = floatingPanelEl.getBoundingClientRect();
    fpDragStartLeft = rect.left;
    fpDragStartTop = rect.top;
  });
  document.addEventListener('mousemove', (e) => {
    if (!fpDragging) return;
    const dx = e.clientX - fpDragStartX;
    const dy = e.clientY - fpDragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      if (!fpDidDrag) document.body.style.cursor = 'move';
      fpDidDrag = true;
      floatingPanelEl.style.right = 'auto';
      floatingPanelEl.style.left = (fpDragStartLeft + dx) + 'px';
      floatingPanelEl.style.top = (fpDragStartTop + dy) + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (fpDragging && !fpDidDrag) {
      floatingPanelEl.classList.toggle('collapsed');
      fpCollapseBtn.textContent = floatingPanelEl.classList.contains('collapsed') ? '\u25b8' : '\u25be';
    }
    if (fpDidDrag) document.body.style.cursor = '';
    fpDragging = false;
  });

  // Crop button
  cropBtn.addEventListener('click', () => {
    if (crop.cropMode) {
      crop.exitCropMode();
    } else {
      tryEnterCropMode();
    }
  });

  // Delete button
  deleteBtn.addEventListener('click', deleteCurrentTuple);

  // PPTX export button
  pptxBtn.addEventListener('click', () => {
    if (pptxBusy) return;
    // Collect tuples that have winners (voted for)
    const tupleIndices: TupleIndex[] = [];
    // Original space: the wire is always the original index (docs/tuple-matching.md: wire-index-is-original).
    const winnerModalityIndices: (OriginalModalityIndex | null)[] = [];
    for (let i = 0; i < tuples.length; i++) {
      const t = asTuple(i);
      if (winners.has(t)) {
        tupleIndices.push(t);
        // winners holds display indices; convert to original before sending.
        const displayIdx = winners.get(t);
        winnerModalityIndices.push(displayIdx === undefined ? null : (toOriginal(displayIdx, modalityOrder) ?? null));
      }
    }
    if (tupleIndices.length === 0) {
      // No votes: export the whole view, null winner per tuple (docs/crop-and-pptx.md).
      for (let i = 0; i < tuples.length; i++) {
        tupleIndices.push(asTuple(i));
        winnerModalityIndices.push(null);
      }
    }
    setPptxBusy(true);
    vscode.postMessage({ type: 'exportPptx', tupleIndices, winnerModalityIndices, modalityOrder });
  });
}

// Delete the current tuple's files from disk (no confirmation, per user choice)
function deleteCurrentTuple() {
  vscode.postMessage({ type: 'deleteTuple', tupleIndex: currentTupleIndex });
}

// Crop confirmation callback
function handleCropConfirm() {
  if (!crop.cropRect) return;
  const currentImage = images[currentModalityIndex];
  if (!currentImage) return;
  vscode.postMessage({
    type: 'cropImages',
    tupleIndex: currentTupleIndex,
    cropRect: { x: crop.cropRect.x, y: crop.cropRect.y, w: crop.cropRect.w, h: crop.cropRect.h },
    // Decoded-image dims: a denominator for the extension, never an extraction size (docs/crop-and-pptx.md: srcdims-are-denominator).
    srcWidth: currentImage.width,
    srcHeight: currentImage.height
  });
  crop.exitCropMode();
}

function getCurrentViewport(): crop.ViewportInfo | undefined {
  const currentImage = images[currentModalityIndex];
  // The missing sentinel is truthy but has no dims, and undefined dims make every mapped rect NaN.
  if (!currentImage || (currentImage as any).missing) return undefined;
  const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
  return {
    viewerEl,
    zoom,
    panX,
    panY,
    imgW: currentImage.width,
    imgH: currentImage.height,
    carouselOffset
  };
}

// Refusing beats a crop mode whose rect-drawing handlers bail on a null viewport, leaving it inert (docs/crop-and-pptx.md: crop-needs-viewport).
function tryEnterCropMode(): void {
  const vp = getCurrentViewport();
  if (!vp) {
    updateStatus('Crop unavailable: image not loaded', '', currentTupleIndex);
    return;
  }
  crop.enterCropMode(viewerEl, handleCropConfirm, vp);
  cropBtn.classList.add('active');
}

// Handle messages from extension
window.addEventListener('message', (event) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      handleInit(message);
      break;
    case 'thumbnail':
      handleThumbnail(message);
      break;
    case 'thumbnailError':
      handleThumbnailError(message);
      break;
    case 'image':
      handleImage(message);
      break;
    case 'imageError':
      handleImageError(message);
      break;
    case 'thumbnailProgress':
      handleProgress(message);
      break;
    case 'notice':
      showNotice(message.event);
      break;
    case 'fileDeleted':
      console.log('[IC] fileDeleted', message.tupleIndex, message.modalityIndex);
      handleFileDeleted(message);
      break;
    case 'fileRestored':
      console.log('[IC] fileRestored', message.tupleIndex, message.modalityIndex);
      handleFileRestored(message);
      break;
    case 'tupleDeleted':
      console.log('[IC] tupleDeleted', message.tupleIndex);
      handleTupleDeleted(message);
      break;
    case 'tupleAdded':
      console.log('[IC] tupleAdded', message.tupleIndex, message.tuple?.name);
      handleTupleAdded(message);
      break;
    case 'modalityAdded':
      handleModalityAdded(message);
      break;
    case 'modalityRemoved':
      handleModalityRemoved(message);
      break;
    case 'rootMissing':
      // Only the notice's wording depends on this; a re-render refines or clears it (docs/file-watching.md: root-loss-reported-as-an-edge).
      rootMissingPath = message.path;
      render();
      break;
    case 'winnerUpdated':
      handleWinnerUpdated(message);
      break;
    case 'winnersReset':
      handleWinnersReset(message);
      break;
    case 'cropComplete':
      updateStatus(`Cropped ${message.count} image(s)`, '', currentTupleIndex);
      break;
    case 'cropError':
      updateStatus(`Crop failed: ${message.error}`, '', currentTupleIndex);
      break;
    case 'pptxComplete':
      setPptxBusy(false);
      showNotice({ kind: 'pptxSaved', path: message.path });
      break;
    case 'pptxError':
      setPptxBusy(false);
      showNotice({ kind: 'pptxFailed', error: message.error });
      break;
    case '_debug':
      console.log('[IC-EXT]', message.msg);
      break;
  }
});

function handleWinnerUpdated(message: { tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex | null }) {
  if (message.modalityIndex === null) {
    winners.delete(message.tupleIndex);
  } else {
    // Original modality index -> display index (modalityOrder[displayIdx] = originalIdx).
    const displayIdx = toDisplay(message.modalityIndex, modalityOrder);
    if (displayIdx !== -1) {
      winners.set(message.tupleIndex, displayIdx);
    }
  }
  updateCarouselWinners();
  updateModalitySelector();
}

function handleWinnersReset(message: { winners: Record<number, OriginalModalityIndex> }) {
  winners = new Map();
  for (const [tupleIdx, originalModalityIdx] of Object.entries(message.winners)) {
    const displayIdx = toDisplay(originalModalityIdx, modalityOrder);
    if (displayIdx !== -1) {
      winners.set(asTuple(parseInt(tupleIdx, 10)), displayIdx);
    }
  }
  updateCarouselWinners();
  updateModalitySelector();
}

function handleInit(message: { tuples: TupleInfo[]; modalities: string[]; modalityPaths: string[]; modalityColors?: string[]; config: WebViewConfig; winners: Record<number, OriginalModalityIndex>; votingEnabled: boolean; labelsExplicit: boolean; version?: string; capabilities?: HostCapabilities }) {
  // Absent/empty version renders nothing: the :empty CSS rule hides the footer entirely.
  helpVersionEl.textContent = message.version ? `ImageCompare v${message.version}` : '';
  capabilities = message.capabilities ?? NO_HOST_CAPABILITIES;
  applyCapabilitiesToHelp();
  // Reset all state for new comparison
  tuples = message.tuples;
  modalities = message.modalities;
  modalityPaths = message.modalityPaths;
  labelsExplicit = message.labelsExplicit;
  config = message.config;
  modalityColors = message.modalityColors && message.modalityColors.length === modalities.length
    ? message.modalityColors.slice()
    : modalities.map((_, i) => MODALITY_COLORS[i % MODALITY_COLORS.length]);
  modalityOrder = modalities.map((_, i) => asOriginal(i)); // Initialize order: [0, 1, 2, ...]

  // Load winner state
  votingEnabled = message.votingEnabled;
  winners = new Map();
  if (message.winners) {
    for (const [tupleIdx, modalityIdx] of Object.entries(message.winners)) {
      // order is identity here, so toDisplay is an identity remap; keep the conversion explicit.
      winners.set(asTuple(parseInt(tupleIdx, 10)), toDisplay(modalityIdx, modalityOrder));
    }
  }

  // Reset navigation state
  currentTupleIndex = asTuple(0);
  currentModalityIndex = asDisplay(0);
  previousModalityIndex = asDisplay(0);

  // Clear caches
  images = [];
  loadedTuples.clear();
  thumbnailUrls.clear();
  hiddenModalities.clear();
  rootMissingPath = null; // a fresh comparison inherits no previous root's verdict
  // Index-keyed and every index just changed identity; a stale bit would cost a slot its one retry.
  decodeRetried.clear();
  requestedSlots.clear(); // same index-shift reason: a stale mark would suppress the slot's re-request

  // Reset view state
  zoom = 1;
  panX = 0;
  panY = 0;
  lastNavAt = 0;

  // Cancel any pending load
  if (loadDebounceTimer !== null) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }
  if (siblingDwellTimer !== null) {
    clearTimeout(siblingDwellTimer);
    siblingDwellTimer = null;
  }

  // Hide loader if visible
  canvasEl.classList.remove('preview');
  imageLoaderEl.classList.remove('active');

  isMultiTupleMode = tuples.length > 1;

  // Open wide enough for every modality column at 30px, within a 40%-of-window budget.
  CAROUSEL_WIDTH = Math.max(220, Math.min(carouselFitWidth(30), Math.floor(window.innerWidth * 0.4)));

  // Calculate carousel thumb size
  updateCarouselThumbSize();

  // Build carousel
  if (isMultiTupleMode) {
    buildCarousel();
  }

  // Pills are created here once; loadTuple only updates them (rebuild per keystroke stalled the carousel).
  buildModalitySelector();

  // Request first tuple's images
  loadTuple(asTuple(0));

  // Hide loading, show UI
  loadingEl.classList.add('hidden');
  viewerEl.classList.add('active');
  infoEl.classList.remove('hidden');

  // Show progress if generating thumbnails
  if (isMultiTupleMode) {
    progressContainerEl.classList.add('active');
  }
}

function handleThumbnail(message: { tupleIndex: TupleIndex; modalityIndex: number; bytes: Uint8Array; mime: string }) {
  const key = `${message.tupleIndex}-${message.modalityIndex}`;
  // Binary payload -> Blob URL, like the full-image path: base64 thumbs cost ×1.33 on the wire and string churn at ~1000 tiles.
  const url = URL.createObjectURL(new Blob([message.bytes as Uint8Array<ArrayBuffer>], { type: message.mime }));

  const thumb = carouselTileFor(message.tupleIndex, message.modalityIndex);

  thumbnailUrls.set(key, url, () => {
    if (!thumb) return;
    thumb.src = url;
    thumb.classList.remove('placeholder');
    thumb.classList.remove('missing');
  });
}

// Carousel slots whose one thumbnail re-request is spent; consumed on the next failure so a fresh delivery re-arms (docs/loading-architecture.md: decode-retry-once).
const thumbRetried = new Set<string>();

function handleThumbDecodeFailure(img: HTMLImageElement): void {
  const tuple = img.dataset.tuple;
  const modality = img.dataset.modality;
  if (tuple === undefined || modality === undefined) return;
  const key = `${tuple}-${modality}`;
  // Cache the placeholder so pooled-row rebinds repaint it instead of re-hitting the corrupt url.
  thumbnailUrls.set(key, PLACEHOLDER_THUMB, () => { img.src = PLACEHOLDER_THUMB; });
  img.classList.remove('placeholder');
  img.classList.add('missing');
  if (thumbRetried.has(key)) {
    thumbRetried.delete(key);
    return;
  }
  thumbRetried.add(key);
  vscode.postMessage({ type: 'requestThumbnails', tupleIndices: [asTuple(parseInt(tuple, 10))] });
}

function handleThumbnailError(message: { tupleIndex: TupleIndex; modalityIndex: number; error: string }) {
  console.warn(`Thumbnail unavailable for ${message.tupleIndex}-${message.modalityIndex}: ${message.error}`);
  
  // Store placeholder in the url cache so it persists across carousel rebuilds
  const key = `${message.tupleIndex}-${message.modalityIndex}`;

  const thumb = carouselTileFor(message.tupleIndex, message.modalityIndex);

  thumbnailUrls.set(key, PLACEHOLDER_THUMB, () => {
    if (!thumb) return;
    thumb.src = PLACEHOLDER_THUMB;
    thumb.classList.add('missing');
  });
}

// Slots re-requested after a decode failure; bounds the retry to one — see docs/loading-architecture.md.
const decodeRetried = new Set<string>();

let payloadShapeLogged = false;

function handleImage(message: { tupleIndex: TupleIndex; modalityIndex: number; bytes: Uint8Array; mime: string; width: number; height: number }) {
  requestedSlots.delete(`${message.tupleIndex}-${message.modalityIndex}`);
  // One-time shape log: if the serializer ever mangles the binary payload, this is the first place it shows.
  if (!payloadShapeLogged) {
    payloadShapeLogged = true;
    console.log(`[IC] image payload arrives as ${(message.bytes as any)?.constructor?.name} byteLength=${message.bytes?.byteLength} mime=${message.mime}`);
  }
  // Binary payload → Blob URL: base64 data-URL strings cost ×1.33 on the wire and GC pauses at scale.
  const blobUrl = URL.createObjectURL(new Blob([message.bytes as Uint8Array<ArrayBuffer>], { type: message.mime }));
  const img = new Image();
  img.onload = () => {
    // The decoded Image element holds the pixels; the URL is only needed until then.
    URL.revokeObjectURL(blobUrl);
    // Deferred callback: the tuple may have been deleted while this decoded.
    const tuple = tuples[message.tupleIndex];
    const imageInfo = tuple && tuple.images[message.modalityIndex];
    if (!imageInfo) return;

    // Decoded fine — let a future transient failure on this slot retry again.
    decodeRetried.delete(`${message.tupleIndex}-${message.modalityIndex}`);

    const tupleImages = loadedTuples.get(message.tupleIndex) || [];
    const loadedImage: LoadedImage = {
      img,
      name: imageInfo.name,
      modality: imageInfo.modality,
      // Decoded image is authoritative; message dims only for the converted TIFF/PPMX path — see docs/loading-architecture.md.
      width: img.naturalWidth || message.width,
      height: img.naturalHeight || message.height
    };

    while (tupleImages.length <= message.modalityIndex) {
      tupleImages.push(undefined as any);
    }
    tupleImages[message.modalityIndex] = loadedImage;
    loadedTuples.set(message.tupleIndex, tupleImages);

    if (message.tupleIndex === currentTupleIndex) {
      images = reorderImagesForDisplay(tupleImages);
      render();

      const allLoaded = images.every(img => img !== undefined);
      if (allLoaded) {
        postTupleFullyLoaded(currentTupleIndex);
      }
    }
  };
  // Transient decode failure: re-request once rather than marking the slot missing (docs/loading-architecture.md: decode-retry-once).
  img.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    console.error(`[IC] image decode failed ${message.tupleIndex}-${message.modalityIndex}: bytes=${(message.bytes as any)?.constructor?.name} byteLength=${message.bytes?.byteLength} mime=${message.mime}`);
    const key = `${message.tupleIndex}-${message.modalityIndex}`;
    if (decodeRetried.has(key)) {
      handleImageError({
        tupleIndex: message.tupleIndex,
        modalityIndex: message.modalityIndex,
        error: 'decode failed'
      });
      return;
    }
    decodeRetried.add(key);
    // Re-derive the original priority: omitting `sibling` would promote a sibling's retry to VISIBLE.
    const onScreen = message.tupleIndex === currentTupleIndex &&
      modalityOrder[currentModalityIndex] === message.modalityIndex;
    // forceReload is required: without it the retry is served the same cached, undecodable bytes.
    requestSlot(asTuple(message.tupleIndex), asOriginal(message.modalityIndex), onScreen ? 'visible' : 'sibling', true);
  };
  img.src = blobUrl;
}

function handleImageError(message: { tupleIndex: TupleIndex; modalityIndex: number; error: string }) {
  requestedSlots.delete(`${message.tupleIndex}-${message.modalityIndex}`);
  console.warn(`Image unavailable for ${message.tupleIndex}-${message.modalityIndex}: ${message.error}`);

  // Ignore if the tuple was removed while this was in flight.
  if (message.tupleIndex >= tuples.length) return;

  const tupleImages = loadedTuples.get(message.tupleIndex) || [];
  while (tupleImages.length <= message.modalityIndex) {
    tupleImages.push(undefined as any);
  }
  tupleImages[message.modalityIndex] = { missing: true } as any;
  loadedTuples.set(message.tupleIndex, tupleImages);

  if (message.tupleIndex === currentTupleIndex) {
    images = reorderImagesForDisplay(tupleImages);
    render();

    // A fully-loaded tuple (missing slots included) unblocks prefetch.
    const allLoaded = images.every(img => img !== undefined);
    if (allLoaded) {
      postTupleFullyLoaded(currentTupleIndex);
    }
  }
}

function showMissingPlaceholder() {
  // Clear canvas and show missing message
  const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
  
  canvasEl.width = 400;
  canvasEl.height = 200;
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, 400, 200);
  ctx.fillStyle = '#888';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Image not available', 200, 100);
  
  canvasEl.style.width = '400px';
  canvasEl.style.height = '200px';
  
  const centerOffsetX = carouselOffset / 2;
  canvasEl.style.transform = `translate(calc(-50% + ${centerOffsetX}px), -50%)`;
}

function handleProgress(message: { current: number; total: number }) {
  const percent = message.total > 0 ? Math.round((message.current / message.total) * 100) : 0;
  progressFillEl.style.width = `${percent}%`;
  progressTextEl.textContent = `${message.current}/${message.total}`;

  if (message.current >= message.total) {
    setTimeout(() => {
      progressContainerEl.classList.remove('active');
    }, 500);
  }
}

function handleFileDeleted(message: { tupleIndex: TupleIndex; modalityIndex: number }) {
  // Clear from loadedTuples - mark as missing
  const tupleImages = loadedTuples.get(message.tupleIndex);
  if (tupleImages) {
    tupleImages[message.modalityIndex] = { missing: true } as any;
  }

  // The missing sentinel must live in the map: recycled rows repaint from it (message.modalityIndex is already the global/original index).
  const thumbKey = `${message.tupleIndex}-${message.modalityIndex}`;

  // Update carousel to show placeholder for missing file
  const thumb = carouselTileFor(message.tupleIndex, message.modalityIndex);
  thumbnailUrls.set(thumbKey, PLACEHOLDER_THUMB, () => {
    if (!thumb) return;
    thumb.src = PLACEHOLDER_THUMB;
    thumb.classList.add('missing');
    thumb.classList.remove('placeholder');
  });
  
  // If this is the current tuple, update display
  if (message.tupleIndex === currentTupleIndex) {
    images = tupleImages ? reorderImagesForDisplay(tupleImages) : [];
    // If current modality was deleted, try to switch to another
    if (!images[currentModalityIndex] || (images[currentModalityIndex] as any).missing) {
      const availableIdx = images.findIndex(img => img && !(img as any).missing);
      if (availableIdx >= 0) {
        currentModalityIndex = asDisplay(availableIdx);
      }
    }
    render();
  }
}

function handleFileRestored(message: { tupleIndex: TupleIndex; modalityIndex: number; imageInfo?: any }) {
  // Update the tuple's image info if provided (e.g. a new file was added to an existing tuple)
  const tuple = tuples[message.tupleIndex];
  if (message.imageInfo && tuple && tuple.images[message.modalityIndex]) {
    tuple.images[message.modalityIndex].name = message.imageInfo.name;
  }

  // Clear the error marker from loadedTuples
  const tupleImages = loadedTuples.get(message.tupleIndex);
  if (tupleImages && tupleImages[message.modalityIndex]) {
    // Remove the error marker (will be reloaded)
    tupleImages[message.modalityIndex] = undefined as any;
  }

  // Clear thumbnail data URL so it gets regenerated (message.modalityIndex is already the global index)
  const thumbKey = `${message.tupleIndex}-${message.modalityIndex}`;
  thumbnailUrls.delete(thumbKey);

  // Update carousel to remove missing state
  const thumb = carouselTileFor(message.tupleIndex, message.modalityIndex);
  if (thumb) {
    thumb.classList.remove('missing');
  }

  // If this is the current tuple, update display and request the restored image
  if (message.tupleIndex === currentTupleIndex) {
    images = tupleImages ? reorderImagesForDisplay(tupleImages) : [];
    render();
    // Request the image so it actually loads (instead of just showing spinner)
    requestSlot(asTuple(message.tupleIndex), asOriginal(message.modalityIndex), 'visible');
  }
}

function handleTupleDeleted(message: { tupleIndex: TupleIndex }) {
  // decodeRetried is index-keyed and a removal shifts every later index; clearing is cheaper than re-indexing.
  decodeRetried.clear();
  requestedSlots.clear(); // same index-shift reason: a stale mark would suppress the slot's re-request
  tuples.splice(message.tupleIndex, 1);
  loadedTuples.delete(message.tupleIndex);

  // Re-index loaded tuples (shift indices down)
  const newLoadedTuples = new Map<TupleIndex, LoadedImage[]>();
  for (const [idx, imgs] of loadedTuples) {
    if (idx > message.tupleIndex) {
      newLoadedTuples.set(asTuple(idx - 1), imgs);
    } else {
      newLoadedTuples.set(idx, imgs);
    }
  }
  loadedTuples.clear();
  for (const [idx, imgs] of newLoadedTuples) {
    loadedTuples.set(idx, imgs);
  }

  // Re-index thumbnail urls (shift indices down); the removed row's are nobody's, so they are revoked.
  thumbnailUrls.rekey((tIdx, mIdx) =>
    tIdx === message.tupleIndex ? null : `${tIdx > message.tupleIndex ? tIdx - 1 : tIdx}-${mIdx}`);

  // Re-index winners (shift indices down)
  const newWinners = new Map<TupleIndex, DisplayModalityIndex>();
  for (const [tIdx, mIdx] of winners) {
    if (tIdx > message.tupleIndex) {
      newWinners.set(asTuple(tIdx - 1), mIdx);
    } else if (tIdx < message.tupleIndex) {
      newWinners.set(tIdx, mIdx);
    }
    // tIdx === message.tupleIndex: discard
  }
  winners.clear();
  for (const [tIdx, mIdx] of newWinners) {
    winners.set(tIdx, mIdx);
  }

  // Adjust current tuple index if needed
  if (currentTupleIndex >= tuples.length) {
    currentTupleIndex = asTuple(Math.max(0, tuples.length - 1));
  } else if (currentTupleIndex > message.tupleIndex) {
    currentTupleIndex--;
  }

  // Always update multi-tuple mode and rebuild carousel
  isMultiTupleMode = tuples.length > 1;
  buildCarousel();

  // Unconditional: at zero rows loadTuple raises the notice instead, and nothing else would (docs/loading-architecture.md: empty-comparison-is-terminal).
  loadTuple(currentTupleIndex);
}

function handleTupleAdded(message: { tuple: TupleInfo; tupleIndex: TupleIndex }) {
  // A row arriving into an empty comparison becomes the view; nothing else re-aims it (docs/loading-architecture.md: empty-comparison-is-terminal).
  const wasEmpty = tuples.length === 0;
  // decodeRetried is index-keyed and an insertion shifts every later index; clearing is cheaper than re-indexing.
  decodeRetried.clear();
  requestedSlots.clear(); // same index-shift reason: a stale mark would suppress the slot's re-request
  // Add the new tuple at the specified index
  tuples.splice(message.tupleIndex, 0, message.tuple);

  // Re-index loaded tuples (shift indices up)
  const newLoadedTuples = new Map<TupleIndex, LoadedImage[]>();
  for (const [idx, imgs] of loadedTuples) {
    if (idx >= message.tupleIndex) {
      newLoadedTuples.set(asTuple(idx + 1), imgs);
    } else {
      newLoadedTuples.set(idx, imgs);
    }
  }
  loadedTuples.clear();
  for (const [idx, imgs] of newLoadedTuples) {
    loadedTuples.set(idx, imgs);
  }

  // Re-index thumbnail urls (shift indices up); nothing is dropped, so nothing is revoked.
  thumbnailUrls.rekey((tIdx, mIdx) => `${tIdx >= message.tupleIndex ? tIdx + 1 : tIdx}-${mIdx}`);

  // Re-index winners (shift indices up)
  const newWinners = new Map<TupleIndex, DisplayModalityIndex>();
  for (const [tIdx, mIdx] of winners) {
    if (tIdx >= message.tupleIndex) {
      newWinners.set(asTuple(tIdx + 1), mIdx);
    } else {
      newWinners.set(tIdx, mIdx);
    }
  }
  winners = newWinners;

  // The >= guard mirrors the extension side (docs/file-watching.md: mutation-never-strands-view).
  if (currentTupleIndex >= message.tupleIndex) {
    currentTupleIndex++;
  }

  // Update multi-tuple mode
  isMultiTupleMode = tuples.length > 1;

  // Rebuild carousel and request thumbnail for new tuple
  if (isMultiTupleMode) {
    updateCarouselThumbSize();
    buildCarousel();
  }
  // Only the new row needs data; shifted rows repaint from the re-indexed map (docs/tuple-matching.md: revalidate-slot-before-write).
  vscode.postMessage({ type: 'requestThumbnails', tupleIndices: [message.tupleIndex] });

  // The increment above aimed past the only row there is; the returning content takes the view.
  if (wasEmpty) {
    currentTupleIndex = asTuple(0);
    loadTuple(currentTupleIndex);
  }
}

function handleModalityAdded(message: { modality: string; modalityPath: string; modalityColors: string[]; modalityIndex: OriginalModalityIndex }) {
  // A column arriving into a comparison with none becomes the view, as a row does (docs/loading-architecture.md: empty-comparison-is-terminal).
  const hadNoColumns = modalities.length === 0;
  // The user's arrangement survives the insert; the new column lands beside its original-order predecessor (docs/tuple-matching.md: rearrangement-survives-insert).
  const inserted = displayOrderAfterInsert(modalityOrder, message.modalityIndex);
  const displayPos = inserted.displayPos;
  modalities.splice(displayPos, 0, message.modality);
  modalityPaths.splice(displayPos, 0, message.modalityPath);
  // message.modalityColors is original-order over the post-insert set; permute into the preserved display order.
  modalityColors = inserted.order.map(o => message.modalityColors[o]);

  // winners hold display indices: the arrangement is preserved, so only slots at/after the insertion point shift.
  const shiftedWinners = new Map<TupleIndex, DisplayModalityIndex>();
  for (const [tIdx, displayIdx] of winners) {
    shiftedWinners.set(tIdx, asDisplay(displayIdx >= displayPos ? displayIdx + 1 : displayIdx));
  }
  winners = shiftedWinners;

  // Original-index-keyed, so it shifts with the splice like everything else (docs/file-watching.md: reindex-in-lockstep).
  hiddenModalities = new Set([...hiddenModalities].map(o => asOriginal(o >= message.modalityIndex ? o + 1 : o)));

  modalityOrder = inserted.order.map(o => asOriginal(o));

  // Focus stays where the user is; only its display index may shift.
  currentModalityIndex = asDisplay(currentModalityIndex >= displayPos ? currentModalityIndex + 1 : currentModalityIndex);
  previousModalityIndex = asDisplay(previousModalityIndex >= displayPos ? previousModalityIndex + 1 : previousModalityIndex);
  
  // Update ALL tuples to have a placeholder for the new modality
  for (let t = 0; t < tuples.length; t++) {
    const tuple = tuples[t];
    // Insert placeholder ImageInfo for new modality
    const placeholder: ImageInfo = {
      name: '', // Empty name marks a missing slot, keeping webview tuples dense (docs/tuple-matching.md: sparse-vs-dense-tuples)
      modality: message.modality,
      tupleIndex: asTuple(t),
      modalityIndex: message.modalityIndex
    };
    tuple.images.splice(message.modalityIndex, 0, placeholder);

    // Update modalityIndex for subsequent images
    for (let i = message.modalityIndex + 1; i < tuple.images.length; i++) {
      tuple.images[i].modalityIndex = asOriginal(i);
    }
  }
  
  // Re-index the caches instead of clearing them, like the tuple handlers do — a wholesale clear blanks every loaded thumbnail and prefetched neighbour on screen.
  for (const [idx, imgs] of loadedTuples) {
    const shifted: LoadedImage[] = [];
    imgs.forEach((img, i) => { shifted[i >= message.modalityIndex ? i + 1 : i] = img; });
    loadedTuples.set(idx, shifted);
  }
  thumbnailUrls.rekey((tIdx, mIdx) => `${tIdx}-${mIdx >= message.modalityIndex ? mIdx + 1 : mIdx}`);
  images = [];
  // Index-keyed and every modality index just shifted; a stale bit would cost a slot its one retry.
  decodeRetried.clear();
  requestedSlots.clear(); // same index-shift reason: a stale mark would suppress the slot's re-request

  // Rebuild UI
  buildModalitySelector();
  if (isMultiTupleMode) {
    updateCarouselThumbSize();
    buildCarousel();
  }

  // Re-request every row: existing cells repaint in place from the extension's memory cache; only the new column generates.
  vscode.postMessage({
    type: 'requestThumbnails',
    tupleIndices: Array.from({ length: tuples.length }, (_, i) => i)
  });

  // The shift above aimed past the only column there is; the returning content takes the view.
  if (hadNoColumns) {
    currentModalityIndex = asDisplay(0);
    previousModalityIndex = asDisplay(0);
  }

  // The re-indexed cache serves every old slot; loadTuple requests only the new column's (docs/file-watching.md: mutation-never-strands-view).
  loadTuple(currentTupleIndex);
}

function handleModalityRemoved(message: { modalityIndex: OriginalModalityIndex }) {
  // Un-permute before splicing a wire index, and carry display-space state before the reset below (docs/tuple-matching.md: unpermute-before-splice).
  const prevOrder = modalityOrder;
  modalities = restoreOriginalOrder(modalities, prevOrder);
  modalityColors = restoreOriginalOrder(modalityColors, prevOrder);
  modalityPaths = restoreOriginalOrder(modalityPaths, prevOrder);

  const removedModality = modalities[message.modalityIndex];

  // Remove from modalities and colors
  modalities.splice(message.modalityIndex, 1);
  modalityColors.splice(message.modalityIndex, 1);
  modalityPaths.splice(message.modalityIndex, 1);

  // Old display index -> new index; drop the removed modality, shift later ones down (new space is identity).
  const carryIndex = (displayIdx: DisplayModalityIndex): number => {
    const originalIdx = prevOrder[displayIdx];
    if (originalIdx === undefined || originalIdx === message.modalityIndex) return -1;
    return originalIdx > message.modalityIndex ? originalIdx - 1 : originalIdx;
  };

  const shiftedWinners = new Map<TupleIndex, DisplayModalityIndex>();
  for (const [tIdx, displayIdx] of winners) {
    const carried = carryIndex(displayIdx);
    if (carried >= 0) shiftedWinners.set(tIdx, asDisplay(carried));
  }
  winners = shiftedWinners;

  // Original-index-keyed, so it shifts with the splice like everything else (docs/file-watching.md: reindex-in-lockstep).
  const shiftedHidden = new Set<OriginalModalityIndex>();
  for (const o of hiddenModalities) {
    const sh = shiftIndexAfterRemoval(o, message.modalityIndex);
    if (sh !== null) shiftedHidden.add(asOriginal(sh));
  }
  hiddenModalities = shiftedHidden;

  // Reset modalityOrder to default [0, 1, 2, ...] - the arrays above are back in original order
  modalityOrder = modalities.map((_, i) => asOriginal(i));

  // The viewed/peeked modalities are display indices in the old order; carry them into the new space.
  currentModalityIndex = asDisplay(Math.max(0, carryIndex(currentModalityIndex)));
  previousModalityIndex = asDisplay(Math.max(0, carryIndex(previousModalityIndex)));

  // Adjust current modality index if needed
  if (currentModalityIndex >= modalities.length) {
    currentModalityIndex = asDisplay(Math.max(0, modalities.length - 1));
  }
  if (previousModalityIndex >= modalities.length) {
    previousModalityIndex = asDisplay(Math.max(0, modalities.length - 1));
  }

  // Update ALL tuples to remove the modality
  for (const tuple of tuples) {
    tuple.images = tuple.images.filter(img => img.modality !== removedModality);
    // Update modalityIndex for remaining images
    tuple.images.forEach((img, i) => {
      img.modalityIndex = asOriginal(i);
    });
  }
  
  // Re-index the caches instead of clearing them, like the tuple handlers do — a wholesale clear blanks every loaded thumbnail and prefetched neighbour on screen.
  for (const [idx, imgs] of loadedTuples) {
    const shifted: LoadedImage[] = [];
    imgs.forEach((img, i) => {
      if (i !== message.modalityIndex) shifted[i > message.modalityIndex ? i - 1 : i] = img;
    });
    loadedTuples.set(idx, shifted);
  }
  // The removed column's urls are nobody's, so the re-key revokes them.
  thumbnailUrls.rekey((tIdx, mIdx) =>
    mIdx === message.modalityIndex ? null : `${tIdx}-${mIdx > message.modalityIndex ? mIdx - 1 : mIdx}`);
  images = [];
  // Index-keyed and every later modality index just shifted; a stale bit would cost a slot its one retry.
  decodeRetried.clear();
  requestedSlots.clear(); // same index-shift reason: a stale mark would suppress the slot's re-request

  // Rebuild UI
  buildModalitySelector();
  if (isMultiTupleMode) {
    updateCarouselThumbSize();
    buildCarousel();
  }
  
  // Request ALL thumbnails again
  vscode.postMessage({
    type: 'requestThumbnails',
    tupleIndices: Array.from({ length: tuples.length }, (_, i) => i)
  });
  
  // Reload the current tuple so the removed column never strands the view (docs/file-watching.md: mutation-never-strands-view).
  loadTuple(currentTupleIndex);
}


// Inverse of the modalityOrder permutation for the label arrays: order[displayIdx] = originalIdx.
function restoreOriginalOrder<T>(displayArr: T[], order: number[]): T[] {
  const original = new Array<T>(order.length);
  for (let displayIdx = 0; displayIdx < order.length; displayIdx++) {
    original[order[displayIdx]] = displayArr[displayIdx];
  }
  return original;
}

function reorderImagesForDisplay(originalImages: LoadedImage[]): (LoadedImage | undefined)[] {
  // Reorder images according to modalityOrder, keeping undefined slots
  const reordered: (LoadedImage | undefined)[] = new Array(modalityOrder.length);
  for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
    const originalIdx = modalityOrder[displayIdx];
    // Handle out-of-bounds access (originalImages might be shorter than modalityOrder)
    reordered[displayIdx] = originalIdx < originalImages.length ? originalImages[originalIdx] : undefined;
  }
  return reordered;
}

// Bounds the webview cache, which prefetch keeps pushing ±prefetchCount neighbours into.
function evictDistantWebviewTuples() {
  const maxDist = config.prefetchCount + 3;
  for (const idx of Array.from(loadedTuples.keys())) {
    if (Math.abs(idx - currentTupleIndex) > maxDist) {
      loadedTuples.delete(idx);
    }
  }
}

/** Coalesce canvas draws to one per frame; during fast stepping later tuples supersede queued draws instead of stacking. */
let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    render();
  });
}

/** Post one slot request, unless an outstanding one already ranks at least this high. */
function requestSlot(tupleIndex: TupleIndex, modalityIndex: OriginalModalityIndex, rank: SlotRank, forceReload = false): void {
  const key = `${tupleIndex}-${modalityIndex}`;
  // A slot queued below the rank now needed must be re-asked; no host promotes a queued task (docs/loading-architecture.md: request-rank-upgrades).
  if (rankCovers(requestedSlots.get(key), rank) && !forceReload) return;
  requestedSlots.set(key, rank);
  vscode.postMessage({
    type: 'requestImage',
    tupleIndex,
    modalityIndex,
    sibling: rank !== 'visible',
    tail: rank === 'tail',
    ...(forceReload ? { forceReload: true } : {})
  });
}

function loadTuple(index: TupleIndex) {
  // Ahead of the range guard, which at zero rows returns before anything can raise the notice; also the single site that clears it (docs/loading-architecture.md: empty-comparison-is-terminal).
  if (applyEmptyNotice()) return;
  if (index < 0 || index >= tuples.length) return;

  // Only an actual tuple change resets the view — re-index paths reload the same tuple and must not.
  if (index !== currentTupleIndex && !config.keepZoomOnTupleChange) {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  currentTupleIndex = index;
  evictDistantWebviewTuples();
  // Reset to the target tuple's cache so no stale frame from the previous tuple can show.
  const cachedForIndex = loadedTuples.get(index);
  images = cachedForIndex ? reorderImagesForDisplay(cachedForIndex) : new Array(modalityOrder.length).fill(undefined);

  // Tell the extension immediately, so it can cancel stale loads.
  vscode.postMessage({
    type: 'setCurrentTuple',
    tupleIndex: index
  });

  if (loadDebounceTimer !== null) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }
  // Navigating away un-requests the siblings of the tuple left behind (docs/loading-architecture.md: siblings-dwell-gated).
  if (siblingDwellTimer !== null) {
    clearTimeout(siblingDwellTimer);
    siblingDwellTimer = null;
  }
  // A revisit always re-asks: a reply dropped by the extension's park clears no other way (docs/loading-architecture.md: held-payloads-always-flush).
  for (const key of [...requestedSlots.keys()]) {
    if (key.startsWith(`${index}-`)) requestedSlots.delete(key);
  }

  // Update, not rebuild: recreating 16 pill buttons per keystroke stalled the carousel animation.
  updateModalitySelector();
  updateCarouselSelection();

  // Cached renders on the next frame; otherwise preview + spinner.
  if (images[currentModalityIndex]) {
    scheduleRender();
  } else {
    showPreviewOrLoading(index, currentModalityIndex);
  }

  const cachedSlots = loadedTuples.get(index);
  const allCached = !!cachedSlots &&
    tuples[index].images.every((_, i) => cachedSlots[i] !== undefined);
  if (allCached) {
    postTupleFullyLoaded(index);
    return;
  }

  // The arrival policy is pure and unit-pinned; this only posts what it returns (docs/loading-architecture.md: siblings-dwell-gated).
  const planFor = () => {
    const have = loadedTuples.get(index);
    return tupleArrivalPlan({
      modalityOrder,
      currentDisplayIndex: currentModalityIndex,
      isHidden: o => hiddenModalities.has(asOriginal(o)),
      isCached: o => !!have && have[o] !== undefined
    });
  };
  const post = (requests: { modalityIndex: number; rank: SlotRank }[]) => {
    if (currentTupleIndex !== index) return;
    for (const r of requests) requestSlot(index, asOriginal(r.modalityIndex), r.rank);
  };

  // Leading-edge, not trailing: an isolated navigation must not pay 150ms (docs/loading-architecture.md: debounce-leading-edge).
  const now = Date.now();
  const rapid = now - lastNavAt < LOAD_DEBOUNCE_MS;
  lastNavAt = now;

  if (rapid) {
    loadDebounceTimer = window.setTimeout(() => {
      loadDebounceTimer = null;
      post(planFor().now);
    }, LOAD_DEBOUNCE_MS);
  } else {
    post(planFor().now);
  }

  siblingDwellTimer = window.setTimeout(() => {
    siblingDwellTimer = null;
    post(planFor().afterDwell);
  }, LOAD_DEBOUNCE_MS);
}

/** Carousel rows one screenful high — the radius the sweep's cross reaches to (docs/loading-architecture.md: sweep-cross-then-row-major). */
function visibleCarouselRows(): number {
  const rowH = carouselRowHeight();
  if (!isMultiTupleMode || rowH <= 0) return 1;
  return Math.max(1, Math.ceil(carouselEl.clientHeight / rowH));
}

/** Reports the strip the moment the user picks a column — `tupleFullyLoaded` waits for a whole tuple, which on a wide cold session is far away (docs/loading-architecture.md: picked-column-reports-itself). */
function postCurrentModality(displayModalityIndex: DisplayModalityIndex) {
  vscode.postMessage({
    type: 'setCurrentModality',
    modalityOrder: modalityOrder.slice(),
    currentDisplayIndex: displayModalityIndex,
    hiddenModalities: Array.from(hiddenModalities),
    visibleRows: visibleCarouselRows()
  });
}

/** Every column report goes through this one gate, clicks and keys alike (docs/loading-architecture.md: picked-column-reports-itself). */
const columnReport = new ColumnReportGate(
  { setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: h => window.clearTimeout(h as number) },
  d => postCurrentModality(asDisplay(d))
);

/** Reports the tuple as loaded *and* the strip as displayed — prefetch scopes its wave to the column on screen (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column), the sweep aims its cross at it (docs/loading-architecture.md: sweep-cross-then-row-major). */
function postTupleFullyLoaded(tupleIndex: TupleIndex) {
  vscode.postMessage({
    type: 'tupleFullyLoaded',
    tupleIndex,
    modalityOrder: modalityOrder.slice(),
    currentDisplayIndex: currentModalityIndex,
    hiddenModalities: Array.from(hiddenModalities),
    visibleRows: visibleCarouselRows()
  });
}

function showPreviewOrLoading(tupleIndex: TupleIndex, displayModalityIndex: number) {
  // Thumbnails are keyed by original modality index, not display index.
  const originalModIdx = modalityOrder[displayModalityIndex];
  const thumbnailKey = `${tupleIndex}-${originalModIdx}`;
  const thumbnailDataUrl = thumbnailUrls.get(thumbnailKey);
  
  if (thumbnailDataUrl) {
    // Show thumbnail as blurry preview
    const previewImg = new Image();
    previewImg.onload = () => {
      // Deferred: only show if we're still on the same tuple/modality.
      if (currentTupleIndex === tupleIndex && currentModalityIndex === displayModalityIndex) {
        canvasEl.classList.add('preview');

        const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
        const vw = viewerEl.clientWidth - carouselOffset;
        const vh = viewerEl.clientHeight;
        
        canvasEl.width = previewImg.width;
        canvasEl.height = previewImg.height;
        ctx.drawImage(previewImg, 0, 0);
        
        const baseScale = Math.min(vw / previewImg.width, vh / previewImg.height);
        const scale = baseScale * zoom;
        const displayW = previewImg.width * scale;
        const displayH = previewImg.height * scale;
        
        canvasEl.style.width = displayW + 'px';
        canvasEl.style.height = displayH + 'px';
        
        const centerOffsetX = carouselOffset / 2;
        canvasEl.style.transform = `translate(calc(-50% + ${panX + centerOffsetX}px), calc(-50% + ${panY}px))`;

        const tuple = tuples[tupleIndex];
        updateStatus(`${tuple.name} | Loading...`, `Zoom: ${zoom.toFixed(1)}x`, tupleIndex);
      }
    };
    previewImg.src = thumbnailDataUrl;
  } else {
    // No thumbnail yet — a drawn placeholder beats a blank white canvas.
    const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
    
    canvasEl.width = 400;
    canvasEl.height = 200;
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', 200, 100);
    
    canvasEl.style.width = '400px';
    canvasEl.style.height = '200px';
    
    const centerOffsetX = carouselOffset / 2;
    canvasEl.style.transform = `translate(calc(-50% + ${centerOffsetX}px), -50%)`;

    const modalityName = modalities[displayModalityIndex] || 'Image';
    updateStatus(`${modalityName}: Loading...`, `Zoom: ${zoom.toFixed(1)}x`, tupleIndex);
  }

  imageLoaderEl.classList.add('active');
}

// Reserved for the scrollbar thumb (6px + edge gaps) so it never overlaps the last tile column.
const SCROLLBAR_GUTTER = 10;
// .carousel-row's horizontal padding: where the first tile starts, and so the origin of the column axis.
const CAROUSEL_ROW_PAD = 6;
// .carousel-row's `gap`, which is also the vertical space between rows — keep both in step with the CSS.
const CAROUSEL_TILE_GAP = 2;

/** Carousel width that fits every modality column at perTile px (6px row padding each side, scrollbar gutter, 2px gaps). */
function carouselFitWidth(perTile: number): number {
  return 2 * CAROUSEL_ROW_PAD + SCROLLBAR_GUTTER + modalities.length * perTile + (modalities.length - 1) * CAROUSEL_TILE_GAP;
}

function updateCarouselThumbSize(snapToDevicePixels = true) {
  const numModalities = modalities.length;
  const availableWidth = CAROUSEL_WIDTH - 2 * CAROUSEL_ROW_PAD - SCROLLBAR_GUTTER - (numModalities - 1) * CAROUSEL_TILE_GAP;
  // Fractional, not floored: integer steps made every tile snap visibly during a resize drag.
  CAROUSEL_THUMB_SIZE = availableWidth / numModalities;
  // Tiles scale down to fit the width — a floor here reintroduces clipped columns.
  CAROUSEL_THUMB_SIZE = Math.max(12, CAROUSEL_THUMB_SIZE);
  // At rest, land on the device-pixel grid: fractional row heights make edges shimmer while the wall scrolls.
  if (snapToDevicePixels) {
    const dpr = window.devicePixelRatio || 1;
    CAROUSEL_THUMB_SIZE = Math.max(12, Math.round(CAROUSEL_THUMB_SIZE * dpr) / dpr);
  }
  carouselEl.style.setProperty('--thumb-size', CAROUSEL_THUMB_SIZE + 'px');
  // Tiles too small for a separable vote target: the circle stops taking clicks (docs/session-files.md: tiny-tiles-never-vote).
  carouselEl.classList.toggle('tiny-tiles', !isVoteClickable(CAROUSEL_THUMB_SIZE));
}

let carouselDelegatesInstalled = false;

function buildCarousel() {
  // An open menu's target is a slot, and every caller here re-indexes slots; a stale target copies or deletes the wrong file.
  closeContextMenu();
  carouselEl.innerHTML = '';
  carouselEl.style.width = CAROUSEL_WIDTH + 'px';
  carouselRowPool = [];
  carouselRowBound = [];
  carouselRowTopAt = [];
  carouselWallEl = null;
  carouselThumbEl = null;

  if (!isMultiTupleMode || tuples.length <= 1) {
    carouselEl.classList.remove('active');
    carouselResizeEl.classList.remove('active');
    viewerEl.classList.remove('has-carousel');
    return;
  }

  carouselEl.classList.add('active');
  carouselResizeEl.classList.add('active');
  carouselResizeEl.style.left = (CAROUSEL_WIDTH - 4) + 'px';
  viewerEl.classList.add('has-carousel');
  viewerEl.style.setProperty('--carousel-offset', CAROUSEL_WIDTH + 'px');

  // Virtual shell: an arithmetically sized wall plus the custom scrollbar; rows materialize in ensureVisibleCarouselRows.
  carouselWallEl = document.createElement('div');
  carouselWallEl.id = 'carousel-wall';
  carouselThumbEl = document.createElement('div');
  carouselThumbEl.id = 'carousel-thumb';
  carouselHScrollEl = document.createElement('div');
  carouselHScrollEl.id = 'carousel-hscroll';
  carouselHScrollEl.appendChild(carouselWallEl);
  carouselEl.appendChild(carouselHScrollEl);
  carouselEl.appendChild(carouselThumbEl);
  setupCarouselThumbDrag(carouselThumbEl);
  if (!carouselDelegatesInstalled) {
    carouselDelegatesInstalled = true;
    // One delegated listener on the container: pooled rows are rebound constantly, per-element listeners would churn.
    carouselEl.addEventListener('click', handleCarouselClick);
  }

  // A rebuild resets the pool; this restores the offset (clamped) and materializes the visible rows.
  applyCarouselOffset(carouselOffset);
}

// centerOnCurrent is the navigation/paint seam: only a navigation may pass true (docs/loading-architecture.md: selection-centres-on-navigation).
function updateCarouselSelection(centerOnCurrent = true) {
  if (!isMultiTupleMode) return;
  // Rebinding the pool repaints selection state everywhere it can be visible (~35 rows).
  for (let s = 0; s < carouselRowPool.length; s++) {
    if (carouselRowBound[s] >= 0) bindCarouselRow(carouselRowPool[s], carouselRowBound[s]);
  }
  if (centerOnCurrent) scrollCarouselToCurrentTuple();
}

function toggleWinner(tupleIndex: TupleIndex, displayModalityIndex: DisplayModalityIndex) {
  if (!votingEnabled) return;

  const currentWinner = winners.get(tupleIndex);

  // The extension's modalities array is in original order, not display order.
  const originalModalityIndex = modalityOrder[displayModalityIndex];

  if (currentWinner === displayModalityIndex) {
    winners.delete(tupleIndex);
    vscode.postMessage({
      type: 'setWinner',
      tupleIndex,
      modalityIndex: null
    });
  } else {
    // Store the display index locally, send the original to the extension.
    winners.set(tupleIndex, displayModalityIndex);
    vscode.postMessage({
      type: 'setWinner',
      tupleIndex,
      modalityIndex: originalModalityIndex
    });
  }

  updateCarouselWinners();
  updateModalitySelector();
}

function updateCarouselWinners() {
  if (!isMultiTupleMode || !votingEnabled) return;
  for (let s = 0; s < carouselRowPool.length; s++) {
    if (carouselRowBound[s] >= 0) bindCarouselRow(carouselRowPool[s], carouselRowBound[s]);
  }
}

// Virtual carousel: only visible rows (plus overscan) exist in the DOM, recycled ring-buffer style — scroll, stepping and resize touch ~35 rows, never the whole session (docs/loading-architecture.md).
let carouselOffset = 0;
let carouselWallEl: HTMLElement | null = null;
let carouselThumbEl: HTMLElement | null = null;
let carouselHScrollEl: HTMLElement | null = null;
let carouselScrollHideTimer: ReturnType<typeof setTimeout> | null = null;
// Rows bound beyond the viewport, each way. Sized for a fast flick, not a slow drag: an Alt notch moves 5x, and a window that outruns its buffer shows blank rows until the next bind — the jaggedness this buffers against (docs/loading-architecture.md: wheel-coalesced-to-one-frame).
const CAROUSEL_OVERSCAN = 10;
// How long after the last wheel notch the flown-past rows get their real thumbnails. Short enough to read as instant, long enough that a continuous scroll never pays for rows it passes.
const CAROUSEL_SETTLE_MS = 90;
let carouselRowPool: HTMLElement[] = [];
let carouselRowBound: number[] = []; // pool slot -> bound tupleIndex (-1 = hidden)
let carouselRowTopAt: number[] = []; // pool slot -> applied top px, to skip redundant writes

function carouselRowHeight(): number {
  return CAROUSEL_THUMB_SIZE + CAROUSEL_TILE_GAP;
}

/** Tile width plus the row's gap. Equal to the row height today, and derived rather than borrowed so a CSS gap change moves both. */
function carouselColumnPitch(): number {
  return CAROUSEL_THUMB_SIZE + CAROUSEL_TILE_GAP;
}

// No phase-lock pad: it showed as a blank strip at the bottom, and its mod-based size sawtoothed during resize, bouncing the bottom clamp.
function carouselContentHeight(): number {
  return tuples.length * carouselRowHeight();
}

function carouselMaxOffset(): number {
  return Math.max(0, carouselContentHeight() - carouselEl.clientHeight);
}

function applyCarouselOffset(target: number) {
  if (!carouselWallEl || !carouselThumbEl) return;
  carouselOffset = Math.max(0, Math.min(target, carouselMaxOffset()));
  carouselWallEl.style.transform = `translateY(${-carouselOffset}px)`;
  ensureVisibleCarouselRows();
  const viewH = carouselEl.clientHeight;
  const contentH = carouselContentHeight();
  if (contentH <= viewH) {
    carouselThumbEl.style.display = 'none';
  } else {
    const thumbH = Math.max(20, (viewH * viewH) / contentH);
    const maxOff = carouselMaxOffset();
    const thumbY = maxOff > 0 ? ((viewH - thumbH) * carouselOffset) / maxOff : 0;
    carouselThumbEl.style.display = 'block';
    carouselThumbEl.style.height = thumbH + 'px';
    carouselThumbEl.style.transform = `translateY(${thumbY}px)`;
  }
  carouselEl.classList.add('scrolling');
  if (carouselScrollHideTimer) clearTimeout(carouselScrollHideTimer);
  carouselScrollHideTimer = setTimeout(() => carouselEl.classList.remove('scrolling'), 800);
}

function ensureVisibleCarouselRows() {
  if (!carouselWallEl) return;
  const rowH = carouselRowHeight();
  if (rowH <= 0) return;
  // Written only on change: re-setting these every wheel event forced a layout per event, for a box that only moves with the tuple count or tile size (docs/loading-architecture.md: wheel-coalesced-to-one-frame).
  const wallH = carouselContentHeight() + 'px';
  if (carouselWallEl.style.height !== wallH) carouselWallEl.style.height = wallH;
  // Wider than the pane only when the 12px tile floor bit: rows overflow into the horizontal scroller.
  const neededW = carouselFitWidth(CAROUSEL_THUMB_SIZE);
  const wallW = neededW > CAROUSEL_WIDTH ? neededW + 'px' : '';
  if (carouselWallEl.style.width !== wallW) carouselWallEl.style.width = wallW;
  const viewH = carouselEl.clientHeight;
  const first = Math.max(0, Math.floor(carouselOffset / rowH) - CAROUSEL_OVERSCAN);
  const last = Math.min(tuples.length - 1, Math.floor((carouselOffset + viewH) / rowH) + CAROUSEL_OVERSCAN);
  // Sized for the smallest possible row (12px tile + 2), not the current one: a pool-size change remaps the whole ring (slot = j % pool) and rebinds every row — a visible hitch mid-resize.
  const needed = Math.min(tuples.length, Math.max(last - first + 1, Math.ceil(viewH / 14) + 2 * CAROUSEL_OVERSCAN + 2));
  while (carouselRowPool.length < needed) {
    const el = createCarouselRowShell();
    carouselRowPool.push(el);
    carouselRowBound.push(-1);
    carouselRowTopAt.push(-1);
    carouselWallEl.appendChild(el);
  }
  const pool = carouselRowPool.length;
  // Ring mapping (tuple j lives in slot j % pool): advancing the window rebinds only the rows that enter it.
  for (let s = 0; s < pool; s++) {
    const j = carouselRowBound[s];
    if (j >= 0 && (j < first || j > last)) {
      carouselRowPool[s].style.display = 'none';
      carouselRowBound[s] = -1;
    }
  }
  for (let j = first; j <= last; j++) {
    const s = j % pool;
    const el = carouselRowPool[s];
    const top = j * rowH;
    if (carouselRowTopAt[s] !== top) {
      el.style.top = top + 'px';
      carouselRowTopAt[s] = top;
    }
    if (carouselRowBound[s] !== j) {
      el.style.display = '';
      bindCarouselRow(el, j);
      carouselRowBound[s] = j;
    }
  }
}

/** A pooled row's tiles and vote circles, captured once at creation (docs/loading-architecture.md: carousel-dom-never-searched). */
interface RowParts { imgs: HTMLImageElement[]; circles: (HTMLElement | null)[] }
const rowParts = new WeakMap<HTMLElement, RowParts>();

function createCarouselRowShell(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'carousel-row';
  const parts: RowParts = { imgs: [], circles: [] };
  // Born hidden: with the pool oversized for the smallest row height, some shells stay unbound — visible unbound shells would stack at top 0.
  row.style.display = 'none';
  for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
    const container = document.createElement('div');
    container.className = 'carousel-thumb-container';
    const img = document.createElement('img');
    img.className = 'carousel-thumb placeholder';
    img.dataset.displayIndex = String(displayIdx);
    // An undecodable thumb src must show the designed ✕ placeholder, never the browser's broken-image glyph (docs/loading-architecture.md: decode-retry-once).
    img.onerror = () => handleThumbDecodeFailure(img);
    img.onload = () => {
      // A successful real decode re-arms the slot's retry; placeholder loads must not, or the guard dissolves before the retry's response lands.
      if (img.src !== PLACEHOLDER_THUMB) thumbRetried.delete(`${img.dataset.tuple}-${img.dataset.modality}`);
    };
    container.appendChild(img);
    parts.imgs.push(img);
    let circle: HTMLElement | null = null;
    if (votingEnabled) {
      circle = document.createElement('div');
      circle.className = 'winner-circle';
      container.appendChild(circle);
    }
    parts.circles.push(circle);
    row.appendChild(container);
  }
  rowParts.set(row, parts);
  return row;
}

/**
 * The tile showing a slot, or null when no bound row is holding it. Ring-mapped, so this is an index
 * lookup: a DOM search per arriving thumbnail scanned the whole carousel subtree, and a sweep
 * delivers hundreds at once (docs/loading-architecture.md: carousel-dom-never-searched).
 */
function carouselTileFor(tupleIndex: number, originalModalityIndex: number): HTMLImageElement | null {
  const pool = carouselRowPool.length;
  if (pool === 0) return null;
  const slot = tupleIndex % pool;
  if (carouselRowBound[slot] !== tupleIndex) return null;
  const displayIdx = modalityOrder.indexOf(asOriginal(originalModalityIndex));
  if (displayIdx < 0) return null;
  return rowParts.get(carouselRowPool[slot])?.imgs[displayIdx] ?? null;
}

/** Everything a row shows derives from the state maps, so recycling a slot fully repaints it — and a row only reads urls, never revokes one (docs/loading-architecture.md: thumb-url-owned-by-cache). */
/** True while a wheel is still moving the wall: rows bound during a flyby take the blank tile, not their own (docs/loading-architecture.md: flyby-rows-defer-decodes). */
let carouselFlying = false;
let carouselSettleTimer: number | undefined;

/** Rebind every bound row now that the wall has stopped, so the rows the user actually landed on get their images. */
function fillFlybyRows(): void {
  carouselFlying = false;
  for (let s = 0; s < carouselRowPool.length; s++) {
    if (carouselRowBound[s] >= 0) bindCarouselRow(carouselRowPool[s], carouselRowBound[s]);
  }
}

function bindCarouselRow(el: HTMLElement, tupleIdx: number) {
  el.dataset.tupleIndex = String(tupleIdx);
  el.classList.toggle('current', tupleIdx === currentTupleIndex);
  const winnerIdx = winners.get(asTuple(tupleIdx));
  const parts = rowParts.get(el);
  if (!parts) return;
  parts.imgs.forEach((img, displayIdx) => {
    const originalIdx = modalityOrder[displayIdx];
    img.dataset.tuple = String(tupleIdx);
    img.dataset.modality = String(originalIdx);
    const url = carouselFlying ? undefined : thumbnailUrls.get(`${tupleIdx}-${originalIdx}`);
    if (url) {
      if (img.getAttribute('src') !== url) img.src = url;
      img.classList.remove('placeholder');
      img.classList.toggle('missing', url === PLACEHOLDER_THUMB);
    } else {
      // Removing the src of a recycled tile leaves the browser's broken-image glyph (docs/loading-architecture.md: empty-tile-never-broken).
      if (img.getAttribute('src') !== BLANK_THUMB) img.src = BLANK_THUMB;
      img.classList.add('placeholder');
      img.classList.remove('missing');
    }
    img.classList.toggle('active', tupleIdx === currentTupleIndex);
    img.classList.toggle('selected', tupleIdx === currentTupleIndex && displayIdx === currentModalityIndex);
    const circle = parts.circles[displayIdx];
    if (circle) circle.classList.toggle('winner', winnerIdx === displayIdx);
  });
}

function handleCarouselClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const row = target.closest('.carousel-row') as HTMLElement | null;
  if (!row?.dataset.tupleIndex) return;
  const tupleIdx = asTuple(parseInt(row.dataset.tupleIndex, 10));
  const circle = target.closest('.winner-circle');
  if (circle) {
    const cImg = circle.parentElement?.querySelector('.carousel-thumb') as HTMLElement | null;
    toggleWinner(tupleIdx, asDisplay(parseInt(cImg?.dataset.displayIndex ?? '0', 10)));
    return;
  }
  const img = target.closest('.carousel-thumb') as HTMLElement | null;
  if (img) {
    // Every thumb is stamped at creation and buildCarousel() resets the pool on a column-count change, so this is total; a silent 0 here is the column-0 aim bug (docs/loading-architecture.md: picked-column-reports-itself).
    const clicked = parseInt(img.dataset.displayIndex ?? '', 10);
    if (Number.isInteger(clicked)) goToTupleAndModality(tupleIdx, asDisplay(clicked));
    return;
  }
  if (tupleIdx !== currentTupleIndex) loadTuple(tupleIdx);
}

function scrollCarouselToCurrentTuple() {
  if (!isMultiTupleMode || !carouselWallEl) return;
  const rowH = carouselRowHeight();
  if (rowH <= 0) return;
  // Navigation is a landing, not a flyby: clear the defer first so the rows it binds take their images directly.
  if (carouselSettleTimer !== undefined) clearTimeout(carouselSettleTimer);
  carouselFlying = false;
  // Virtual rows make the row top pure arithmetic; snapped to whole rows so a step moves the grid exactly one row or not at all (docs/loading-architecture.md: selection-centres-on-navigation).
  applyCarouselOffset(centreOffset(currentTupleIndex * rowH, rowH, carouselEl.clientHeight, carouselContentHeight(), rowH));
}

/** The column axis of the same grid, under the same rule — `<-`/`->` used to leave the selected column off-screen entirely (docs/loading-architecture.md: selection-centres-on-navigation). */
function scrollCarouselToCurrentColumn() {
  if (!isMultiTupleMode || !carouselHScrollEl) return;
  const pitch = carouselColumnPitch();
  if (pitch <= 0) return;
  // Tiles start after the row's 6px left padding, so the span is offset by it; the snap is the same pitch as the rows'.
  const start = CAROUSEL_ROW_PAD + currentModalityIndex * pitch;
  carouselHScrollEl.scrollLeft = centreOffset(
    start, CAROUSEL_THUMB_SIZE, carouselHScrollEl.clientWidth, carouselHScrollEl.scrollWidth, pitch);
}

/** Same rule, third axis. Pills differ in width, so there is no pitch to snap to (docs/loading-architecture.md: selection-centres-on-navigation). */
function scrollPillsToCurrentModality() {
  const pill = modalitySelectorEl.querySelector(`.modality-btn[data-display-index="${currentModalityIndex}"]`) as HTMLElement | null;
  if (!pill) return;
  const left = centreOffset(pill.offsetLeft, pill.offsetWidth, modalitySelectorEl.clientWidth, modalitySelectorEl.scrollWidth);
  // Navigation slides; the wheel path assigns scrollLeft directly and stays instant under the pointer.
  modalitySelectorEl.scrollTo({ left, behavior: 'smooth' });
}

/** Every deliberate modality change re-centres both horizontal axes; a wheel calls none of this (docs/loading-architecture.md: selection-centres-on-navigation). */
function centreOnCurrentModality() {
  scrollPillsToCurrentModality();
  scrollCarouselToCurrentColumn();
}

function goToTupleAndModality(tupleIdx: TupleIndex, modalityIdx: DisplayModalityIndex) {
  // Unconditional: the clicked column is the sweep's aim even when it is the one already on screen, which no report may have carried yet (docs/loading-architecture.md: picked-column-reports-itself).
  columnReport.picked(modalityIdx);
  if (tupleIdx === currentTupleIndex) {
    if (modalityIdx !== currentModalityIndex) {
      previousModalityIndex = currentModalityIndex;
      currentModalityIndex = modalityIdx;
      render();
      updateCarouselSelection();
      centreOnCurrentModality();
    }
  } else {
    if (modalityIdx !== currentModalityIndex) previousModalityIndex = currentModalityIndex;
    currentModalityIndex = modalityIdx;
    loadTuple(tupleIdx);
    centreOnCurrentModality();
  }
}

/**
 * Pills use this instead of `title=`: a native tooltip is dismissed when the pill's text is rewritten
 * (win counts re-render on every vote) and does not come back until the pointer leaves and re-enters,
 * which is what made the path tooltip look intermittent.
 */
function showPillTooltip(path: string, anchor: HTMLElement): void {
  pillTooltipEl.textContent = path;
  // Measure from a known origin: a stale `left` caps the shrink-to-fit width and inflates the height.
  pillTooltipEl.style.left = '0px';
  pillTooltipEl.style.top = '0px';
  pillTooltipEl.classList.add('visible');

  const a = anchor.getBoundingClientRect();
  const t = pillTooltipEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(a.left, window.innerWidth - t.width - 4));
  const above = a.top - t.height - 6;
  pillTooltipEl.style.left = `${left}px`;
  pillTooltipEl.style.top = `${above >= 4 ? above : a.bottom + 6}px`;
}

function hidePillTooltip(): void {
  pillTooltipEl.classList.remove('visible');
}

let copyToastTimer: number | undefined;
function showCopyToast(text: string): void {
  renderToast(text, 'info', undefined);
}

/** A host event, worded and capability-gated by the shared channel — never by the caller (docs/standalone.md: affordances-rendered-by-the-webview). */
function showNotice(event: NoticeEvent): void {
  const notice = buildNotice(event, capabilities);
  renderToast(notice.text, notice.tone, notice.action);
}

function renderToast(text: string, tone: 'info' | 'error', action: { label: string; path: string } | undefined): void {
  copyToastEl.textContent = text;
  copyToastEl.classList.toggle('error', tone === 'error');
  copyToastEl.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.id = 'notice-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hideToast();
      vscode.postMessage({ type: 'revealPath', path: action.path });
    });
    copyToastEl.appendChild(btn);
  }
  copyToastEl.classList.add('visible');
  if (copyToastTimer !== undefined) clearTimeout(copyToastTimer);
  // An offered action needs long enough to be clicked; a bare toast does not.
  copyToastTimer = setTimeout(hideToast, action ? 8000 : 1400) as unknown as number;
}

/** `has-action` goes with `visible`: a faded toast that kept it stayed a transparent click-eater over the viewer. */
function hideToast(): void {
  copyToastEl.classList.remove('visible', 'has-action');
}

/** The help modal states what THIS host offers, from the same model that builds the menu, so it cannot promise a missing item. */
function applyCapabilitiesToHelp(): void {
  helpContextMenuItemsEl.textContent = contextMenuHelpText(capabilities);
  (helpRowSaveSessionEl as HTMLElement).hidden = !capabilities.saveSessionAs;
}

// Truncates auto-derived directory names, which would otherwise blow out the status bar.
function pillLabel(name: string): string {
  if (labelsExplicit || name.length <= 20) return name;
  return name.slice(0, 19) + '\u2026';
}

function buildModalitySelector() {
  // The hovered pill is about to be destroyed, and a removed element never gets mouseleave.
  hidePillTooltip();
  closeContextMenu();
  modalitySelectorEl.innerHTML = '';

  // modalities/modalityColors/modalityPaths are already in display order after any reordering.
  for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
    const btn = document.createElement('button');
    btn.className = 'modality-btn';
    btn.textContent = pillLabel(modalities[displayIdx]);
    btn.style.background = modalityColors[displayIdx];
    btn.dataset.displayIndex = String(displayIdx);


    btn.addEventListener('click', () => {
      if (currentModalityIndex !== displayIdx) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex = asDisplay(displayIdx);
        render();
        centreOnCurrentModality();
        columnReport.picked(currentModalityIndex);
      }
    });

    modalitySelectorEl.appendChild(btn);
  }

  updateModalitySelector();
}

// Delegated, not per-pill: pills are replaced wholesale (docs/session-files.md: modality-path-always-real).
modalitySelectorEl.addEventListener('mouseover', (e) => {
  const btn = (e.target as HTMLElement)?.closest?.('.modality-btn') as HTMLElement | null;
  if (!btn) return;
  const displayIdx = parseInt(btn.dataset.displayIndex || '0', 10);
  showPillTooltip(modalityPaths[displayIdx], btn);
});
modalitySelectorEl.addEventListener('mouseout', (e) => {
  const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
  if (to && to.closest?.('.modality-btn')) return; // moving between pills: the mouseover re-aims it
  hidePillTooltip();
});

/** Which surface was right-clicked, in wire terms; null where the comparison offers nothing and the host's own menu still applies. */
function contextTargetFor(target: HTMLElement | null): MenuContext | null {
  const pill = target?.closest?.('.modality-btn') as HTMLElement | null;
  if (pill) {
    const original = modalityOrder[parseInt(pill.dataset.displayIndex || '0', 10)];
    return { section: 'pill', tupleIndex: currentTupleIndex, modalityIndex: original, hidden: hiddenModalities.has(original) };
  }
  if (target?.closest?.('#viewer')) {
    return { section: 'image', tupleIndex: currentTupleIndex, modalityIndex: modalityOrder[currentModalityIndex] };
  }
  return null;
}

document.addEventListener('contextmenu', (e) => {
  const target = contextTargetFor(e.target as HTMLElement | null);
  if (!target) return;
  // Suppresses the host's own menu in both products: VS Code's webview skips a contextmenu it finds already default-prevented, and so does the browser.
  e.preventDefault();
  openContextMenu(buildContextMenu(target, capabilities), e.clientX, e.clientY, id => runMenuAction(id, target));
});

/** Local items never reach the wire; the rest are the host's to serve. */
function runMenuAction(action: MenuActionId, target: MenuContext): void {
  switch (action) {
    case 'copyImage':
      copyCurrentImage();
      break;
    case 'toggleHidden': {
      const original = asOriginal(target.modalityIndex);
      if (hiddenModalities.has(original)) hiddenModalities.delete(original);
      else hiddenModalities.add(original);
      updateModalitySelector();
      break;
    }
    default:
      vscode.postMessage({ type: 'menuAction', action, ctx: target });
  }
}

function updateModalitySelector() {
  // Calculate win counts per modality (by display index)
  const winCounts: number[] = new Array(modalities.length).fill(0);
  if (votingEnabled) {
    for (const [_, modalityIdx] of winners) {
      if (modalityIdx >= 0 && modalityIdx < winCounts.length) {
        winCounts[modalityIdx]++;
      }
    }
  }

  const buttons = modalitySelectorEl.querySelectorAll('.modality-btn');
  buttons.forEach((btn) => {
    const displayIdx = parseInt((btn as HTMLElement).dataset.displayIndex || '0', 10);
    // Re-read on every update because [ ] reordering changes which original modality this position shows.
    const originalIdx = modalityOrder[displayIdx];
    btn.classList.toggle('hidden-modality', hiddenModalities.has(originalIdx));
    if (displayIdx === currentModalityIndex) {
      btn.classList.add('active');
      btn.classList.remove('inactive');
    } else {
      btn.classList.remove('active');
      btn.classList.add('inactive');
    }

    // Written only when it changed: replacing the text node on every render repainted the pill mid-transition, which is what read as flicker (docs/loading-architecture.md: selection-centres-on-navigation).
    const truncName = pillLabel(modalities[displayIdx]);
    const label = votingEnabled && winCounts[displayIdx] > 0 ? `${truncName} (${winCounts[displayIdx]})` : truncName;
    if (btn.textContent !== label) btn.textContent = label;
  });

  if (currentModalityIndex <= 0) {
    (reorderLeftBtn as HTMLButtonElement).disabled = true;
  } else {
    (reorderLeftBtn as HTMLButtonElement).disabled = false;
  }

  if (currentModalityIndex >= modalities.length - 1) {
    (reorderRightBtn as HTMLButtonElement).disabled = true;
  } else {
    (reorderRightBtn as HTMLButtonElement).disabled = false;
  }
}

function moveCurrentModality(direction: number) {
  if (modalities.length < 2) return;

  const currentPos = currentModalityIndex;
  const newPos = asDisplay(currentPos + direction);

  if (newPos < 0 || newPos >= modalities.length) return;

  // Swap in modalities
  [modalities[currentPos], modalities[newPos]] = [modalities[newPos], modalities[currentPos]];

  // Swap in colors
  [modalityColors[currentPos], modalityColors[newPos]] = [modalityColors[newPos], modalityColors[currentPos]];

  // Swap in paths so the pill tooltip stays attached to its modality
  [modalityPaths[currentPos], modalityPaths[newPos]] = [modalityPaths[newPos], modalityPaths[currentPos]];

  // Swap in modalityOrder (tracks original index at each display position)
  [modalityOrder[currentPos], modalityOrder[newPos]] = [modalityOrder[newPos], modalityOrder[currentPos]];

  // Update winners to reflect swapped indices
  if (votingEnabled) {
    const newWinners = new Map<TupleIndex, DisplayModalityIndex>();
    for (const [tupleIndex, winnerIdx] of winners) {
      if (winnerIdx === currentPos) {
        newWinners.set(tupleIndex, newPos);
      } else if (winnerIdx === newPos) {
        newWinners.set(tupleIndex, currentPos);
      } else {
        newWinners.set(tupleIndex, winnerIdx);
      }
    }
    winners = newWinners;
  }

  // Keep the Space-peek target attached to its modality across the swap.
  if (previousModalityIndex === currentPos) previousModalityIndex = newPos;
  else if (previousModalityIndex === newPos) previousModalityIndex = currentPos;

  // Update current index
  currentModalityIndex = newPos;
  // render() re-derives `images` from the cache using the new modalityOrder.

  // Rebuild UI
  buildModalitySelector();
  if (isMultiTupleMode) {
    buildCarousel();
  }
  render();
  centreOnCurrentModality();
  // A reorder moves no column but re-permutes the strip the aim ranks over (docs/loading-architecture.md: picked-column-reports-itself).
  columnReport.keyed(currentModalityIndex);
}

/**
 * Show or clear the terminal notice for a comparison with nothing to draw; returns true when it is
 * showing, and it is the only site that hides the canvas (docs/loading-architecture.md: empty-comparison-is-terminal).
 */
function applyEmptyNotice(): boolean {
  const notice = emptyNotice({ tupleCount: tuples.length, modalityCount: modalities.length, missingRootPath: rootMissingPath });
  emptyNoticeEl.classList.toggle('active', notice !== null);
  canvasEl.classList.toggle('hidden', notice !== null);
  if (!notice) return false;
  emptyNoticeTitleEl.textContent = notice.title;
  emptyNoticeDetailEl.textContent = notice.detail;
  // Terminal: the spinner goes out and no request is issued, so nothing can leave one spinning forever.
  imageLoaderEl.classList.remove('active');
  canvasEl.classList.remove('preview');
  // The minimap is the second surface carrying that same frame; hiding only the canvas leaves the preview on screen (docs/loading-architecture.md: empty-comparison-is-terminal).
  thumbCtx.clearRect(0, 0, thumbCanvasEl.width, thumbCanvasEl.height);
  thumbViewportEl.style.display = 'none';
  updateStatus(notice.title, notice.detail);
  return true;
}

function render() {
  // Nothing to draw: a notice, never a spinner over the last frame (docs/loading-architecture.md: empty-comparison-is-terminal).
  if (applyEmptyNotice()) return;
  // Re-derive from the cache; module-level `images` holds a previous tuple's frames (docs/loading-architecture.md: render-from-loaded-tuples).
  const cached = loadedTuples.get(currentTupleIndex);
  images = cached && cached.length > 0
    ? reorderImagesForDisplay(cached)
    : new Array(modalityOrder.length).fill(undefined);

  const currentImage = images[currentModalityIndex];

  // Updated even when showing a preview. No centering: render() is a paint path, and a re-center here would fight the user's scroll and override the resize anchor (docs/loading-architecture.md: selection-centres-on-navigation).
  updateModalitySelector();
  if (isMultiTupleMode) {
    updateCarouselSelection(false);
  }

  const isMissing = currentImage && (currentImage as any).missing;

  if (!currentImage || isMissing) {
    if (isMissing) {
      showMissingPlaceholder();
      canvasEl.classList.remove('preview');
      imageLoaderEl.classList.remove('active');
      const modalityName = modalities[currentModalityIndex] || 'Image';
      updateStatus(`${modalityName}: not available`, `Zoom: ${zoom.toFixed(1)}x`, currentTupleIndex);
    } else {
      showPreviewOrLoading(currentTupleIndex, currentModalityIndex);
      // A flip pays one VISIBLE load rather than a spinner nobody clears — before the dwell a first request, after it an upgrade of the tail's (docs/loading-architecture.md: siblings-dwell-gated, request-rank-upgrades).
      const onScreenSlot = modalityOrder[currentModalityIndex];
      if (loadDebounceTimer === null && onScreenSlot !== undefined) requestSlot(currentTupleIndex, onScreenSlot, 'visible');
    }
    return;
  }

  // Drop blur/spinner as soon as *this* modality is up; don't wait for its siblings.
  canvasEl.classList.remove('preview');
  imageLoaderEl.classList.remove('active');

  const { img, name, width, height, modality } = currentImage;

  // Update status
  updateStatus(`${name} (${width}×${height})`, `Zoom: ${zoom.toFixed(1)}x`, currentTupleIndex);

  // Calculate display size
  const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
  const vw = viewerEl.clientWidth - carouselOffset;
  const vh = viewerEl.clientHeight;
  const baseScale = Math.min(vw / width, vh / height);
  const scale = baseScale * zoom;

  canvasEl.width = width;
  canvasEl.height = height;
  ctx.drawImage(img, 0, 0);

  const displayW = width * scale;
  const displayH = height * scale;

  canvasEl.style.width = displayW + 'px';
  canvasEl.style.height = displayH + 'px';

  const centerOffsetX = carouselOffset / 2;
  canvasEl.style.transform = `translate(calc(-50% + ${panX + centerOffsetX}px), calc(-50% + ${panY}px))`;

  // Update thumbnail navigator
  renderThumbnail(img, width, height, vw, vh, baseScale);
}

function renderThumbnail(img: HTMLImageElement, imgW: number, imgH: number, viewerW: number, viewerH: number, baseScale: number) {
  const thumbScale = Math.min(THUMB_MAX_SIZE / imgW, THUMB_MAX_SIZE / imgH);
  const thumbW = Math.round(imgW * thumbScale);
  const thumbH = Math.round(imgH * thumbScale);

  thumbCanvasEl.width = thumbW;
  thumbCanvasEl.height = thumbH;
  thumbCtx.drawImage(img, 0, 0, thumbW, thumbH);

  const scale = baseScale * zoom;
  const visibleW = viewerW / scale;
  const visibleH = viewerH / scale;

  const centerX = imgW / 2 - panX / scale;
  const centerY = imgH / 2 - panY / scale;

  const vpLeft = centerX - visibleW / 2;
  const vpTop = centerY - visibleH / 2;

  const vpX = vpLeft * thumbScale;
  const vpY = vpTop * thumbScale;
  const vpW = visibleW * thumbScale;
  const vpH = visibleH * thumbScale;

  // Canvas is centered via margin:auto, so its left offset within #fp-minimap must be measured.
  const canvasOffsetX = thumbCanvasEl.offsetLeft;
  if (zoom <= 1.05) {
    thumbViewportEl.style.display = 'none';
  } else {
    thumbViewportEl.style.display = 'block';
    thumbViewportEl.style.left = (canvasOffsetX + Math.max(0, vpX)) + 'px';
    thumbViewportEl.style.top = Math.max(0, vpY) + 'px';
    thumbViewportEl.style.width = Math.min(vpW, thumbW - Math.max(0, vpX)) + 'px';
    thumbViewportEl.style.height = Math.min(vpH, thumbH - Math.max(0, vpY)) + 'px';
  }

  // Update crop overlay position if active
  if (crop.cropMode) {
    const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
    crop.renderCropOverlay({
      viewerEl, zoom, panX, panY, imgW, imgH, carouselOffset
    });
  }
}

// Event handlers
function handleKeyDown(e: KeyboardEvent) {
  // Modal for keys, as the host menu it replaced was: Del behind an open menu is a permanent file delete.
  if (isContextMenuOpen()) return;
  if (e.code === 'Escape' && helpModalEl.classList.contains('active')) {
    helpModalEl.classList.remove('active');
    e.preventDefault();
    return;
  }

  // Native save no-ops on the readonly custom editor, so the webview owns Ctrl/Cmd+S.
  if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (capabilities.saveSessionAs) vscode.postMessage({ type: 'saveSessionAs' });
    return;
  }

  // Crop mode intercepts keys
  if (crop.cropMode && crop.handleCropKeyDown(e)) return;

  if (!images.length) return;

  // Toggle crop mode with C key
  if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (crop.cropMode) {
      crop.exitCropMode();
    } else {
      tryEnterCropMode();
    }
    return;
  }

  // In crop mode, block tuple switching but allow modality switching
  if (crop.cropMode) {
    switch (e.code) {
      case 'ArrowRight':
      case 'ArrowLeft':
      case 'Space':
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
      case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
        break; // fall through to normal handling below
      default:
        return; // block everything else (ArrowUp/Down, BracketLeft/Right, etc.)
    }
  }

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      // A hidden flip *target* is skipped; flipping back to a hidden current the user clicked into still works (docs/session-files.md: hidden-is-presentation-only).
      if (!spaceDown && !hiddenModalities.has(modalityOrder[previousModalityIndex])) {
        spaceDown = true;
        const temp = currentModalityIndex;
        currentModalityIndex = previousModalityIndex;
        previousModalityIndex = temp;
        render();
        centreOnCurrentModality();
      }
      break;

    case 'ArrowRight':
    case 'ArrowLeft': {
      e.preventDefault();
      // Cycling skips hidden pills; click and digit jump still reach them (docs/session-files.md: hidden-is-presentation-only).
      const target = nextVisibleModality(currentModalityIndex, e.code === 'ArrowRight' ? 1 : -1, hiddenByDisplay());
      if (target !== currentModalityIndex) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex = asDisplay(target);
        render();
        centreOnCurrentModality();
        columnReport.keyed(currentModalityIndex);
      }
      break;
    }

    case 'BracketLeft':
      e.preventDefault();
      moveCurrentModality(-1);
      break;

    case 'BracketRight':
      e.preventDefault();
      moveCurrentModality(1);
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (isMultiTupleMode && currentTupleIndex > 0) {
        loadTuple(asTuple(currentTupleIndex - 1));
      }
      break;

    case 'ArrowDown':
      e.preventDefault();
      if (isMultiTupleMode && currentTupleIndex < tuples.length - 1) {
        loadTuple(asTuple(currentTupleIndex + 1));
      }
      break;

    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
    case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
      e.preventDefault();
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      if (idx < modalities.length && idx !== currentModalityIndex) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex = asDisplay(idx);
        render();
        centreOnCurrentModality();
        columnReport.keyed(currentModalityIndex);
      }
      break;

    case 'Escape':
      zoom = 1;
      panX = panY = 0;
      render();
      break;

    case 'Enter':
      e.preventDefault();
      if (votingEnabled) {
        toggleWinner(currentTupleIndex, currentModalityIndex);
      }
      break;

    case 'Delete':
    case 'Backspace': {
      // Del deletes the current tuple's files, same as the Tools-panel Delete button
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) break;
      e.preventDefault();
      deleteCurrentTuple();
      break;
    }
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') {
    spaceDown = false;
    if (images.length > 0) {
      const temp = currentModalityIndex;
      currentModalityIndex = previousModalityIndex;
      previousModalityIndex = temp;
      render();
      centreOnCurrentModality();
    }
  }
}

function handleWheel(e: WheelEvent) {
  const carouselRect = carouselEl.getBoundingClientRect();
  if (isMultiTupleMode &&
      e.clientX >= carouselRect.left && e.clientX <= carouselRect.right &&
      e.clientY >= carouselRect.top && e.clientY <= carouselRect.bottom) {
    return;
  }

  e.preventDefault();
  const delta = zoomFactor(e.deltaY, e.altKey);
  const newZoom = Math.max(0.1, Math.min(50, zoom * delta));

  const rect = viewerEl.getBoundingClientRect();
  const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
  const mouseX = e.clientX - rect.left - carouselOffset - (rect.width - carouselOffset) / 2;
  const mouseY = e.clientY - rect.top - rect.height / 2;

  const zoomRatio = newZoom / zoom;
  panX = mouseX - (mouseX - panX) * zoomRatio;
  panY = mouseY - (mouseY - panY) * zoomRatio;

  zoom = newZoom;
  render();
}

function handleMouseDown(e: MouseEvent) {
  // Left button only: a right-click's mouseup is swallowed by the context menu, leaving the pan armed with a stale anchor.
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('#carousel')) return;
  if ((e.target as HTMLElement).closest('#floating-panel')) return;

  // Crop mode intercepts mouse events
  if (crop.cropMode && crop.handleCropMouseDown(e)) return;

  isDragging = true;
  dragStartX = e.clientX - panX;
  dragStartY = e.clientY - panY;
  viewerEl.classList.add('dragging');
}

function handleMouseMove(e: MouseEvent) {
  if (crop.cropMode && crop.handleCropMouseMove(e)) return;
  if (!isDragging) return;
  panX = e.clientX - dragStartX;
  panY = e.clientY - dragStartY;
  render();
}

function handleMouseUp(e: MouseEvent) {
  if (crop.cropMode) crop.handleCropMouseUp(e);
  isDragging = false;
  viewerEl.classList.remove('dragging');
}

// Image copy must happen webview-side: vscode.env.clipboard is text-only, and the native webview menu cannot serialize a data-URL <img>.
function copyCurrentImage(): void {
  const currentImage = images[currentModalityIndex];
  if (!currentImage || (currentImage as any).missing) {
    showCopyToast('No image to copy');
    return;
  }
  const { img, width, height } = currentImage;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  // PNG is the only image type Chromium's async clipboard accepts.
  c.toBlob((blob) => {
    if (!blob) {
      showCopyToast('Copy failed');
      return;
    }
    writeImageToClipboard(blob);
  }, 'image/png');
}

// Deferred-until-focus clipboard write; latest copy wins — see docs/testing.md "Findings", copy-image staleness.
let pendingCopyBlob: Blob | null = null;
function writeImageToClipboard(blob: Blob): void {
  // Chromium rejects clipboard.write from an unfocused document (the context-menu path), keeping stale content.
  if (!document.hasFocus()) {
    if (pendingCopyBlob === null) window.addEventListener('focus', flushPendingCopy, { once: true });
    pendingCopyBlob = blob;
    return;
  }
  pendingCopyBlob = null;
  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
    () => showCopyToast('Image copied'),
    () => showCopyToast('Copy failed')
  );
}

function flushPendingCopy(): void {
  const blob = pendingCopyBlob;
  pendingCopyBlob = null;
  if (blob) writeImageToClipboard(blob);
}

function handleCopyEvent(e: ClipboardEvent) {
  // Only claim the copy when the user isn't copying selected text (e.g. from the status bar).
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
  copyCurrentImage();
}

function handleCarouselWheel(e: WheelEvent) {
  e.preventDefault();
  e.stopPropagation();
  // Sideways intent (trackpad deltaX or shift+wheel) pans the overflowing columns; otherwise scroll rows.
  if (carouselHScrollEl && (e.deltaX !== 0 || e.shiftKey)) {
    carouselHScrollEl.scrollLeft += scrollStep(e.deltaX !== 0 ? e.deltaX : e.deltaY, e.altKey);
    return;
  }
  queueCarouselWheel(scrollStep(e.deltaY, e.altKey));
}

let pendingWheelDelta = 0;
let wheelRaf = 0;
/**
 * Wheel deltas are summed and applied once per frame. The row axis is a virtualized wall, so each
 * apply rebinds rows and repaints tiles; several wheel events landing in one frame each did that
 * work and only the last was ever painted (docs/loading-architecture.md: wheel-coalesced-to-one-frame).
 */
function queueCarouselWheel(delta: number): void {
  pendingWheelDelta += delta;
  if (wheelRaf !== 0) return;
  carouselFlying = true;
  if (carouselSettleTimer !== undefined) clearTimeout(carouselSettleTimer);
  carouselSettleTimer = setTimeout(fillFlybyRows, CAROUSEL_SETTLE_MS) as unknown as number;
  wheelRaf = requestAnimationFrame(() => {
    wheelRaf = 0;
    const delta = pendingWheelDelta;
    pendingWheelDelta = 0;
    applyCarouselOffset(carouselOffset + delta);
  });
}

/** Wheel over the pill strip scrolls it, but only while it actually overflows — otherwise it would swallow a scroll meant for something else. */
function handlePillWheel(e: WheelEvent) {
  if (modalitySelectorEl.scrollWidth <= modalitySelectorEl.clientWidth) return;
  e.preventDefault();
  modalitySelectorEl.scrollLeft += scrollStep(e.deltaX !== 0 ? e.deltaX : e.deltaY, e.altKey);
}

function setupCarouselThumbDrag(thumb: HTMLElement) {
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startOffset = carouselOffset;
    const viewH = carouselEl.clientHeight;
    const contentH = carouselWallEl?.offsetHeight ?? 0;
    if (contentH <= viewH) return;
    const thumbH = Math.max(20, (viewH * viewH) / contentH);
    const scale = carouselMaxOffset() / Math.max(1, viewH - thumbH);
    const onMove = (ev: MouseEvent) => applyCarouselOffset(startOffset + (ev.clientY - startY) * scale);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function setupCarouselResize() {
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let resizeRaf = 0;

  // Virtualized, a full refit touches ~35 rows — cheap enough to run every frame of the drag.
  const refit = (snap: boolean) => {
    carouselEl.style.width = CAROUSEL_WIDTH + 'px';
    carouselResizeEl.style.left = (CAROUSEL_WIDTH - 4) + 'px';
    viewerEl.style.setProperty('--carousel-offset', CAROUSEL_WIDTH + 'px');
    // Anchor the current row's viewport Y across the row-height change — re-centering per frame made it bob; only the bounds clamp may move it. Rounded: a fractional anchor lands the focused row on shifting subpixel boundaries.
    const anchorY = Math.round(currentTupleIndex * carouselRowHeight() - carouselOffset);
    updateCarouselThumbSize(snap);
    applyCarouselOffset(currentTupleIndex * carouselRowHeight() - anchorY);
    render();
  };

  carouselResizeEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = CAROUSEL_WIDTH;
    carouselResizeEl.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = e.clientX - resizeStartX;
    // Drag up to every column at natural 50px (min 500 preserves old behavior), bounded by 60% of the window.
    const maxWidth = Math.min(Math.max(500, carouselFitWidth(50)), Math.floor(window.innerWidth * 0.6));
    CAROUSEL_WIDTH = Math.max(100, Math.min(maxWidth, resizeStartWidth + delta));
    if (!resizeRaf) {
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        refit(false);
      });
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      carouselResizeEl.classList.remove('dragging');
      document.body.style.cursor = '';
      // Drag over: one final refit with the device-pixel snap.
      refit(true);
    }
  });
}

// Start
init();
