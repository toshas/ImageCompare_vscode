/**
 * Node-side pipeline turning the real photographs in test/fixtures/images/
 * into fake CV modalities for the demo recordings. Tuples are the photos;
 * modalities are deterministic Sharp color transforms of each photo (no
 * Date/random, so CI recordings are reproducible). Results are memoized so
 * the 16 encodes happen once per run, not once per test.
 */
import * as path from 'path';
import sharp from 'sharp';

export const PHOTO_TUPLES = ['airplane', 'baboon', 'peppers', 'sailboat'];
export const PHOTO_MODALITIES = ['original', 'desaturated', 'hue+120', 'thermal'];

const IMAGES_DIR = path.resolve(__dirname, '..', 'fixtures', 'images');

export interface PhotoFixture {
  tupleIndex: number;
  modalityIndex: number;
  /** Full-size JPEG data URL for `image` messages. */
  dataUrl: string;
  /** ~96px JPEG data URL for `thumbnail` messages. */
  thumbUrl: string;
  width: number;
  height: number;
}

function variant(src: Buffer, modality: string): sharp.Sharp {
  const img = sharp(src);
  switch (modality) {
    case 'desaturated':
      return img.modulate({ saturation: 0.15 });
    case 'hue+120':
      return img.modulate({ hue: 120 });
    case 'thermal':
      return img.modulate({ hue: 240, saturation: 1.6 });
    default:
      return img;
  }
}

function toDataUrl(jpeg: Buffer): string {
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

async function build(): Promise<PhotoFixture[]> {
  const out: PhotoFixture[] = [];
  for (let tupleIndex = 0; tupleIndex < PHOTO_TUPLES.length; tupleIndex++) {
    const src = path.join(IMAGES_DIR, `${PHOTO_TUPLES[tupleIndex]}.jpg`);
    const meta = await sharp(src).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const raw = await sharp(src).toBuffer();
    for (let modalityIndex = 0; modalityIndex < PHOTO_MODALITIES.length; modalityIndex++) {
      const modality = PHOTO_MODALITIES[modalityIndex];
      const full = await variant(raw, modality).jpeg({ quality: 82 }).toBuffer();
      const thumb = await variant(raw, modality)
        .resize({ width: 96 })
        .jpeg({ quality: 75 })
        .toBuffer();
      out.push({
        tupleIndex,
        modalityIndex,
        dataUrl: toDataUrl(full),
        thumbUrl: toDataUrl(thumb),
        width,
        height,
      });
    }
  }
  return out;
}

let cache: Promise<PhotoFixture[]> | undefined;

/** Memoized: encoding runs once per process, later callers reuse the result. */
export function photoFixtures(): Promise<PhotoFixture[]> {
  return (cache ??= build());
}

export interface CropFixture {
  modalityIndex: number;
  /** Full-size PNG data URL (the extension writes crops as PNG). */
  dataUrl: string;
  /** ~96px JPEG data URL for the carousel thumbnail. */
  thumbUrl: string;
  width: number;
  height: number;
}

/**
 * Crop a tuple's modality variants the way handleCropImages does: the webview's
 * pixel-space rect is made relative via srcWidth/srcHeight, then re-scaled to
 * each modality's true on-disk dimensions and clamped
 * (docs/crop-and-pptx.md: relative-coords-only / srcdims-are-denominator).
 */
export async function cropFixtures(
  tupleIndex: number,
  cropRect: { x: number; y: number; w: number; h: number },
  srcWidth: number,
  srcHeight: number,
): Promise<CropFixture[]> {
  const src = path.join(IMAGES_DIR, `${PHOTO_TUPLES[tupleIndex]}.jpg`);
  const raw = await sharp(src).toBuffer();
  const rel = {
    x: cropRect.x / srcWidth,
    y: cropRect.y / srcHeight,
    w: cropRect.w / srcWidth,
    h: cropRect.h / srcHeight,
  };
  const out: CropFixture[] = [];
  for (let modalityIndex = 0; modalityIndex < PHOTO_MODALITIES.length; modalityIndex++) {
    const modality = PHOTO_MODALITIES[modalityIndex];
    const meta = await variant(raw, modality).metadata();
    const mw = meta.width ?? 0;
    const mh = meta.height ?? 0;
    const x = Math.max(0, Math.round(rel.x * mw));
    const y = Math.max(0, Math.round(rel.y * mh));
    const w = Math.min(Math.round(rel.w * mw), mw - x);
    const h = Math.min(Math.round(rel.h * mh), mh - y);
    if (!(w > 0) || !(h > 0)) continue;
    const region = { left: x, top: y, width: w, height: h };
    const full = await variant(raw, modality).extract(region).png().toBuffer();
    const thumb = await variant(raw, modality)
      .extract(region)
      .resize({ width: 96 })
      .jpeg({ quality: 75 })
      .toBuffer();
    out.push({
      modalityIndex,
      dataUrl: 'data:image/png;base64,' + full.toString('base64'),
      thumbUrl: toDataUrl(thumb),
      width: w,
      height: h,
    });
  }
  return out;
}
