/**
 * Crop mode module for ImageCompare webview.
 *
 * Handles crop rectangle drawing, resize handles, coordinate mapping
 * between screen space and image-pixel space, and overlay rendering.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CropRect {
  x: number; // image-pixel left
  y: number; // image-pixel top
  w: number; // image-pixel width
  h: number; // image-pixel height
}

export interface ViewportInfo {
  viewerEl: HTMLElement;
  zoom: number;
  panX: number;
  panY: number;
  imgW: number;
  imgH: number;
  carouselOffset: number;
}

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLE_SIZE = 10;
const MIN_CROP_PX = 4; // minimum crop size in image pixels

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export let cropMode = false;
export let cropRect: CropRect | null = null;

let overlayEl: HTMLDivElement | null = null;
let rectEl: HTMLDivElement | null = null;
let toolbarEl: HTMLDivElement | null = null;
let dimEls: HTMLDivElement[] = [];
let handleEls: Map<HandleId, HTMLDivElement> = new Map();

let isDrawing = false;
let isMoving = false;
let isResizing = false;
let activeHandle: HandleId | null = null;
let drawStartImg: { x: number; y: number } | null = null;
let moveStartImg: { x: number; y: number } | null = null;
let moveStartRect: CropRect | null = null;

let onConfirm: (() => void) | null = null;
let lastViewport: ViewportInfo | null = null;

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

function getBaseScale(vp: ViewportInfo): number {
  const rect = vp.viewerEl.getBoundingClientRect();
  const vw = rect.width - vp.carouselOffset;
  const vh = rect.height;
  return Math.min(vw / vp.imgW, vh / vp.imgH);
}

export function screenToImage(screenX: number, screenY: number, vp: ViewportInfo): { x: number; y: number } {
  const rect = vp.viewerEl.getBoundingClientRect();
  const vw = rect.width - vp.carouselOffset;
  const vh = rect.height;
  const baseScale = getBaseScale(vp);
  const displayScale = baseScale * vp.zoom;

  const viewerCenterX = rect.left + vp.carouselOffset + vw / 2;
  const viewerCenterY = rect.top + vh / 2;

  const imageX = (screenX - viewerCenterX - vp.panX) / displayScale + vp.imgW / 2;
  const imageY = (screenY - viewerCenterY - vp.panY) / displayScale + vp.imgH / 2;

  return {
    x: Math.max(0, Math.min(vp.imgW, Math.round(imageX))),
    y: Math.max(0, Math.min(vp.imgH, Math.round(imageY)))
  };
}

function imageToScreen(imgX: number, imgY: number, vp: ViewportInfo): { x: number; y: number } {
  const rect = vp.viewerEl.getBoundingClientRect();
  const vw = rect.width - vp.carouselOffset;
  const vh = rect.height;
  const baseScale = getBaseScale(vp);
  const displayScale = baseScale * vp.zoom;

  const viewerCenterX = rect.left + vp.carouselOffset + vw / 2;
  const viewerCenterY = rect.top + vh / 2;

  return {
    x: (imgX - vp.imgW / 2) * displayScale + vp.panX + viewerCenterX,
    y: (imgY - vp.imgH / 2) * displayScale + vp.panY + viewerCenterY
  };
}

// ---------------------------------------------------------------------------
// DOM creation
// ---------------------------------------------------------------------------

function createOverlay(viewerEl: HTMLElement): void {
  overlayEl = document.createElement('div');
  overlayEl.id = 'crop-overlay';
  viewerEl.appendChild(overlayEl);

  // 4 dim regions (top, bottom, left, right of crop rect)
  // Start hidden to prevent flash before first renderCropOverlay call
  for (let i = 0; i < 4; i++) {
    const dim = document.createElement('div');
    dim.className = 'crop-dim';
    dim.style.display = 'none';
    overlayEl.appendChild(dim);
    dimEls.push(dim);
  }

  // Crop rectangle (hidden until user draws)
  rectEl = document.createElement('div');
  rectEl.className = 'crop-rect';
  rectEl.style.display = 'none';
  overlayEl.appendChild(rectEl);

  // Resize handles
  const handles: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const id of handles) {
    const handle = document.createElement('div');
    handle.className = 'crop-handle';
    handle.dataset.handle = id;
    handle.style.cursor = getCursorForHandle(id);
    overlayEl.appendChild(handle);
    handleEls.set(id, handle);
  }

  // Toolbar (confirm/cancel)
  toolbarEl = document.createElement('div');
  toolbarEl.className = 'crop-toolbar';
  toolbarEl.innerHTML = `
    <button class="crop-toolbar-btn crop-confirm" title="Confirm crop (Enter)">&#10003; Crop</button>
    <button class="crop-toolbar-btn crop-cancel" title="Cancel (Escape)">&#10005;</button>
  `;
  overlayEl.appendChild(toolbarEl);

  toolbarEl.querySelector('.crop-confirm')!.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    confirmCrop();
  });
  toolbarEl.querySelector('.crop-cancel')!.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    exitCropMode(true);
  });

  // Initially hide handles and toolbar
  setHandlesVisible(false);
  toolbarEl.style.display = 'none';
}

function destroyOverlay(): void {
  if (overlayEl && overlayEl.parentNode) {
    overlayEl.parentNode.removeChild(overlayEl);
  }
  overlayEl = null;
  rectEl = null;
  toolbarEl = null;
  dimEls = [];
  handleEls.clear();
}

function setHandlesVisible(visible: boolean): void {
  for (const el of handleEls.values()) {
    el.style.display = visible ? 'block' : 'none';
  }
}

function getCursorForHandle(id: HandleId): string {
  const map: Record<HandleId, string> = {
    nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize', e: 'e-resize',
    se: 'se-resize', s: 's-resize', sw: 'sw-resize', w: 'w-resize'
  };
  return map[id];
}

// ---------------------------------------------------------------------------
// Enter / exit
// ---------------------------------------------------------------------------

export function enterCropMode(viewerEl: HTMLElement, confirmCallback: () => void, viewport?: ViewportInfo): void {
  if (cropMode) return;
  cropMode = true;
  cropRect = null;
  onConfirm = confirmCallback;
  isDrawing = false;
  isMoving = false;
  isResizing = false;
  if (viewport) lastViewport = viewport;
  createOverlay(viewerEl);
}

export function exitCropMode(_cancel: boolean): void {
  cropMode = false;
  cropRect = null;
  isDrawing = false;
  isMoving = false;
  isResizing = false;
  activeHandle = null;
  onConfirm = null;
  lastViewport = null;
  destroyOverlay();

  // Update crop button state
  const btn = document.getElementById('crop-btn');
  if (btn) btn.classList.remove('active');
}

function confirmCrop(): void {
  if (cropRect && onConfirm) {
    onConfirm();
  }
}

// ---------------------------------------------------------------------------
// Mouse handlers — return true if event was consumed
// ---------------------------------------------------------------------------

export function handleCropMouseDown(e: MouseEvent): boolean {
  if (!overlayEl || !lastViewport) return false;

  // Check if clicking on a handle
  const target = e.target as HTMLElement;
  if (target.classList.contains('crop-handle') && target.dataset.handle) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    activeHandle = target.dataset.handle as HandleId;
    return true;
  }

  // Check if clicking inside the crop-toolbar
  if (target.closest('.crop-toolbar')) {
    return true;
  }

  // Check if clicking inside existing crop rect (to move)
  if (cropRect && rectEl) {
    const screenPos = imageToScreen(cropRect.x, cropRect.y, lastViewport);
    const screenEnd = imageToScreen(cropRect.x + cropRect.w, cropRect.y + cropRect.h, lastViewport);
    const viewerRect = lastViewport.viewerEl.getBoundingClientRect();
    const sx = screenPos.x - viewerRect.left;
    const sy = screenPos.y - viewerRect.top;
    const ex = screenEnd.x - viewerRect.left;
    const ey = screenEnd.y - viewerRect.top;

    if (e.offsetX >= sx && e.offsetX <= ex && e.offsetY >= sy && e.offsetY <= ey) {
      e.preventDefault();
      e.stopPropagation();
      isMoving = true;
      const imgPos = screenToImage(e.clientX, e.clientY, lastViewport);
      moveStartImg = imgPos;
      moveStartRect = { ...cropRect };
      return true;
    }
  }

  // Start drawing a new crop rectangle
  e.preventDefault();
  e.stopPropagation();
  isDrawing = true;
  const imgPos = screenToImage(e.clientX, e.clientY, lastViewport);
  drawStartImg = imgPos;
  cropRect = { x: imgPos.x, y: imgPos.y, w: 0, h: 0 };
  setHandlesVisible(false);
  if (toolbarEl) toolbarEl.style.display = 'none';
  return true;
}

export function handleCropMouseMove(e: MouseEvent): boolean {
  if (!lastViewport) return false;

  if (isDrawing && drawStartImg) {
    e.preventDefault();
    const imgPos = screenToImage(e.clientX, e.clientY, lastViewport);
    const x1 = Math.min(drawStartImg.x, imgPos.x);
    const y1 = Math.min(drawStartImg.y, imgPos.y);
    const x2 = Math.max(drawStartImg.x, imgPos.x);
    const y2 = Math.max(drawStartImg.y, imgPos.y);
    cropRect = {
      x: Math.max(0, x1),
      y: Math.max(0, y1),
      w: Math.min(lastViewport.imgW, x2) - Math.max(0, x1),
      h: Math.min(lastViewport.imgH, y2) - Math.max(0, y1)
    };
    renderCropOverlay(lastViewport);
    return true;
  }

  if (isMoving && moveStartImg && moveStartRect) {
    e.preventDefault();
    const imgPos = screenToImage(e.clientX, e.clientY, lastViewport);
    const dx = imgPos.x - moveStartImg.x;
    const dy = imgPos.y - moveStartImg.y;
    let newX = moveStartRect.x + dx;
    let newY = moveStartRect.y + dy;
    // Clamp to image bounds
    newX = Math.max(0, Math.min(lastViewport.imgW - moveStartRect.w, newX));
    newY = Math.max(0, Math.min(lastViewport.imgH - moveStartRect.h, newY));
    cropRect = { x: Math.round(newX), y: Math.round(newY), w: moveStartRect.w, h: moveStartRect.h };
    renderCropOverlay(lastViewport);
    return true;
  }

  if (isResizing && activeHandle && cropRect) {
    e.preventDefault();
    const imgPos = screenToImage(e.clientX, e.clientY, lastViewport);
    const r = { ...cropRect };

    // Adjust edges based on which handle is being dragged
    if (activeHandle.includes('n')) {
      const newTop = Math.max(0, Math.min(r.y + r.h - MIN_CROP_PX, imgPos.y));
      r.h = r.y + r.h - newTop;
      r.y = newTop;
    }
    if (activeHandle.includes('s')) {
      r.h = Math.max(MIN_CROP_PX, Math.min(lastViewport.imgH - r.y, imgPos.y - r.y));
    }
    if (activeHandle.includes('w')) {
      const newLeft = Math.max(0, Math.min(r.x + r.w - MIN_CROP_PX, imgPos.x));
      r.w = r.x + r.w - newLeft;
      r.x = newLeft;
    }
    if (activeHandle.includes('e')) {
      r.w = Math.max(MIN_CROP_PX, Math.min(lastViewport.imgW - r.x, imgPos.x - r.x));
    }

    cropRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    renderCropOverlay(lastViewport);
    return true;
  }

  return false;
}

export function handleCropMouseUp(_e: MouseEvent): boolean {
  const wasDrawing = isDrawing;
  const wasActive = isDrawing || isMoving || isResizing;
  isDrawing = false;
  isMoving = false;
  isResizing = false;
  activeHandle = null;
  drawStartImg = null;
  moveStartImg = null;
  moveStartRect = null;

  if (wasActive && cropRect && cropRect.w >= MIN_CROP_PX && cropRect.h >= MIN_CROP_PX) {
    setHandlesVisible(true);
    if (toolbarEl) toolbarEl.style.display = 'flex';
    if (lastViewport) renderCropOverlay(lastViewport);
  } else if (wasDrawing) {
    // Drawn rect too small — discard
    cropRect = null;
    setHandlesVisible(false);
    if (toolbarEl) toolbarEl.style.display = 'none';
    if (lastViewport) renderCropOverlay(lastViewport);
  }
  return wasActive;
}

// ---------------------------------------------------------------------------
// Keyboard handler — return true if consumed
// ---------------------------------------------------------------------------

export function handleCropKeyDown(e: KeyboardEvent): boolean {
  if (e.code === 'Enter' && cropRect && cropRect.w >= MIN_CROP_PX && cropRect.h >= MIN_CROP_PX) {
    e.preventDefault();
    confirmCrop();
    return true;
  }
  if (e.code === 'Escape') {
    e.preventDefault();
    exitCropMode(true);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Overlay rendering
// ---------------------------------------------------------------------------

export function renderCropOverlay(vp: ViewportInfo): void {
  lastViewport = vp;

  if (!overlayEl || !rectEl || !cropRect) {
    // Hide everything if no rect
    if (overlayEl) overlayEl.style.display = cropMode ? 'block' : 'none';
    for (const dim of dimEls) dim.style.display = 'none';
    if (rectEl) rectEl.style.display = 'none';
    setHandlesVisible(false);
    if (toolbarEl) toolbarEl.style.display = 'none';
    return;
  }

  overlayEl.style.display = 'block';

  const viewerRect = vp.viewerEl.getBoundingClientRect();

  // Convert crop rect corners to screen-relative coordinates (within viewer)
  const topLeft = imageToScreen(cropRect.x, cropRect.y, vp);
  const bottomRight = imageToScreen(cropRect.x + cropRect.w, cropRect.y + cropRect.h, vp);

  const sx = topLeft.x - viewerRect.left;
  const sy = topLeft.y - viewerRect.top;
  const ex = bottomRight.x - viewerRect.left;
  const ey = bottomRight.y - viewerRect.top;
  const sw = ex - sx;
  const sh = ey - sy;

  const ow = viewerRect.width;
  const oh = viewerRect.height;

  // Position dim overlays (top, bottom, left, right)
  if (dimEls.length >= 4) {
    // Top
    dimEls[0].style.cssText = `display:block; left:0; top:0; width:${ow}px; height:${Math.max(0, sy)}px;`;
    // Bottom
    dimEls[1].style.cssText = `display:block; left:0; top:${ey}px; width:${ow}px; height:${Math.max(0, oh - ey)}px;`;
    // Left
    dimEls[2].style.cssText = `display:block; left:0; top:${sy}px; width:${Math.max(0, sx)}px; height:${sh}px;`;
    // Right
    dimEls[3].style.cssText = `display:block; left:${ex}px; top:${sy}px; width:${Math.max(0, ow - ex)}px; height:${sh}px;`;
  }

  // Position crop rect
  rectEl.style.display = 'block';
  rectEl.style.left = sx + 'px';
  rectEl.style.top = sy + 'px';
  rectEl.style.width = sw + 'px';
  rectEl.style.height = sh + 'px';

  // Position handles
  const hs = HANDLE_SIZE;
  const hh = hs / 2;
  const positions: Record<HandleId, { left: number; top: number }> = {
    nw: { left: sx - hh, top: sy - hh },
    n:  { left: sx + sw / 2 - hh, top: sy - hh },
    ne: { left: ex - hh, top: sy - hh },
    e:  { left: ex - hh, top: sy + sh / 2 - hh },
    se: { left: ex - hh, top: ey - hh },
    s:  { left: sx + sw / 2 - hh, top: ey - hh },
    sw: { left: sx - hh, top: ey - hh },
    w:  { left: sx - hh, top: sy + sh / 2 - hh }
  };

  for (const [id, el] of handleEls) {
    const pos = positions[id];
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.width = hs + 'px';
    el.style.height = hs + 'px';
  }

  // Position toolbar below the crop rect
  if (toolbarEl && toolbarEl.style.display !== 'none') {
    const tbLeft = sx + sw / 2;
    const tbTop = ey + 8;
    toolbarEl.style.left = tbLeft + 'px';
    toolbarEl.style.top = tbTop + 'px';
  }
}
