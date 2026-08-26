// Pure crop planning (no vscode): `_cropNN` naming and rect math live only here (docs/standalone.md: crop-plan-shared).

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
