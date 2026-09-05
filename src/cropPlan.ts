// Pure crop planning (no vscode): `_cropNN` naming and rect math live only here (docs/standalone.md: crop-plan-shared).

/** The `_cropNN` suffix on a crop output's stem: every reader of the format tests through this one regex (docs/crop-and-pptx.md: cropnn-writer-reader-match). */
export const CROP_SUFFIX_RE = /_crop\d+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Next `_cropNN.png` output filename for a tuple, from the directory listing of every modality dir. */
export function nextCropName(existingNamesPerModality: string[][], tupleName: string): string {
  const cropPattern = new RegExp(`^${escapeRegExp(tupleName)}_crop(\\d+)\\.`);
  /* Max across every modality dir: a cancelled crop leaves them out of step, and the lower number would overwrite (docs/crop-and-pptx.md: shared-crop-filename). */
  const cropNums = existingNamesPerModality.map(names => {
    let maxNum = 0;
    for (const name of names) {
      const match = name.match(cropPattern);
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    }
    return maxNum + 1;
  });
  const cropNum = Math.max(...cropNums);
  // Zero-padded `_cropNN`: every `_crop\d+` reader depends on this format (docs/crop-and-pptx.md: cropnn-writer-reader-match).
  const cropSuffix = `_crop${String(cropNum).padStart(2, '0')}`;
  return `${tupleName}${cropSuffix}.png`;
}

/** A filename without its extension; the crop of `shot_a.png` is named after `shot_a` (docs/crop-and-pptx.md: shared-crop-filename). */
function stemOf(filename: string): string {
  return filename.replace(/\.[^./]+$/, '');
}

/**
 * One output name per column, each named after the image it is cut from rather than after the
 * tuple: the shape this exists for is a file list whose columns share a directory, where one
 * tuple-wide name is one path written N times (docs/crop-and-pptx.md: shared-crop-filename).
 * A name is claimed across every listing as it is handed out, so two images that reduce to the same
 * stem (`a.png` beside `a.jpg`) number past each other instead of onto each other.
 */
export function cropNamesPerImage(existingNamesPerModality: string[][], imageNames: readonly string[]): string[] {
  const listings = existingNamesPerModality.map(names => [...names]);
  return imageNames.map((imageName, i) => {
    const name = nextCropName([listings[i] ?? []], stemOf(imageName));
    for (const listing of listings) listing.push(name);
    return name;
  });
}

/** Pixel rect → relative (0-1) against the drawn-on image's dimensions — the only form that may cross modalities (docs/crop-and-pptx.md: relative-coords-only). */
export function toRelativeRect(
  rect: { x: number; y: number; w: number; h: number },
  srcWidth: number,
  srcHeight: number
): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x / srcWidth,
    y: rect.y / srcHeight,
    w: rect.w / srcWidth,
    h: rect.h / srcHeight
  };
}

/** Scale a relative (0-1) rect into width×height pixel space: Math.round first, then clamp — the order is load-bearing. */
export function scaleAndClampRect(
  relRect: { x: number; y: number; w: number; h: number },
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const scaledRect = {
    x: Math.max(0, Math.round(relRect.x * width)),
    y: Math.max(0, Math.round(relRect.y * height)),
    w: Math.round(relRect.w * width),
    h: Math.round(relRect.h * height)
  };
  scaledRect.w = Math.min(scaledRect.w, width - scaledRect.x);
  scaledRect.h = Math.min(scaledRect.h, height - scaledRect.y);
  return scaledRect;
}
