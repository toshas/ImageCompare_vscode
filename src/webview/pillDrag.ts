import { dropSlot, slotShift } from './pillReorder';

/** Drag a pill along the modality row to reorder it: a mouse or pen drags at once, a finger after a hold (docs/pointer-input.md). */
export interface PillDragActions {
  /** A pill was lifted. */
  onStart(): void;
  /** The pill at display `from` now belongs at display `to` (never equal). */
  onDrop(from: number, to: number): void;
}

const MOUSE_START_PX = 5;
const HOLD_MS = 300;
const SLOP_PX = 8;
const EDGE_PX = 40;
const EDGE_SPEED = 0.4; // px of auto-scroll per frame for every px the pointer is into the edge band
const FLING_DECAY = 0.995; // per ms
const LIFT_SCALE = 1.08;
const LIFT = `scale(${LIFT_SCALE})`;

type Press = { id: number; pill: HTMLElement | null; x0: number; y0: number; touch: boolean; pen: boolean; timer: number; panning: boolean; lastX: number; lastT: number; v: number };
type Drag = {
  id: number; touch: boolean; pill: HTMLElement; pills: HTMLElement[]; from: number; to: number;
  mids: number[]; shift: number; minDx: number; maxDx: number;
  rowLeft: number; rowRight: number; startX: number; clientX: number; raf: number;
};

/** Installs the row's pointer gestures; the row is rebuilt only by `onDrop`, never here. */
export function installPillDrag(rowEl: HTMLElement, actions: PillDragActions): void {
  let press: Press | null = null;
  let drag: Drag | null = null;
  let swallowClick = false;
  let fling = 0;

  const stopFling = () => { if (fling) cancelAnimationFrame(fling); fling = 0; };
  const startFling = (v: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      rowEl.scrollLeft -= v * dt;
      v *= Math.pow(FLING_DECAY, dt);
      fling = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    if (Math.abs(v) > 0.1) fling = requestAnimationFrame(step);
  };

  const lifted = (d: Drag, raw: number) => `translateX(${Math.max(d.minDx, Math.min(d.maxDx, raw))}px) ${LIFT}`;

  const begin = (p: Press, pill: HTMLElement, clientX: number) => {
    const pills = Array.from(rowEl.querySelectorAll<HTMLElement>('.modality-btn'));
    const from = pills.indexOf(pill);
    if (from < 0 || pills.length < 2) { press = null; return; }
    const lefts = pills.map((el) => el.offsetLeft);
    const widths = pills.map((el) => el.offsetWidth);
    const gap = from + 1 < pills.length ? lefts[from + 1] - lefts[from] - widths[from] : lefts[from] - lefts[from - 1] - widths[from - 1];
    const rect = rowEl.getBoundingClientRect();
    const last = pills.length - 1;
    // The lift scales about the centre whatever origin a resting end pill has, so the clamp insets by the growth on each side.
    const grow = (LIFT_SCALE - 1) / 2 * widths[from];
    const lo = lefts[0] - lefts[from] + grow;
    const hi = lefts[last] + widths[last] - lefts[from] - widths[from] - grow;
    drag = {
      id: p.id, touch: p.touch, pill, pills, from, to: from,
      mids: lefts.map((l, j) => l + widths[j] / 2),
      shift: widths[from] + gap,
      minDx: Math.min(lo, (lo + hi) / 2),
      maxDx: Math.max(hi, (lo + hi) / 2),
      rowLeft: rect.left, rowRight: rect.right,
      startX: clientX - rect.left + rowEl.scrollLeft, clientX, raf: 0,
    };
    press = null;
    actions.onStart();
    rowEl.classList.add('pill-reordering');
    pill.classList.add('pill-dragging');
    pill.style.transformOrigin = 'center';
    pill.style.transform = lifted(drag, 0);
    try { rowEl.setPointerCapture(p.id); } catch { /* the pointer may already be gone */ }
    if (p.touch) navigator.vibrate?.(10);
  };

  // Transforms only, and only on pills that change side: nothing is rebuilt until the drop (docs/pointer-input.md: drag-commits-once).
  const update = () => {
    const d = drag;
    if (!d) return;
    const raw = d.clientX - d.rowLeft + rowEl.scrollLeft - d.startX;
    d.pill.style.transform = lifted(d, raw);
    // The slot follows the pointer, not the clamped drawing: a pill as wide as an end pill could never pass that pill's midpoint.
    const to = dropSlot(d.mids, d.from, d.mids[d.from] + raw);
    if (to !== d.to) {
      for (let j = Math.min(to, d.to); j <= Math.max(to, d.to); j++) {
        if (j === d.from) continue;
        const s = slotShift(j, d.from, to, d.shift);
        if (s !== slotShift(j, d.from, d.to, d.shift)) d.pills[j].style.transform = s ? `translateX(${s}px)` : '';
      }
      d.to = to;
    }
    const into = d.clientX < d.rowLeft + EDGE_PX ? d.clientX - d.rowLeft - EDGE_PX : d.clientX > d.rowRight - EDGE_PX ? d.clientX - d.rowRight + EDGE_PX : 0;
    if (into !== 0 && d.raf === 0) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        if (drag !== d) return;
        rowEl.scrollLeft += into * EDGE_SPEED;
        update();
      });
    }
  };

  // The one commit of a drag: transforms cleared, then a single onDrop (docs/pointer-input.md: drag-commits-once).
  const finish = (commit: boolean) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    // A cancelled touchstart sends no click, so only a mouse or pen release may have one to swallow (docs/pointer-input.md: drag-is-not-a-click).
    if (!d.touch) swallowClick = true;
    const drawnAt = d.pill.getBoundingClientRect().left;
    for (const el of d.pills) { el.style.transition = 'none'; el.style.transform = ''; }
    d.pill.style.transformOrigin = '';
    d.pill.classList.remove('pill-dragging');
    rowEl.classList.remove('pill-reordering');
    if (commit && d.to !== d.from) actions.onDrop(d.from, d.to);
    // The row may have been rebuilt; the pill now at the target glides there from where it was let go.
    const landed = rowEl.querySelectorAll<HTMLElement>('.modality-btn')[commit ? d.to : d.from];
    if (landed) {
      landed.style.transition = 'none';
      landed.style.transform = `translateX(${drawnAt - landed.getBoundingClientRect().left}px)`;
      void landed.offsetWidth;
    }
    for (const el of Array.from(rowEl.querySelectorAll<HTMLElement>('.modality-btn'))) { el.style.transition = ''; el.style.transform = ''; }
  };

  rowEl.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0) return;
    stopFling();
    const pill = (e.target as HTMLElement).closest?.('.modality-btn') as HTMLElement | null;
    const touch = e.pointerType === 'touch';
    if (!pill && !touch) return;
    const p: Press = { id: e.pointerId, pill, x0: e.clientX, y0: e.clientY, touch, pen: e.pointerType === 'pen', timer: 0, panning: false, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
    if (touch && pill) p.timer = window.setTimeout(() => { if (press === p) begin(p, pill, p.x0); }, HOLD_MS);
    press = p;
  });

  rowEl.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) { drag.clientX = e.clientX; update(); return; }
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (p.touch) {
      if (!p.panning && moved > SLOP_PX) { clearTimeout(p.timer); p.panning = true; }
      if (p.panning) {
        const dx = e.clientX - p.lastX;
        const dt = e.timeStamp - p.lastT;
        rowEl.scrollLeft -= dx;
        if (dt > 0) p.v = 0.7 * p.v + 0.3 * (dx / dt);
        p.lastX = e.clientX;
        p.lastT = e.timeStamp;
      }
    } else if (p.pill && moved > MOUSE_START_PX) {
      begin(p, p.pill, p.x0);
      if (drag) { drag.clientX = e.clientX; update(); }
    }
  });

  // A drag or a pan ends here; only an untouched tap clicks, and for a finger or a pen the row clicks it itself (docs/pointer-input.md: drag-is-not-a-click, row-owns-touch).
  const release = (e: PointerEvent, commit: boolean) => {
    const p = press;
    if (p && e.pointerId === p.id) {
      clearTimeout(p.timer);
      press = null;
      if (p.panning) {
        // A finger that stopped before lifting throws nothing.
        if (commit && e.timeStamp - p.lastT < 80) startFling(p.v);
      } else if ((p.touch || p.pen) && commit && p.pill) {
        p.pill.click();
        // A pen's engine may click too, or may not (a stylus that also fires the cancelled touchstart); the row's click is the one.
        if (p.pen) swallowClick = true;
      }
    }
    if (drag && e.pointerId === drag.id) finish(commit);
  };
  rowEl.addEventListener('pointerup', (e) => release(e, true));
  rowEl.addEventListener('pointercancel', (e) => release(e, false));
  // A pill's own capture loss (a touch's implicit capture handed to the row) bubbles here too and is not a release (docs/pointer-input.md: only-row-capture-ends-drag).
  rowEl.addEventListener('lostpointercapture', (e) => { if (e.target === rowEl) release(e, true); });
  // Chrome's long press and pan grow from an uncancelled touchstart; every gesture on the row is ours (docs/pointer-input.md: row-owns-touch).
  rowEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // The swallow eats only the click of the release that armed it: a new press disarms it, and a click no pointer made (detail 0) passes (docs/pointer-input.md: drag-is-not-a-click).
  window.addEventListener('pointerdown', () => { swallowClick = false; }, true);
  window.addEventListener('click', (e) => {
    if (swallowClick && e.detail > 0) { e.preventDefault(); e.stopPropagation(); swallowClick = false; }
  }, true);
}
