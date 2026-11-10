/** Pure (no vscode, no DOM): where a scroller sits so the selection is centred, and how much a wheel notch moves (docs/loading-architecture.md: selection-centres-on-navigation). */

/** Notches a wheel notch is worth while Alt is held. One number for every axis, so "faster" means the same everywhere. */
export const ALT_SPEED = 5;

/** Per-notch zoom step, as a fraction: a notch scales by 1 ± this. */
export const ZOOM_STEP = 0.03;

/** Offset that centres [start, start+size) in viewport, clamped to the content; snapTo > 0 snaps to a uniform item pitch (docs/loading-architecture.md: selection-centres-on-navigation). */
export function centreOffset(start: number, size: number, viewport: number, content: number, snapTo = 0): number {
  const centred = start - (viewport - size) / 2;
  const snapped = snapTo > 0 ? Math.round(centred / snapTo) * snapTo : centred;
  return Math.max(0, Math.min(snapped, Math.max(0, content - viewport)));
}

/**
 * A wheel delta in pixels. `deltaMode` says what the number counts — pixels, lines or pages — and a
 * handler that ignores it scrolls a LINE-mode wheel by about 3px per notch instead of three rows.
 * The caller supplies what a line and a page mean on its own axis.
 */
export function wheelPixels(delta: number, deltaMode: number, lineSize: number, pageSize: number): number {
  if (deltaMode === 1) return delta * lineSize;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
}

/** How far a linear scroller moves for one wheel notch. Alt multiplies, because distance adds. */
export function scrollStep(delta: number, alt: boolean): number {
  return delta * (alt ? ALT_SPEED : 1);
}

/** Zoom scale for one wheel notch; Alt compounds the step ALT_SPEED times (docs/loading-architecture.md: selection-centres-on-navigation). */
export function zoomFactor(deltaY: number, alt: boolean): number {
  const step = deltaY > 0 ? 1 - ZOOM_STEP : 1 + ZOOM_STEP;
  return alt ? Math.pow(step, ALT_SPEED) : step;
}
