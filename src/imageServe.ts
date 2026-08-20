// Pure full-image serving skeleton (no vscode): the passthrough-vs-convert branch, payload normalization and the single terminal reply live only here; both products inject IO (docs/standalone.md: adapter-contains-no-logic).
import { passthroughMime } from './imageMime';
import { normalizeImageBytes } from './wireFormat';
import { OriginalModalityIndex, asOriginal } from './types';

export interface ImageServeIo<TImage> {
  /** Read the image's original bytes plus its lowercase dot-extension. */
  loadRaw(image: TImage): Promise<{ bytes: Uint8Array; ext: string }>;
  /** Dimensions for a passthrough payload (provider: 0×0 so the webview sizes naturally; adapter: a browser decode). */
  probePassthrough(bytes: Uint8Array, ext: string): Promise<{ width: number; height: number }>;
  /** Convert non-passthrough bytes to a browser-renderable payload, or throw. */
  convert(bytes: Uint8Array, ext: string): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }>;
}

export type ImageServeReply =
  | { kind: 'image'; bytes: Uint8Array; mime: string; width: number; height: number }
  | { kind: 'error'; error: string };

/** Serve one image with a single terminal reply — image XOR imageError, computed first and posted exactly once (docs/loading-architecture.md: reply-exactly-once). */
export async function serveImage<TImage>(
  image: TImage | undefined,
  io: ImageServeIo<TImage>,
  post: (reply: ImageServeReply) => void
): Promise<void> {
  let reply: ImageServeReply;
  if (!image) {
    reply = { kind: 'error', error: 'Image not available' };
  } else {
    try {
      const raw = await io.loadRaw(image);
      // Browser-decodable formats pass through as original bytes (docs/image-backends.md: passthrough-no-backend).
      const mime = passthroughMime(raw.ext);
      if (mime) {
        const dims = await io.probePassthrough(raw.bytes, raw.ext);
        // Tight plain Uint8Array on every outbound payload (docs/loading-architecture.md: image-payload-normalized).
        reply = { kind: 'image', bytes: normalizeImageBytes(raw.bytes), mime, width: dims.width, height: dims.height };
      } else {
        const converted = await io.convert(raw.bytes, raw.ext);
        reply = { kind: 'image', bytes: normalizeImageBytes(converted.bytes), mime: converted.mime, width: converted.width, height: converted.height };
      }
    } catch (error) {
      reply = { kind: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
  post(reply);
}

/** Re-send every modality column of one tuple, in column order; the shared refresh loop after index-shifting mutations (docs/file-watching.md: mutation-never-strands-view). */
export function refreshTupleImages(
  tuple: object | undefined,
  modalities: readonly string[],
  sendOne: (modalityIndex: OriginalModalityIndex) => void
): void {
  if (!tuple) return;
  for (let m = 0; m < modalities.length; m++) sendOne(asOriginal(m));
}
