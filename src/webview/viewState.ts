/** Pure (no vscode, no DOM): a published page's saved view, built from the current state and planned back by name (docs/standalone.md, "The view survives a reload"). */

/** What is saved: names only, never an index (docs/standalone.md: view-restored-by-name). */
export interface SavedView {
  /** Modality names in display order. */
  order: string[];
  hidden: string[];
  tuple: string | null;
  modality: string | null;
  zoom: number;
  panX: number;
  panY: number;
}

/** A restore against the comparison as it lists now: original modality indices and a tuple index. */
export interface ViewRestore {
  /** Original modality indices in display order. */
  order: number[];
  hidden: number[];
  tuple: number;
  /** The original index of the modality to show. */
  modality: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** The view as it stands: `displayNames[d]` is the modality at display position `d`. */
export function buildSavedView(displayNames: readonly string[], hiddenByDisplay: readonly boolean[], tuple: string | null, displayIndex: number, zoom: number, panX: number, panY: number): SavedView {
  return {
    order: displayNames.slice(),
    hidden: displayNames.filter((_, d) => hiddenByDisplay[d]),
    tuple,
    modality: displayNames[displayIndex] ?? null,
    zoom,
    panX,
    panY,
  };
}

/** Plans a restore of `saved` (any value; never throws) onto `modalityNames` in original order and `tupleNames`; whatever does not match stays at its default (docs/standalone.md: view-restored-by-name). */
export function planRestore(saved: unknown, modalityNames: readonly string[], tupleNames: readonly string[]): ViewRestore {
  const v: Record<string, unknown> = saved !== null && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const known = (list: unknown): number[] => {
    const names = Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
    return [...new Set(names.map(n => modalityNames.indexOf(n)).filter(i => i >= 0))];
  };
  const finite = (x: unknown, fallback: number): number => typeof x === 'number' && Number.isFinite(x) ? x : fallback;

  const order = known(v.order);
  // A modality the save never saw keeps its default relative place, after the saved ones.
  modalityNames.forEach((_, i) => { if (!order.includes(i)) order.push(i); });
  const hidden = known(v.hidden);
  const tuple = typeof v.tuple === 'string' ? tupleNames.indexOf(v.tuple) : -1;
  const modality = typeof v.modality === 'string' ? modalityNames.indexOf(v.modality) : -1;
  return {
    order,
    hidden,
    tuple: Math.max(0, tuple),
    modality: modality >= 0 ? modality : order.find(o => !hidden.includes(o)) ?? order[0] ?? 0,
    // The viewer's own zoom range.
    zoom: Math.max(0.1, Math.min(50, finite(v.zoom, 1))),
    panX: finite(v.panX, 0),
    panY: finite(v.panY, 0),
  };
}
