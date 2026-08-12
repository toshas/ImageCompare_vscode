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
