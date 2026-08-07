/** Pure (no vscode, no DOM): keyboard-cycling target selection around hidden modality pills — see docs/session-files.md. */

// Non-wrapping like the arrow keys it serves: scan outward, return current when nothing visible remains (docs/session-files.md: hidden-is-presentation-only).
export function nextVisibleModality(current: number, delta: 1 | -1, hidden: readonly boolean[]): number {
  for (let i = current + delta; i >= 0 && i < hidden.length; i += delta) {
    if (!hidden[i]) return i;
  }
  return current;
}
