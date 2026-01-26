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

// Scan result from file service
export interface ScanResult {
  modalities: string[];
  tuples: ImageTuple[];
  isMultiTupleMode: boolean;
}

// Image info sent to webview
export interface ImageInfo {
  name: string;
  modality: string;
  tupleIndex: number;
  modalityIndex: number;
}

// Tuple info sent to webview
export interface TupleInfo {
  name: string;
  images: ImageInfo[];
}

// Messages from WebView to Extension
export type WebViewMessage =
  | { type: 'ready' }
  | { type: 'requestThumbnails'; tupleIndices: number[] }
  | { type: 'requestImage'; tupleIndex: number; modalityIndex: number }
  | { type: 'navigateTo'; tupleIndex: number }
  | { type: 'setCurrentTuple'; tupleIndex: number }
  | { type: 'tupleFullyLoaded'; tupleIndex: number }
  | { type: 'log'; message: string };

// Messages from Extension to WebView
export type ExtensionMessage =
  | { type: 'init'; tuples: TupleInfo[]; modalities: string[]; config: WebViewConfig }
  | { type: 'thumbnail'; tupleIndex: number; modalityIndex: number; dataUrl: string }
  | { type: 'thumbnailError'; tupleIndex: number; modalityIndex: number; error: string }
  | { type: 'image'; tupleIndex: number; modalityIndex: number; dataUrl: string; width: number; height: number }
  | { type: 'imageError'; tupleIndex: number; modalityIndex: number; error: string }
  | { type: 'thumbnailProgress'; current: number; total: number }
  | { type: 'fileDeleted'; tupleIndex: number; modalityIndex: number }
  | { type: 'fileRestored'; tupleIndex: number; modalityIndex: number }
  | { type: 'tupleDeleted'; tupleIndex: number }
  | { type: 'tupleAdded'; tuple: TupleInfo; tupleIndex: number }
  | { type: 'modalityAdded'; modality: string; modalityIndex: number }
  | { type: 'modalityRemoved'; modalityIndex: number };

// Configuration passed to webview
export interface WebViewConfig {
  thumbnailSize: number;
  prefetchCount: number;
}

// Loaded image data (cached in extension)
export interface LoadedImage {
  dataUrl: string;
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
