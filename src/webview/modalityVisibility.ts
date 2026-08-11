/** Pure (no vscode, no DOM): webview interaction rules with no DOM dependence — see docs/session-files.md. */

// Non-wrapping like the arrow keys it serves: scan outward, return current when nothing visible remains (docs/session-files.md: hidden-is-presentation-only).
export function nextVisibleModality(current: number, delta: 1 | -1, hidden: readonly boolean[]): number {
  for (let i = current + delta; i >= 0 && i < hidden.length; i += delta) {
    if (!hidden[i]) return i;
  }
  return current;
}

/** Must match .winner-circle's CSS width in the panel markup. */
export const WINNER_CIRCLE_PX = 7;

// Below 3x the vote circle, a tile click is a coin-flip between navigate and vote — so voting by mouse is disabled outright (docs/session-files.md: tiny-tiles-never-vote).
export function isVoteClickable(tileSize: number): boolean {
  return tileSize >= 3 * WINNER_CIRCLE_PX;
}

/**
 * Preserve the user's pill arrangement when original index w is inserted: existing entries shift,
 * and w lands right after its original-order predecessor (before its successor when w is first)
 * (docs/tuple-matching.md: rearrangement-survives-insert).
 */
export function displayOrderAfterInsert(order: readonly number[], w: number): { order: number[]; displayPos: number } {
  const shifted = order.map(o => (o >= w ? o + 1 : o));
  const anchor = w > 0 ? shifted.indexOf(w - 1) + 1 : Math.max(0, shifted.indexOf(w + 1));
  shifted.splice(anchor, 0, w);
  return { order: shifted, displayPos: anchor };
}
