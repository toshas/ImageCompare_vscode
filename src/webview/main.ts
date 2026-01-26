/**
 * WebView main script for ImageCompare
 * Handles all UI rendering and user interactions
 */

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
  tupleIndex: number;
  modalityIndex: number;
}

interface TupleInfo {
  name: string;
  images: ImageInfo[];
}

interface WebViewConfig {
  thumbnailSize: number;
  prefetchCount: number;
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
const thumbnailEl = document.getElementById('thumbnail')!;
const thumbCanvasEl = document.getElementById('thumb-canvas') as HTMLCanvasElement;
const thumbCtx = thumbCanvasEl.getContext('2d')!;
const thumbViewportEl = document.getElementById('thumb-viewport')!;
const carouselEl = document.getElementById('carousel')!;
const carouselResizeEl = document.getElementById('carousel-resize')!;
const progressContainerEl = document.getElementById('progress-container')!;
const progressTextEl = document.getElementById('progress-text')!;
const progressFillEl = document.getElementById('progress-fill')!;
const helpModalEl = document.getElementById('help-modal')!;
const helpBtn = document.getElementById('help-btn')!;
const closeHelpBtn = document.getElementById('close-help-btn')!;
const reorderLeftBtn = document.getElementById('reorder-left')!;
const reorderRightBtn = document.getElementById('reorder-right')!;
const imageLoaderEl = document.getElementById('image-loader')!;

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
let modalityColors: string[] = [];
let config: WebViewConfig = { thumbnailSize: 100, prefetchCount: 3 };

let currentTupleIndex = 0;
let currentModalityIndex = 0;
let previousModalityIndex = 0;

let images: (LoadedImage | undefined)[] = []; // Current tuple's loaded images (may have undefined slots)
let loadedTuples: Map<number, LoadedImage[]> = new Map();
let thumbnailDataUrls: Map<string, string> = new Map(); // "tupleIdx-modIdx" -> dataUrl

let zoom = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let spaceDown = false;
let isReset = false;

let CAROUSEL_WIDTH = 220;
let CAROUSEL_THUMB_SIZE = 50;

let isMultiTupleMode = false;
let modalityOrder: number[] = []; // maps display position -> original modality index
let isShowingPreview = false; // true when showing thumbnail as preview while full image loads
let loadDebounceTimer: number | null = null; // debounce timer for loading full images
const LOAD_DEBOUNCE_MS = 150; // wait this long before loading full images

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

  // Carousel scroll
  carouselEl.addEventListener('wheel', handleCarouselWheel, { passive: false });

  // Carousel resize
  setupCarouselResize();

  // Window resize
  window.addEventListener('resize', () => {
    if (images.length) render();
  });
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
    case 'fileDeleted':
      handleFileDeleted(message);
      break;
    case 'fileRestored':
      handleFileRestored(message);
      break;
    case 'tupleDeleted':
      handleTupleDeleted(message);
      break;
    case 'tupleAdded':
      handleTupleAdded(message);
      break;
    case 'modalityAdded':
      handleModalityAdded(message);
      break;
    case 'modalityRemoved':
      handleModalityRemoved(message);
      break;
  }
});

function handleInit(message: { tuples: TupleInfo[]; modalities: string[]; config: WebViewConfig }) {
  // Reset all state for new comparison
  tuples = message.tuples;
  modalities = message.modalities;
  config = message.config;
  modalityColors = modalities.map((_, i) => MODALITY_COLORS[i % MODALITY_COLORS.length]);
  modalityOrder = modalities.map((_, i) => i); // Initialize order: [0, 1, 2, ...]

  // Reset navigation state
  currentTupleIndex = 0;
  currentModalityIndex = 0;
  previousModalityIndex = 0;

  // Clear caches
  images = [];
  loadedTuples.clear();
  thumbnailDataUrls.clear();

  // Reset view state
  zoom = 1;
  panX = 0;
  panY = 0;
  isShowingPreview = false;

  // Cancel any pending load
  if (loadDebounceTimer !== null) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }

  // Hide loader if visible
  canvasEl.classList.remove('preview');
  imageLoaderEl.classList.remove('active');

  isMultiTupleMode = tuples.length > 1;

  // Calculate carousel thumb size
  updateCarouselThumbSize();

  // Build carousel
  if (isMultiTupleMode) {
    buildCarousel();
  }

  // Request first tuple's images
  loadTuple(0);

  // Hide loading, show UI
  loadingEl.classList.add('hidden');
  viewerEl.classList.add('active');
  infoEl.classList.remove('hidden');

  // Show progress if generating thumbnails
  if (isMultiTupleMode) {
    progressContainerEl.classList.add('active');
  }
}

function handleThumbnail(message: { tupleIndex: number; modalityIndex: number; dataUrl: string }) {
  const key = `${message.tupleIndex}-${message.modalityIndex}`;
  thumbnailDataUrls.set(key, message.dataUrl);

  // Update carousel thumb if exists
  const thumb = carouselEl.querySelector(
    `.carousel-thumb[data-tuple="${message.tupleIndex}"][data-modality="${message.modalityIndex}"]`
  ) as HTMLImageElement | null;

  if (thumb) {
    thumb.src = message.dataUrl;
    thumb.classList.remove('placeholder');
  }
}

function handleThumbnailError(message: { tupleIndex: number; modalityIndex: number; error: string }) {
  console.warn(`Thumbnail unavailable for ${message.tupleIndex}-${message.modalityIndex}: ${message.error}`);
  
  // Store placeholder in thumbnailDataUrls so it persists across carousel rebuilds
  const key = `${message.tupleIndex}-${message.modalityIndex}`;
  thumbnailDataUrls.set(key, PLACEHOLDER_THUMB);
  
  // Show placeholder in carousel
  const thumb = carouselEl.querySelector(
    `.carousel-thumb[data-tuple="${message.tupleIndex}"][data-modality="${message.modalityIndex}"]`
  ) as HTMLImageElement | null;
  
  if (thumb) {
    thumb.src = PLACEHOLDER_THUMB;
    thumb.classList.add('missing');
  }
}

function handleImage(message: { tupleIndex: number; modalityIndex: number; dataUrl: string; width: number; height: number }) {
  const img = new Image();
  img.onload = () => {
    const tupleImages = loadedTuples.get(message.tupleIndex) || [];

    const imageInfo = tuples[message.tupleIndex].images[message.modalityIndex];
    const loadedImage: LoadedImage = {
      img,
      name: imageInfo.name,
      modality: imageInfo.modality,
      width: message.width,
      height: message.height
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
        vscode.postMessage({
          type: 'tupleFullyLoaded',
          tupleIndex: currentTupleIndex
        });
      }
    }
  };
  img.src = message.dataUrl;
}

function handleImageError(message: { tupleIndex: number; modalityIndex: number; error: string }) {
  console.warn(`Image unavailable for ${message.tupleIndex}-${message.modalityIndex}: ${message.error}`);
  
  // Always mark this image as missing in loadedTuples (for caching)
  const tupleImages = loadedTuples.get(message.tupleIndex) || [];
  while (tupleImages.length <= message.modalityIndex) {
    tupleImages.push(undefined as any);
  }
  // Mark as missing
  tupleImages[message.modalityIndex] = { missing: true } as any;
  loadedTuples.set(message.tupleIndex, tupleImages);
  
  // If this is the current tuple, update display
  if (message.tupleIndex === currentTupleIndex) {
    // Update images array
    images = reorderImagesForDisplay(tupleImages);
    
    // Re-render (will handle blur/spinner based on whether all loaded)
    render();
    
    // Check if ALL modalities are loaded to notify extension for prefetching
    const allLoaded = images.every(img => img !== undefined);
    if (allLoaded) {
      vscode.postMessage({
        type: 'tupleFullyLoaded',
        tupleIndex: currentTupleIndex
      });
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
  const percent = Math.round((message.current / message.total) * 100);
  progressFillEl.style.width = `${percent}%`;
  progressTextEl.textContent = `${message.current}/${message.total}`;

  if (message.current >= message.total) {
    setTimeout(() => {
      progressContainerEl.classList.remove('active');
    }, 500);
  }
}

function handleFileDeleted(message: { tupleIndex: number; modalityIndex: number }) {
  // Clear the cached image for this file
  const cacheKey = `${message.tupleIndex}-${message.modalityIndex}`;
  
  // Clear from loadedTuples - mark as missing
  const tupleImages = loadedTuples.get(message.tupleIndex);
  if (tupleImages) {
    tupleImages[message.modalityIndex] = { missing: true } as any;
  }
  
  // Clear thumbnail data URL
  // Find original modality index for thumbnail lookup
  const originalModIdx = modalityOrder[message.modalityIndex] ?? message.modalityIndex;
  const thumbKey = `${message.tupleIndex}-${originalModIdx}`;
  thumbnailDataUrls.delete(thumbKey);
  
  // Update carousel to show placeholder for missing file
  const thumb = carouselEl.querySelector(
    `.carousel-thumb[data-tuple="${message.tupleIndex}"][data-modality="${originalModIdx}"]`
  ) as HTMLImageElement | null;
  if (thumb) {
    thumb.src = PLACEHOLDER_THUMB;
    thumb.classList.add('missing');
    thumb.classList.remove('placeholder');
  }
  
  // If this is the current tuple, update display
  if (message.tupleIndex === currentTupleIndex) {
    images = tupleImages ? reorderImagesForDisplay(tupleImages) : [];
    // If current modality was deleted, try to switch to another
    if (!images[currentModalityIndex] || (images[currentModalityIndex] as any).missing) {
      const availableIdx = images.findIndex(img => img && !(img as any).missing);
      if (availableIdx >= 0) {
        currentModalityIndex = availableIdx;
      }
    }
    render();
  }
}

function handleFileRestored(message: { tupleIndex: number; modalityIndex: number }) {
  // Clear the error marker from loadedTuples
  const tupleImages = loadedTuples.get(message.tupleIndex);
  if (tupleImages && tupleImages[message.modalityIndex]) {
    // Remove the error marker (will be reloaded)
    tupleImages[message.modalityIndex] = undefined as any;
  }
  
  // Clear thumbnail data URL so it gets regenerated
  const originalModIdx = modalityOrder[message.modalityIndex] ?? message.modalityIndex;
  const thumbKey = `${message.tupleIndex}-${originalModIdx}`;
  thumbnailDataUrls.delete(thumbKey);
  
  // Update carousel to remove missing state
  const thumb = carouselEl.querySelector(
    `.carousel-thumb[data-tuple="${message.tupleIndex}"][data-modality="${originalModIdx}"]`
  ) as HTMLImageElement | null;
  if (thumb) {
    thumb.classList.remove('missing');
    // The thumbnail will be updated when the new thumbnail message arrives
  }
  
  // If this is the current tuple, update display (will trigger reload)
  if (message.tupleIndex === currentTupleIndex) {
    images = tupleImages ? reorderImagesForDisplay(tupleImages) : [];
    render();
  }
}

function handleTupleDeleted(message: { tupleIndex: number }) {
  // Remove the tuple from our data
  tuples.splice(message.tupleIndex, 1);
  loadedTuples.delete(message.tupleIndex);
  
  // Re-index loaded tuples (shift indices down)
  const newLoadedTuples = new Map<number, LoadedImage[]>();
  for (const [idx, imgs] of loadedTuples) {
    if (idx > message.tupleIndex) {
      newLoadedTuples.set(idx - 1, imgs);
    } else {
      newLoadedTuples.set(idx, imgs);
    }
  }
  loadedTuples.clear();
  for (const [idx, imgs] of newLoadedTuples) {
    loadedTuples.set(idx, imgs);
  }
  
  // Adjust current tuple index if needed
  if (currentTupleIndex >= tuples.length) {
    currentTupleIndex = Math.max(0, tuples.length - 1);
  } else if (currentTupleIndex > message.tupleIndex) {
    currentTupleIndex--;
  }
  
  // Rebuild carousel
  if (isMultiTupleMode) {
    isMultiTupleMode = tuples.length > 1;
    buildCarousel();
  }
  
  // Load current tuple
  if (tuples.length > 0) {
    loadTuple(currentTupleIndex);
  }
}

function handleTupleAdded(message: { tuple: TupleInfo; tupleIndex: number }) {
  // Add the new tuple at the specified index
  tuples.splice(message.tupleIndex, 0, message.tuple);
  
  // Re-index loaded tuples (shift indices up)
  const newLoadedTuples = new Map<number, LoadedImage[]>();
  for (const [idx, imgs] of loadedTuples) {
    if (idx >= message.tupleIndex) {
      newLoadedTuples.set(idx + 1, imgs);
    } else {
      newLoadedTuples.set(idx, imgs);
    }
  }
  loadedTuples.clear();
  for (const [idx, imgs] of newLoadedTuples) {
    loadedTuples.set(idx, imgs);
  }
  
  // Adjust current tuple index if needed
  if (currentTupleIndex >= message.tupleIndex) {
    currentTupleIndex++;
  }
  
  // Update multi-tuple mode
  isMultiTupleMode = tuples.length > 1;
  
  // Rebuild carousel
  if (isMultiTupleMode) {
    buildCarousel();
  }
}

function handleModalityAdded(message: { modality: string; modalityIndex: number }) {
  // Insert new modality at the specified index
  modalities.splice(message.modalityIndex, 0, message.modality);
  
  // Add color for new modality
  modalityColors.splice(message.modalityIndex, 0, MODALITY_COLORS[modalities.length - 1 % MODALITY_COLORS.length]);
  
  // Reset modalityOrder to default [0, 1, 2, ...] - simpler than trying to shift indices
  modalityOrder = modalities.map((_, i) => i);
  
  // Reset current modality to 0 to avoid confusion
  currentModalityIndex = 0;
  previousModalityIndex = 0;
  
  // Update ALL tuples to have a placeholder for the new modality
  for (let t = 0; t < tuples.length; t++) {
    const tuple = tuples[t];
    // Insert placeholder ImageInfo for new modality
    const placeholder: ImageInfo = {
      name: '', // Empty name indicates missing
      modality: message.modality,
      tupleIndex: t,
      modalityIndex: message.modalityIndex
    };
    tuple.images.splice(message.modalityIndex, 0, placeholder);
    
    // Update modalityIndex for subsequent images
    for (let i = message.modalityIndex + 1; i < tuple.images.length; i++) {
      tuple.images[i].modalityIndex = i;
    }
  }
  
  // Clear all caches - indices have changed, old cached data is invalid
  loadedTuples.clear();
  thumbnailDataUrls.clear();
  images = [];
  
  // Rebuild UI
  buildModalitySelector();
  if (isMultiTupleMode) {
    updateCarouselThumbSize();
    buildCarousel();
  }
  
  // Request ALL thumbnails again (indices changed)
  vscode.postMessage({
    type: 'requestThumbnails',
    tupleIndices: Array.from({ length: tuples.length }, (_, i) => i)
  });
  
  // Force reload current tuple to get fresh images with correct indices
  loadedTuples.delete(currentTupleIndex);
  images = [];
  loadTuple(currentTupleIndex);
}

function handleModalityRemoved(message: { modalityIndex: number }) {
  const removedModality = modalities[message.modalityIndex];
  
  // Remove from modalities and colors
  modalities.splice(message.modalityIndex, 1);
  modalityColors.splice(message.modalityIndex, 1);
  
  // Reset modalityOrder to default [0, 1, 2, ...]
  modalityOrder = modalities.map((_, i) => i);
  
  // Adjust current modality index if needed
  if (currentModalityIndex >= modalities.length) {
    currentModalityIndex = Math.max(0, modalities.length - 1);
  }
  if (previousModalityIndex >= modalities.length) {
    previousModalityIndex = Math.max(0, modalities.length - 1);
  }
  
  // Update ALL tuples to remove the modality
  for (const tuple of tuples) {
    tuple.images = tuple.images.filter(img => img.modality !== removedModality);
    // Update modalityIndex for remaining images
    tuple.images.forEach((img, i) => {
      img.modalityIndex = i;
    });
  }
  
  // Clear all caches - indices have changed
  loadedTuples.clear();
  thumbnailDataUrls.clear();
  images = [];
  
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
  
  // Force reload current tuple
  loadTuple(currentTupleIndex);
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

function loadTuple(index: number) {
  if (index < 0 || index >= tuples.length) return;

  currentTupleIndex = index;

  // Immediately tell extension which tuple we're on (to cancel stale loads)
  vscode.postMessage({
    type: 'setCurrentTuple',
    tupleIndex: index
  });

  // Cancel any pending load request (user is still scrolling)
  if (loadDebounceTimer !== null) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }

  // Check if already loaded
  if (loadedTuples.has(index)) {
    const originalImages = loadedTuples.get(index)!;
    images = reorderImagesForDisplay(originalImages);
    
    // Check if current modality's full image is available
    if (images[currentModalityIndex]) {
      buildModalitySelector();
      render(); // render() handles blur/spinner based on allLoaded state
      
      // Notify extension if fully loaded
      const allLoaded = images.every(img => img !== undefined);
      if (allLoaded) {
        vscode.postMessage({
          type: 'tupleFullyLoaded',
          tupleIndex: index
        });
      }
      return;
    }
  }

  // Full image not available - show thumbnail preview immediately
  showPreviewOrLoading(index, currentModalityIndex);

  // Build modality selector and update carousel immediately
  buildModalitySelector();
  updateCarouselSelection();

  // Debounce the actual image loading - wait for user to stop scrolling
  loadDebounceTimer = window.setTimeout(() => {
    loadDebounceTimer = null;
    
    // Make sure we're still on the same tuple
    if (currentTupleIndex !== index) return;
    
    // Request images from extension
    const tuple = tuples[index];
    for (let i = 0; i < tuple.images.length; i++) {
      vscode.postMessage({
        type: 'requestImage',
        tupleIndex: index,
        modalityIndex: i
      });
    }

    // Notify extension of navigation
    vscode.postMessage({
      type: 'navigateTo',
      tupleIndex: index
    });
  }, LOAD_DEBOUNCE_MS);
}

function showPreviewOrLoading(tupleIndex: number, displayModalityIndex: number) {
  // Get the original modality index for thumbnail lookup
  const originalModIdx = modalityOrder[displayModalityIndex];
  const thumbnailKey = `${tupleIndex}-${originalModIdx}`;
  const thumbnailDataUrl = thumbnailDataUrls.get(thumbnailKey);
  
  if (thumbnailDataUrl) {
    // Show thumbnail as blurry preview
    const previewImg = new Image();
    previewImg.onload = () => {
      // Only show if we're still on the same tuple/modality
      if (currentTupleIndex === tupleIndex && currentModalityIndex === displayModalityIndex) {
        isShowingPreview = true;
        canvasEl.classList.add('preview');
        
        // Draw thumbnail to canvas (will be blurry due to upscaling)
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
        
        // Update status
        const tuple = tuples[tupleIndex];
        updateStatus(`${tuple.name} | Loading...`, `Zoom: ${zoom.toFixed(1)}x`, tupleIndex);
      }
    };
    previewImg.src = thumbnailDataUrl;
  } else {
    // No thumbnail available - show a loading placeholder on the canvas
    // This prevents white/blank canvas while waiting for image data
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
    
    // Update status
    const modalityName = modalities[displayModalityIndex] || 'Image';
    updateStatus(`${modalityName}: Loading...`, `Zoom: ${zoom.toFixed(1)}x`, tupleIndex);
  }
  
  // Show spinner
  imageLoaderEl.classList.add('active');
}

function updateCarouselThumbSize() {
  const numModalities = modalities.length;
  const availableWidth = CAROUSEL_WIDTH - 12 - (numModalities - 1) * 2;
  CAROUSEL_THUMB_SIZE = Math.floor(availableWidth / numModalities);
  CAROUSEL_THUMB_SIZE = Math.max(30, CAROUSEL_THUMB_SIZE);
}

function buildCarousel() {
  carouselEl.innerHTML = '';
  carouselEl.style.width = CAROUSEL_WIDTH + 'px';

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

  for (let tupleIdx = 0; tupleIdx < tuples.length; tupleIdx++) {
    const tuple = tuples[tupleIdx];
    const row = document.createElement('div');
    row.className = 'carousel-row';
    row.dataset.tupleIndex = String(tupleIdx);

    // Use modalityOrder to display thumbnails in the current order
    for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
      const originalModIdx = modalityOrder[displayIdx];
      const thumb = document.createElement('img');
      thumb.className = 'carousel-thumb placeholder';
      thumb.style.width = CAROUSEL_THUMB_SIZE + 'px';
      thumb.style.height = CAROUSEL_THUMB_SIZE + 'px';
      thumb.dataset.tuple = String(tupleIdx);
      thumb.dataset.modality = String(originalModIdx);
      thumb.dataset.displayIndex = String(displayIdx);

      // Check if we have thumbnail already (use original index for lookup)
      const key = `${tupleIdx}-${originalModIdx}`;
      if (thumbnailDataUrls.has(key)) {
        const thumbUrl = thumbnailDataUrls.get(key)!;
        thumb.src = thumbUrl;
        thumb.classList.remove('placeholder');
        // Add 'missing' class if this is the placeholder thumbnail
        if (thumbUrl === PLACEHOLDER_THUMB) {
          thumb.classList.add('missing');
        }
      }

      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        // Navigate to the display index, not the original index
        goToTupleAndModality(tupleIdx, displayIdx);
      });

      row.appendChild(thumb);
    }

    row.addEventListener('click', () => {
      if (tupleIdx !== currentTupleIndex) {
        loadTuple(tupleIdx);
      }
    });

    carouselEl.appendChild(row);
  }

  updateCarouselSelection();
}

function updateCarouselSelection() {
  if (!isMultiTupleMode) return;

  const rows = carouselEl.querySelectorAll('.carousel-row');
  rows.forEach((row, rowIdx) => {
    if (rowIdx === currentTupleIndex) {
      row.classList.add('current');
    } else {
      row.classList.remove('current');
    }

    const thumbs = row.querySelectorAll('.carousel-thumb');
    thumbs.forEach((thumb, thumbIdx) => {
      if (rowIdx === currentTupleIndex) {
        thumb.classList.add('active');
      } else {
        thumb.classList.remove('active');
      }

      if (rowIdx === currentTupleIndex && thumbIdx === currentModalityIndex) {
        thumb.classList.add('selected');
      } else {
        thumb.classList.remove('selected');
      }
    });
  });

  scrollCarouselToCurrentTuple();
}

function scrollCarouselToCurrentTuple() {
  if (!isMultiTupleMode) return;

  const rows = carouselEl.querySelectorAll('.carousel-row');
  if (rows.length === 0 || currentTupleIndex >= rows.length) return;

  const currentRow = rows[currentTupleIndex] as HTMLElement;
  const carouselHeight = carouselEl.clientHeight;
  const rowHeight = currentRow.offsetHeight;
  const rowTop = currentRow.offsetTop;

  const targetScroll = rowTop - (carouselHeight / 2) + (rowHeight / 2);
  carouselEl.scrollTo({
    top: Math.max(0, targetScroll),
    behavior: 'smooth'
  });
}

function goToTupleAndModality(tupleIdx: number, modalityIdx: number) {
  if (tupleIdx === currentTupleIndex) {
    if (modalityIdx !== currentModalityIndex) {
      previousModalityIndex = currentModalityIndex;
      currentModalityIndex = modalityIdx;
      render();
      updateCarouselSelection();
    }
  } else {
    currentModalityIndex = modalityIdx;
    loadTuple(tupleIdx);
  }
}

function buildModalitySelector() {
  modalitySelectorEl.innerHTML = '';

  // Build buttons in display order
  // Note: modalities and modalityColors are already in display order after any reordering
  for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
    const btn = document.createElement('button');
    btn.className = 'modality-btn';
    btn.textContent = `${displayIdx + 1}: ${modalities[displayIdx]}`;
    btn.style.background = modalityColors[displayIdx];
    btn.dataset.displayIndex = String(displayIdx);

    btn.addEventListener('click', () => {
      if (currentModalityIndex !== displayIdx) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex = displayIdx;
        render();
      }
    });

    modalitySelectorEl.appendChild(btn);
  }

  updateModalitySelector();
}

function updateModalitySelector() {
  const buttons = modalitySelectorEl.querySelectorAll('.modality-btn');
  buttons.forEach((btn) => {
    const displayIdx = parseInt((btn as HTMLElement).dataset.displayIndex || '0', 10);
    if (displayIdx === currentModalityIndex) {
      btn.classList.add('active');
      btn.classList.remove('inactive');
    } else {
      btn.classList.remove('active');
      btn.classList.add('inactive');
    }
  });

  reorderLeftBtn.setAttribute('disabled', currentModalityIndex <= 0 ? 'true' : '');
  reorderRightBtn.setAttribute('disabled', currentModalityIndex >= modalityOrder.length - 1 ? 'true' : '');

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
  const newPos = currentPos + direction;

  if (newPos < 0 || newPos >= modalities.length) return;

  // Swap in modalities
  [modalities[currentPos], modalities[newPos]] = [modalities[newPos], modalities[currentPos]];

  // Swap in colors
  [modalityColors[currentPos], modalityColors[newPos]] = [modalityColors[newPos], modalityColors[currentPos]];

  // Swap in modalityOrder (tracks original index at each display position)
  [modalityOrder[currentPos], modalityOrder[newPos]] = [modalityOrder[newPos], modalityOrder[currentPos]];

  // Re-derive images array from cached data using new modalityOrder
  // This is more robust than swapping in-place, handles undefined/missing markers correctly
  const tupleImages = loadedTuples.get(currentTupleIndex);
  
  if (tupleImages && tupleImages.length > 0) {
    images = reorderImagesForDisplay(tupleImages);
  } else {
    // No cached data - manually swap the images array to stay in sync
    // This handles the case where reordering happens before all images are loaded
    const temp = images[currentPos];
    images[currentPos] = images[newPos];
    images[newPos] = temp;
  }

  // Update current index
  currentModalityIndex = newPos;

  // Rebuild UI
  buildModalitySelector();
  if (isMultiTupleMode) {
    buildCarousel();
  }
  render();
}

function render() {
  const currentImage = images[currentModalityIndex];
  
  // Always update UI state (even when showing preview)
  updateModalitySelector();
  if (isMultiTupleMode) {
    updateCarouselSelection();
  }
  
  // Check if current image is an error marker
  const isMissing = currentImage && (currentImage as any).missing;

  if (!currentImage || isMissing) {
    // No full image available or missing - show preview/placeholder
    if (isMissing) {
      showMissingPlaceholder();
      canvasEl.classList.remove('preview');
      imageLoaderEl.classList.remove('active');
      isShowingPreview = false;
      // Update status (friendly, not an error)
      // Note: modalities array is already in display order after any reordering
      const modalityName = modalities[currentModalityIndex] || 'Image';
      updateStatus(`${modalityName}: not available`, `Zoom: ${zoom.toFixed(1)}x`, currentTupleIndex);
    } else {
      showPreviewOrLoading(currentTupleIndex, currentModalityIndex);
    }
    return;
  }

  // Full image available - remove blur and spinner immediately
  // Don't wait for other modalities to load
  canvasEl.classList.remove('preview');
  imageLoaderEl.classList.remove('active');
  isShowingPreview = false;

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
  if (zoom <= 1.05) {
    thumbnailEl.classList.remove('active');
    return;
  }
  thumbnailEl.classList.add('active');

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

  thumbViewportEl.style.left = (4 + Math.max(0, vpX)) + 'px';
  thumbViewportEl.style.top = (4 + Math.max(0, vpY)) + 'px';
  thumbViewportEl.style.width = Math.min(vpW, thumbW - Math.max(0, vpX)) + 'px';
  thumbViewportEl.style.height = Math.min(vpH, thumbH - Math.max(0, vpY)) + 'px';
}

// Event handlers
function handleKeyDown(e: KeyboardEvent) {
  if (e.code === 'Escape' && helpModalEl.classList.contains('active')) {
    helpModalEl.classList.remove('active');
    e.preventDefault();
    return;
  }

  if (!images.length) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        const temp = currentModalityIndex;
        currentModalityIndex = previousModalityIndex;
        previousModalityIndex = temp;
        render();
      }
      break;

    case 'ArrowRight':
      e.preventDefault();
      if (currentModalityIndex < modalityOrder.length - 1) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex++;
        render();
      }
      break;

    case 'ArrowLeft':
      e.preventDefault();
      if (currentModalityIndex > 0) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex--;
        render();
      }
      break;

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
        loadTuple(currentTupleIndex - 1);
      }
      break;

    case 'ArrowDown':
      e.preventDefault();
      if (isMultiTupleMode && currentTupleIndex < tuples.length - 1) {
        loadTuple(currentTupleIndex + 1);
      }
      break;

    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
    case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
      e.preventDefault();
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      if (idx < modalities.length && idx !== currentModalityIndex) {
        previousModalityIndex = currentModalityIndex;
        currentModalityIndex = idx;
        render();
      }
      break;

    case 'Escape':
      zoom = 1;
      panX = panY = 0;
      isReset = true;
      render();
      break;
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
  const delta = e.deltaY > 0 ? 0.97 : 1.03;
  const newZoom = Math.max(0.1, Math.min(50, zoom * delta));

  const rect = viewerEl.getBoundingClientRect();
  const carouselOffset = isMultiTupleMode ? CAROUSEL_WIDTH : 0;
  const mouseX = e.clientX - rect.left - carouselOffset - (rect.width - carouselOffset) / 2;
  const mouseY = e.clientY - rect.top - rect.height / 2;

  const zoomRatio = newZoom / zoom;
  panX = mouseX - (mouseX - panX) * zoomRatio;
  panY = mouseY - (mouseY - panY) * zoomRatio;

  zoom = newZoom;
  isReset = false;
  render();
}

function handleMouseDown(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('#carousel')) return;

  isDragging = true;
  dragStartX = e.clientX - panX;
  dragStartY = e.clientY - panY;
  viewerEl.classList.add('dragging');
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging) return;
  panX = e.clientX - dragStartX;
  panY = e.clientY - dragStartY;
  isReset = false;
  render();
}

function handleMouseUp() {
  isDragging = false;
  viewerEl.classList.remove('dragging');
}

function handleCarouselWheel(e: WheelEvent) {
  e.preventDefault();
  e.stopPropagation();
  carouselEl.scrollTop += e.deltaY;
}

function setupCarouselResize() {
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

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
    const newWidth = Math.max(100, Math.min(500, resizeStartWidth + delta));
    CAROUSEL_WIDTH = newWidth;
    carouselEl.style.width = CAROUSEL_WIDTH + 'px';
    carouselResizeEl.style.left = (CAROUSEL_WIDTH - 4) + 'px';
    viewerEl.style.setProperty('--carousel-offset', CAROUSEL_WIDTH + 'px');

    updateCarouselThumbSize();

    const thumbs = carouselEl.querySelectorAll('.carousel-thumb') as NodeListOf<HTMLElement>;
    thumbs.forEach(thumb => {
      thumb.style.width = CAROUSEL_THUMB_SIZE + 'px';
      thumb.style.height = CAROUSEL_THUMB_SIZE + 'px';
    });

    render();
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      carouselResizeEl.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  });
}

// Start
init();
