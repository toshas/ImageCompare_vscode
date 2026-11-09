/** The touch layout's gestures on the image and the strip, plus its menu suppression; every gesture calls an action its key also calls (docs/pointer-input.md). */

/** What a gesture may do: only the actions the keys already take, never a load (docs/pointer-input.md: gestures-load-nothing). */
export interface TouchActions {
  stepModality(dir: 1 | -1): void;
  stepTuple(dir: 1 | -1): void;
  flipStart(): void;
  flipEnd(): void;
  /** Two fingers went down; `x`/`y` is their midpoint in client coordinates. */
  pinchStart(x: number, y: number): void;
  /** `scale` is relative to the distance at pinchStart; `x`/`y` is the current midpoint. */
  pinchMove(scale: number, x: number, y: number): void;
  /** Content offset deltas in px: positive scrolls toward later rows / columns. */
  scrollStrip(dx: number, dy: number): void;
}

const SWIPE_PX = 40;
const SLOP_PX = 10;
const HOLD_MS = 350;

type Gesture =
  | { kind: 'one'; x0: number; y0: number; timer: number; done: boolean }
  | { kind: 'hold' }
  | { kind: 'pinch'; d0: number }
  | { kind: 'spent' };

/** Installs the image's and the strip's finger gestures and the touch layout's no-menu rule. */
export function installTouchInput(viewerEl: HTMLElement, stripEl: HTMLElement, actions: TouchActions): void {
  const points = new Map<number, { x: number; y: number }>();
  let g: Gesture | null = null;

  const two = () => {
    const [a, b] = [...points.values()];
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  viewerEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if ((e.target as HTMLElement).closest('#carousel, #floating-panel')) return;
    // No compatibility mouse events: the mouse pan and crop handlers must never see a finger.
    e.preventDefault();
    try { viewerEl.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      const timer = window.setTimeout(() => {
        if (g?.kind === 'one' && !g.done) { g = { kind: 'hold' }; actions.flipStart(); }
      }, HOLD_MS);
      g = { kind: 'one', x0: e.clientX, y0: e.clientY, timer, done: false };
    } else if (points.size === 2) {
      if (g?.kind === 'one') clearTimeout(g.timer);
      if (g?.kind === 'hold') actions.flipEnd();
      const p = two();
      g = { kind: 'pinch', d0: p.d };
      actions.pinchStart(p.x, p.y);
    }
  });

  viewerEl.addEventListener('pointermove', (e) => {
    const pt = points.get(e.pointerId);
    if (!pt || !g) return;
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (g.kind === 'pinch') {
      if (points.size < 2) return;
      const p = two();
      actions.pinchMove(p.d / g.d0, p.x, p.y);
      return;
    }
    if (g.kind !== 'one' || g.done) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (Math.hypot(dx, dy) > SLOP_PX) clearTimeout(g.timer);
    // One step per swipe, taken as the finger crosses the threshold rather than on lift.
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    g.done = true;
    if (Math.abs(dx) > Math.abs(dy)) actions.stepModality(dx < 0 ? 1 : -1);
    else actions.stepTuple(dy < 0 ? 1 : -1);
  });

  const release = (e: PointerEvent) => {
    if (!points.delete(e.pointerId) || !g) return;
    if (g.kind === 'one') clearTimeout(g.timer);
    if (g.kind === 'hold') actions.flipEnd();
    // Lifting one finger of a pinch must not turn the other into a swipe.
    g = points.size === 0 ? null : { kind: 'spent' };
  };
  viewerEl.addEventListener('pointerup', release);
  viewerEl.addEventListener('pointercancel', release);

  // Android opens a menu on any long press, and here a long press flips or lifts a pill: no menu, anywhere (docs/pointer-input.md: touch-opens-no-menu).
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // The strip is a virtual wall with no native scroll on its row axis, so a finger drives the same offsets the wheel does.
  let drag: { x: number; y: number; moved: boolean } | null = null;
  stripEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
  });
  stripEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerType !== 'touch') return;
    const dx = drag.x - e.clientX, dy = drag.y - e.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < SLOP_PX) return;
    drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    actions.scrollStrip(dx, dy);
  });
  const endDrag = () => { if (drag && !drag.moved) drag = null; };
  stripEl.addEventListener('pointerup', endDrag);
  stripEl.addEventListener('pointercancel', () => { drag = null; });
  // A drag that scrolled the strip is not a tap on the tile it ended on.
  stripEl.addEventListener('click', (e) => {
    if (drag?.moved) { e.preventDefault(); e.stopPropagation(); }
    drag = null;
  }, true);
}
