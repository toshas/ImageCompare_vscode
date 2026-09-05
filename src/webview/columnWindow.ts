/** Pure (no vscode, no DOM): which modality columns a carousel row must materialize, mirroring what the row pool does down the other axis (docs/loading-architecture.md: columns-virtualize-like-rows). */

/**
 * The smallest pitch a tile can occupy on EITHER axis: the tile-size floor plus the gap. Both pools
 * are sized from it (a row is this tall at its smallest, a column this wide), and the floor itself is
 * derived back out of it in main.ts, so this is the one number that sets how dense the grid may get.
 * Raising it trades columns-on-screen for tiles-on-screen, which is the cost that bounds a fill
 * (docs/loading-architecture.md: images-fill-progressively).
 */
export const MIN_TILE_PITCH = 26;

/** Columns kept bound beyond each edge of the horizontal viewport. */
export const COLUMN_OVERSCAN = 2;

export interface ColumnWindow {
  /** First and last display index to materialize, inclusive. `last < first` means nothing to bind. */
  first: number;
  last: number;
}

/**
 * Slots each row's column pool holds. Sized from the *narrowest* possible tile, not the current one:
 * a pool-size change remaps the whole ring (slot = displayIndex % pool) and rebinds every tile, so it
 * must not move as tiles resize — the same reason the row pool is sized from MIN_TILE_PITCH too.
 */
export function columnPoolSize(viewportWidth: number, columnCount: number): number {
  if (columnCount <= 0) return 0;
  const forNarrowest = Math.ceil(Math.max(0, viewportWidth) / MIN_TILE_PITCH) + 2 * COLUMN_OVERSCAN + 2;
  return Math.min(columnCount, forNarrowest);
}

/**
 * The display-index range visible at `scrollLeft`, widened by the overscan and clamped to the strip.
 * `pad` is where the first tile starts — the row's left padding.
 */
export function columnWindow(
  scrollLeft: number,
  viewportWidth: number,
  pitch: number,
  pad: number,
  columnCount: number
): ColumnWindow {
  if (columnCount <= 0 || pitch <= 0) return { first: 0, last: -1 };
  const from = Math.floor((scrollLeft - pad) / pitch) - COLUMN_OVERSCAN;
  const to = Math.floor((scrollLeft + Math.max(0, viewportWidth) - pad) / pitch) + COLUMN_OVERSCAN;
  return {
    first: Math.max(0, Math.min(from, columnCount - 1)),
    last: Math.max(0, Math.min(to, columnCount - 1)),
  };
}

/** Where column `index` starts inside the row. The one place the column axis's geometry is written. */
export function columnLeft(index: number, pitch: number, pad: number): number {
  return pad + index * pitch;
}
