// Pure crop-flow orchestration (no vscode): the whole confirm-to-cropComplete sequence — one name, relative rect, per-modality render/inject/write, arrivals, then the terminal post — lives only here; both products inject IO (docs/standalone.md: adapter-contains-no-logic).
import { nextCropName, scaleAndClampRect, toRelativeRect } from './cropPlan';
import { CROP_RECT_KEYWORD, encodeCropMeta, pngInjectText } from './pngText';
import { ExtensionMessage, TupleIndex } from './types';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The `cropImages` request as the webview sends it; srcWidth/srcHeight are only a denominator (docs/crop-and-pptx.md: srcdims-are-denominator). */
export interface CropRequest {
  tupleIndex: TupleIndex;
  cropRect: CropRect;
  srcWidth: number;
  srcHeight: number;
}

/** Per-flow IO: rendering, disk and scheduling mechanics stay with each product; the flow owns the order. */
export interface CropFlowIo<TImage, TSaved extends { path: string }> {
  /** Filenames in the image's directory, for the shared crop numbering; a throw here reads as an empty listing. */
  listDirNames(image: TImage): Promise<string[]>;
  /** The file's true on-disk dimensions (provider: Sharp/Jimp metadata; adapter: a browser decode). */
  getDimensions(image: TImage): Promise<{ width: number; height: number }>;
  /** Extract `rect` and encode PNG bytes; the provider's Sharp path adds its EXIF copy of `cropMeta` here (docs/image-backends.md: metadata-written-twice). */
  renderCrop(image: TImage, rect: CropRect, cropMeta: string): Promise<Uint8Array>;
  /** Write the finished bytes as `outputName` beside the image, returning the product's saved-file record. */
  writeCrop(image: TImage, outputName: string, bytes: Uint8Array): Promise<TSaved>;
  /** Wrap one modality's work unit for scheduling (provider: the EXPORT pool; adapter: a serial chain); default is a direct call. */
  schedule?<R>(work: () => Promise<R>): Promise<R>;
  /** True for a scheduling-cancelled throw: it silences the whole batch instead of counting as a failure. */
  isCancelled?(err: unknown): boolean;
  /** True when the panel is gone; a silenced batch posts nothing. */
  isAborted?(): boolean;
  /** Land one written file (provider: the eager handleFileCreated self-write; adapter: the shared arrival planner) (docs/file-watching.md: self-writes-never-wait). */
  arriveFile(saved: TSaved): void | Promise<void>;
  post(message: ExtensionMessage): void;
  /** Adapter-only: push the new tuple's thumbnails after cropComplete; the provider's arrive path regenerates its own. */
  postCropThumbnails?(saved: TSaved[]): Promise<void>;
}

/** Crop every modality of a tuple: name once, rect relative, render+inject+write per modality, then arrivals, cropComplete, thumbnails — the one glue order for both products (docs/crop-and-pptx.md: post-crop-message-order). */
export async function performCrop<TImage extends { name: string }, TSaved extends { path: string }>(
  scan: { tuples: ReadonlyArray<{ name: string; images: readonly TImage[] }> },
  msg: CropRequest,
  io: CropFlowIo<TImage, TSaved>
): Promise<void> {
  const tuple = scan.tuples[msg.tupleIndex];
  if (!tuple || tuple.images.length === 0) return;

  const nameLists = await Promise.all(
    tuple.images.map(async image => {
      try {
        return await io.listDirNames(image);
      } catch {
        return [];
      }
    })
  );
  /* Resolved once, outside the per-modality loop, or one crop splits into N tuples (docs/crop-and-pptx.md: shared-crop-filename). */
  const outputName = nextCropName(nameLists, tuple.name); // naming decided by the shared pure module (docs/standalone.md: crop-plan-shared)

  // Relative (0-1) is the only form that may cross modalities (docs/crop-and-pptx.md: relative-coords-only).
  const relRect = toRelativeRect(msg.cropRect, msg.srcWidth, msg.srcHeight);

  let cancelled = 0;
  const schedule = io.schedule ?? (<R>(work: () => Promise<R>) => work());
  const results: Array<TSaved | undefined> = await Promise.all(
    tuple.images.map(async (image): Promise<TSaved | undefined> => {
      try {
        return await schedule(async () => {
          // True dimensions are re-read per modality; the webview's are only a denominator (docs/crop-and-pptx.md: srcdims-are-denominator).
          const dims = await io.getDimensions(image);
          // Round-then-clamp order lives in the shared pure module (docs/standalone.md: crop-plan-shared).
          const scaled = scaleAndClampRect(relRect, dims.width, dims.height);
          // NaN fails every comparison, so it would slip past a plain <= 0 test into the extract.
          if (!(scaled.w > 0) || !(scaled.h > 0)) return undefined; // scaled to nothing: skip, not an error
          const cropMeta = encodeCropMeta(scaled, dims.width, dims.height);
          const png = await io.renderCrop(image, scaled, cropMeta);
          // tEXt injected once here for both products — the cross-tool contract (docs/image-backends.md: metadata-written-twice) (docs/crop-and-pptx.md: croprect-six-integers).
          const withMeta = pngInjectText(Buffer.isBuffer(png) ? png : Buffer.from(png), CROP_RECT_KEYWORD, cropMeta);
          return io.writeCrop(image, outputName, withMeta);
        });
      } catch (err) {
        if (io.isCancelled?.(err)) {
          cancelled++;
          return undefined;
        }
        console.error(`[ImageCompare] Failed to crop ${image.name}:`, err instanceof Error ? err.message : err);
        return undefined;
      }
    })
  );
  const saved = results.filter((r): r is TSaved => r !== undefined);

  // A cancelled crop is a closed panel, not a failure to report.
  if (io.isAborted?.() || cancelled > 0) return;
  if (saved.length === 0) {
    io.post({ type: 'cropError', tupleIndex: msg.tupleIndex, error: 'Failed to crop any images' });
    return;
  }

  // Every arrival lands before the terminal post (docs/crop-and-pptx.md: post-crop-message-order).
  for (const s of saved) await io.arriveFile(s);
  io.post({ type: 'cropComplete', tupleIndex: msg.tupleIndex, count: saved.length, paths: saved.map(s => s.path) });
  await io.postCropThumbnails?.(saved);
}
