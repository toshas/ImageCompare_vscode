import * as vscode from 'vscode';

// Image file extensions we support
export const IMAGE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.ppmx'
];

// Check if a filename is an image
export function isImageFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.includes(ext);
}

// Branded modality index spaces — compile-time only, erased at runtime (docs/tuple-matching.md trap 2).
export type OriginalModalityIndex = number & { readonly __brand: 'OriginalModalityIndex' };
export type DisplayModalityIndex = number & { readonly __brand: 'DisplayModalityIndex' };
// Tuple index is a single space (no display/original split); the brand guards it against modality indices.
export type TupleIndex = number & { readonly __brand: 'TupleIndex' };
// Mint a brand at a real boundary (a scan position, or a wire value known to be original/display/a tuple).
export const asOriginal = (n: number): OriginalModalityIndex => n as OriginalModalityIndex;
export const asDisplay = (n: number): DisplayModalityIndex => n as DisplayModalityIndex;
export const asTuple = (n: number): TupleIndex => n as TupleIndex;
// The only sanctioned conversions: modalityOrder is the one bridge (order[display] = original).
export function toOriginal(display: DisplayModalityIndex, order: readonly OriginalModalityIndex[]): OriginalModalityIndex {
  return order[display];
}
export function toDisplay(original: OriginalModalityIndex, order: readonly OriginalModalityIndex[]): DisplayModalityIndex {
  return asDisplay(order.indexOf(original));
}

// Represents a single image file
export interface ImageFile {
  uri: vscode.Uri;
  name: string;
  modality: string;
}

// Represents a tuple of images (one per modality)
export interface ImageTuple {
  name: string;
  images: ImageFile[];
}

/** Debug-only numbers only the scan can report; the open rollup prints them (docs/loading-architecture.md: open-spans-account-for-the-whole-open). */
export interface ScanStats {
  /** Image files collected across the modality dirs — what the matcher was handed. */
  files: number;
  /** Wall ms spent inside the matcher, the nested part of the scan span. */
  matchMs: number;
}

// Scan result from file service
export interface ScanResult {
  modalities: string[];
  tuples: ImageTuple[];
  /** Selection shape. Ask this, never `isMultiTupleMode`, for mode (docs/session-files.md: mode-is-explicit). */
  mode: 1 | 2 | 3;
  /** What the scan actually used: the base dir (1), the modality dirs (2), or the files (3). Never the raw input — paths that fail to stat are dropped. */
  roots: vscode.Uri[];
  /** Purely "more than one row" — drives carousel layout, never a mode decision. */
  isMultiTupleMode: boolean;
  /** Absent unless `imageCompare.debug` was on for this scan (docs/loading-architecture.md: debug-off-costs-nothing). */
  stats?: ScanStats;
}

// Image info sent to webview
export interface ImageInfo {
  name: string;
  modality: string;
  tupleIndex: TupleIndex;
  modalityIndex: OriginalModalityIndex;
}

// Tuple info sent to webview
export interface TupleInfo {
  name: string;
  images: ImageInfo[];
}

// Messages from WebView to Extension
export type WebViewMessage =
  | { type: 'ready' }
  | { type: 'requestThumbnails'; tupleIndices: TupleIndex[] }
  // sibling: off-screen modality. tail: sibling past the nearest two (docs/loading-architecture.md: sibling-tail-never-competes). forceReload: bypass cached bytes so a failed decode can retry.
  | { type: 'requestImage'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; sibling?: boolean; tail?: boolean; forceReload?: boolean }
  | { type: 'setCurrentTuple'; tupleIndex: TupleIndex }
  // The strip as displayed, the moment the user picks a column: the sweep's aim, ahead of any load (docs/loading-architecture.md: picked-column-reports-itself).
  | { type: 'setCurrentModality'; modalityOrder: OriginalModalityIndex[]; currentDisplayIndex: DisplayModalityIndex; hiddenModalities: OriginalModalityIndex[]; visibleRows?: number }
  // Carries the modality strip as displayed: prefetch speculates on the column on screen, not the whole tuple (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column). visibleRows is the carousel's screenful — the sweep's cross radius (docs/loading-architecture.md: sweep-cross-then-row-major).
  | { type: 'tupleFullyLoaded'; tupleIndex: TupleIndex; modalityOrder: OriginalModalityIndex[]; currentDisplayIndex: DisplayModalityIndex; hiddenModalities: OriginalModalityIndex[]; visibleRows?: number }
  | { type: 'setWinner'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex | null } // null = clear winner
  | { type: 'cropImages'; tupleIndex: TupleIndex; cropRect: { x: number; y: number; w: number; h: number }; srcWidth: number; srcHeight: number }
  | { type: 'deleteTuple'; tupleIndex: TupleIndex }
  | { type: 'exportPptx'; tupleIndices: TupleIndex[]; winnerModalityIndices: (OriginalModalityIndex | null)[]; modalityOrder: OriginalModalityIndex[] }
  | { type: 'saveSessionAs' } // Ctrl/Cmd+S in the webview; the title-bar button routes through the command instead
  | { type: 'log'; message: string };

// Messages from Extension to WebView
export type ExtensionMessage =
  | { type: 'init'; tuples: TupleInfo[]; modalities: string[]; modalityPaths: string[]; modalityColors: string[]; config: WebViewConfig; winners: Record<number, OriginalModalityIndex>; votingEnabled: boolean; labelsExplicit: boolean; version: string }
  | { type: 'thumbnail'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; bytes: Uint8Array; mime: string } // binary like `image`, and blob-URL'd in the webview (docs/loading-architecture.md: image-payload-normalized)
  | { type: 'thumbnailError'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; error: string }
  | { type: 'image'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; bytes: Uint8Array; mime: string; width: number; height: number } // binary, not base64: string payloads cost ×1.33 and GC pauses
  | { type: 'imageError'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; error: string }
  | { type: 'thumbnailProgress'; current: number; total: number }
  | { type: 'copyImage' } // context-menu Copy Image: the webview owns the only image-capable clipboard
  | { type: 'toggleModalityHidden'; modalityIndex: OriginalModalityIndex } // context-menu Hide/Show Modality; state lives in the webview
  | { type: 'fileDeleted'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex }
  | { type: 'fileRestored'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex; imageInfo?: ImageInfo }
  | { type: 'tupleDeleted'; tupleIndex: TupleIndex }
  | { type: 'tupleAdded'; tuple: TupleInfo; tupleIndex: TupleIndex }
  | { type: 'modalityAdded'; modality: string; modalityPath: string; modalityColors: string[]; modalityIndex: OriginalModalityIndex }
  | { type: 'modalityRemoved'; modalityIndex: OriginalModalityIndex }
  // The comparison's own directory: its path once the host has established the folder is gone, null the moment it lists again (docs/file-watching.md: root-loss-reported-as-an-edge)
  | { type: 'rootMissing'; path: string | null }
  | { type: 'winnerUpdated'; tupleIndex: TupleIndex; modalityIndex: OriginalModalityIndex | null }
  | { type: 'winnersReset'; winners: Record<number, OriginalModalityIndex> } // For when results.txt is regenerated
  | { type: 'cropComplete'; tupleIndex: TupleIndex; count: number; paths: string[] }
  | { type: 'cropError'; tupleIndex: TupleIndex; error: string }
  | { type: 'pptxComplete'; path: string }
  | { type: 'pptxError'; error: string };

// Configuration passed to webview
export interface WebViewConfig {
  thumbnailSize: number;
  prefetchCount: number;
  keepZoomOnTupleChange: boolean;
}

// Loaded image data (cached in extension)
/** Extension-side full-image cache entry: raw encoded bytes, not base64 — see docs/loading-architecture.md. */
export interface LoadedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

// Modality colors (same as original)
export const MODALITY_COLORS = [
  '#0f0',    // green
  '#f60',    // orange
  '#0af',    // cyan
  '#f0f',    // magenta
  '#ff0',    // yellow
  '#f44',    // red
  '#4f4',    // light green
  '#44f',    // blue
];
