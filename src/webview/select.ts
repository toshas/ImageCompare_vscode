/**
 * Marquee multi-selection for the carousel (Explorer-style rubber-band select).
 *
 * Drag a semi-transparent rectangle over the tiles to select multiple images;
 * selected tiles get a highlight mask. This is INDEPENDENT of the current
 * tuple/modality and the winner — selecting never changes what's displayed.
 * The only action on a selection is "copy the files" (Cmd/Ctrl+C).
 */

// ---------------------------------------------------------------------------
// Pure geometry (unit-tested)
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TileRect extends Rect {
  key: string;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Keys of tiles whose rect intersects the marquee rect. */
export function tilesInMarquee(marquee: Rect, tiles: TileRect[]): string[] {
  return tiles.filter((t) => rectsIntersect(marquee, t)).map((t) => t.key);
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

export interface SelectionItem {
  tupleIndex: number;
  modalityIndex: number;
}

const selected = new Set<string>();

export function tileKey(tupleIndex: number, modalityIndex: number): string {
  return `${tupleIndex}-${modalityIndex}`;
}
export function parseKey(k: string): SelectionItem {
  const [t, m] = k.split('-').map(Number);
  return { tupleIndex: t, modalityIndex: m };
}
export function getSelectedKeys(): string[] {
  return [...selected];
}
export function getSelected(): SelectionItem[] {
  return [...selected].map(parseKey);
}
export function selectionCount(): number {
  return selected.size;
}
export function hasSelection(): boolean {
  return selected.size > 0;
}
export function clearSelection(): void {
  selected.clear();
}

// ---------------------------------------------------------------------------
// Drag interaction + visuals
// ---------------------------------------------------------------------------

const DRAG_THRESHOLD = 5; // px before a press becomes a marquee drag
const EDGE_ZONE = 30; // px from the carousel top/bottom that triggers auto-scroll
const EDGE_SCROLL_STEP = 14; // px per tick while auto-scrolling
let dragging = false;
let pendingStart: { x: number; y: number } | null = null; // marquee start, in carousel CONTENT coords
let lastClient: { x: number; y: number } | null = null; // last pointer position, in client coords
let suppressClick = false;
let marqueeEl: HTMLDivElement | null = null;
let onChangeCb: (() => void) | null = null;
let autoScrollTimer: ReturnType<typeof setInterval> | null = null;

/** Pointer position in carousel content coordinates (scroll-independent anchor). */
function contentPoint(carouselEl: HTMLElement, clientX: number, clientY: number) {
  const r = carouselEl.getBoundingClientRect();
  return { x: clientX - r.left + carouselEl.scrollLeft, y: clientY - r.top + carouselEl.scrollTop };
}

/** Tiles in carousel content coordinates (offsetLeft/Top don't change on scroll). */
function collectTiles(carouselEl: HTMLElement): { el: HTMLElement; rect: TileRect }[] {
  const out: { el: HTMLElement; rect: TileRect }[] = [];
  carouselEl.querySelectorAll<HTMLElement>('.carousel-thumb-container').forEach((el) => {
    const t = el.dataset.tuple;
    const m = el.dataset.modality;
    if (t === undefined || m === undefined) return;
    if (el.dataset.empty === '1') return; // no image here — not selectable / nothing to copy
    out.push({
      el,
      rect: {
        key: tileKey(Number(t), Number(m)),
        left: el.offsetLeft,
        top: el.offsetTop,
        right: el.offsetLeft + el.offsetWidth,
        bottom: el.offsetTop + el.offsetHeight,
      },
    });
  });
  return out;
}

/** Re-apply the .ic-selected mask to tiles in the current selection. */
export function applySelectionClasses(carouselEl: HTMLElement): void {
  carouselEl.querySelectorAll<HTMLElement>('.carousel-thumb-container').forEach((el) => {
    const k = tileKey(Number(el.dataset.tuple), Number(el.dataset.modality));
    el.classList.toggle('ic-selected', selected.has(k));
  });
}

/** Recompute the marquee + selection from the start anchor and last pointer. */
function updateMarquee(carouselEl: HTMLElement): void {
  if (!pendingStart || !lastClient) return;
  const cur = contentPoint(carouselEl, lastClient.x, lastClient.y);
  const marquee: Rect = {
    left: Math.min(pendingStart.x, cur.x),
    top: Math.min(pendingStart.y, cur.y),
    right: Math.max(pendingStart.x, cur.x),
    bottom: Math.max(pendingStart.y, cur.y),
  };
  if (marqueeEl) {
    marqueeEl.style.left = marquee.left + 'px';
    marqueeEl.style.top = marquee.top + 'px';
    marqueeEl.style.width = marquee.right - marquee.left + 'px';
    marqueeEl.style.height = marquee.bottom - marquee.top + 'px';
  }
  const tiles = collectTiles(carouselEl);
  const hitKeys = new Set(tilesInMarquee(marquee, tiles.map((t) => t.rect)));
  selected.clear();
  hitKeys.forEach((k) => selected.add(k));
  for (const { el, rect } of tiles) el.classList.toggle('ic-selected', hitKeys.has(rect.key));
  onChangeCb?.();
}

function stopAutoScroll(): void {
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

/** Start/stop edge auto-scroll based on how close the pointer is to the carousel edges. */
function updateAutoScroll(carouselEl: HTMLElement): void {
  if (!lastClient) return stopAutoScroll();
  const r = carouselEl.getBoundingClientRect();
  let dir = 0;
  if (lastClient.y < r.top + EDGE_ZONE) dir = -1;
  else if (lastClient.y > r.bottom - EDGE_ZONE) dir = 1;
  if (dir === 0) return stopAutoScroll();
  if (autoScrollTimer) return; // already scrolling
  autoScrollTimer = setInterval(() => {
    const before = carouselEl.scrollTop;
    carouselEl.scrollTop = before + dir * EDGE_SCROLL_STEP;
    if (carouselEl.scrollTop === before) {
      stopAutoScroll(); // hit the top/bottom — nothing more to scroll
      return;
    }
    updateMarquee(carouselEl); // scrolling extends the marquee in content space
  }, 30);
}

/** Attach marquee drag handlers to the carousel. onChange fires when the selection changes. */
export function initSelection(carouselEl: HTMLElement, onChange: () => void): void {
  onChangeCb = onChange;

  carouselEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Don't start a marquee from the winner circle (it has its own click).
    if ((e.target as HTMLElement).classList.contains('winner-circle')) return;
    lastClient = { x: e.clientX, y: e.clientY };
    pendingStart = contentPoint(carouselEl, e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', (e) => {
    if (!pendingStart) return;
    lastClient = { x: e.clientX, y: e.clientY };
    if (!dragging) {
      const start = pendingStart;
      const cRect = carouselEl.getBoundingClientRect();
      const moved = Math.hypot(
        e.clientX - (cRect.left + start.x - carouselEl.scrollLeft),
        e.clientY - (cRect.top + start.y - carouselEl.scrollTop),
      );
      if (moved < DRAG_THRESHOLD) return;
      dragging = true;
      selected.clear();
      if (!marqueeEl) {
        marqueeEl = document.createElement('div');
        marqueeEl.id = 'carousel-marquee';
        carouselEl.appendChild(marqueeEl);
      }
      marqueeEl.style.display = 'block';
    }
    updateMarquee(carouselEl);
    updateAutoScroll(carouselEl);
  });

  document.addEventListener('mouseup', () => {
    stopAutoScroll();
    if (dragging) {
      dragging = false;
      suppressClick = true; // swallow the click that follows a drag (no navigation)
      if (marqueeEl) marqueeEl.style.display = 'none';
      onChangeCb?.();
    }
    pendingStart = null;
    lastClient = null;
  });

  // A plain click on empty carousel space clears the selection; a click after a
  // drag is swallowed so it doesn't navigate.
  carouselEl.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      const onTile = (e.target as HTMLElement).closest('.carousel-thumb-container');
      if (!onTile && selected.size > 0) {
        clearSelection();
        applySelectionClasses(carouselEl);
        onChangeCb?.();
      }
    },
    true, // capture, so we can suppress before tile/row handlers run
  );
}
