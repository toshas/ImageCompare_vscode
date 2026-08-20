// Pure PPTX deck construction (no vscode): slide selection, pairing, layout and the export flow live only here (docs/standalone.md: deck-layout-shared).
import type PptxGenJS from 'pptxgenjs';
import type { CropMeta } from './pngText';
import type { ExtensionMessage, OriginalModalityIndex, TupleIndex } from './types';

/** Slide-image encoding bounds every backend must apply — cap, never enlarge (docs/crop-and-pptx.md: deck-images-bounded). */
export const DECK_IMAGE_MAX_DIM = 2560;
/** JPEG quality (0-100) for recompressed slide images (docs/crop-and-pptx.md: deck-images-bounded). */
export const DECK_JPEG_QUALITY = 85;

/** A slide-ready image: base64 data URL plus the source's true pixel dimensions. */
export interface DeckImage {
  data: string;
  width: number;
  height: number;
}

/** IO the caller injects: the deck builder decides everything else (docs/standalone.md: deck-layout-shared). */
export interface DeckIo {
  loadImage(tupleIndex: number, modalityOriginalIndex: number): Promise<DeckImage | null>;
  readCropMeta(tupleIndex: number, modality: string): Promise<CropMeta | null>;
}

/** Build the export deck onto `pptx` (any PptxGenJS-shaped instance); the caller writes and notifies. */
export async function buildDeck(
  pptx: PptxGenJS,
  tuples: ReadonlyArray<{ name: string }>,
  modalities: readonly string[],
  tupleIndices: readonly TupleIndex[],
  winnerModalityIndices: ReadonlyArray<OriginalModalityIndex | null>,
  modalityOrder: readonly OriginalModalityIndex[],
  io: DeckIo
): Promise<void> {
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = 'ImageCompare Export';

  const slideWidth = 10; // inches (default for 16:9)
  const slideHeight = 5.625; // inches (default for 16:9)

  const barH = 0.35; // inches — height of the caption bar

  const addCaption = (slide: PptxGenJS.Slide, tupleName: string, modality: string, isWinner: boolean) => {
    slide.addShape('rect', {
      x: 0, y: 0, w: slideWidth, h: barH,
      fill: { color: 'D0D0D0', transparency: 50 },
    });

    slide.addText(tupleName, {
      x: 0.1, y: 0, w: slideWidth / 2, h: barH,
      fontSize: 10,
      fontFace: 'Arial',
      bold: true,
      color: '000000',
      valign: 'middle',
      align: 'left',
    });

    const modLabel = isWinner ? `✓ ${modality}` : modality;
    slide.addText(modLabel, {
      x: slideWidth / 2, y: 0, w: slideWidth / 2 - 0.1, h: barH,
      fontSize: 10,
      fontFace: 'Arial',
      bold: true,
      color: isWinner ? '008800' : '000000',
      valign: 'middle',
      align: 'right',
    });
  };

  // `_crop\d+` here must keep matching the writer's format (docs/crop-and-pptx.md: cropnn-writer-reader-match).
  const findCropTuples = (baseTupleName: string): number[] => {
    const cropPattern = new RegExp(`^${baseTupleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_crop\\d+$`);
    const cropIndices: number[] = [];
    for (let i = 0; i < tuples.length; i++) {
      if (cropPattern.test(tuples[i].name)) {
        cropIndices.push(i);
      }
    }
    return cropIndices;
  };

  const findParentTuple = (cropName: string): number => {
    const match = cropName.match(/^(.+)_crop\d+$/);
    if (!match) return -1;
    return tuples.findIndex(t => t.name === match[1]);
  };

  // Ordering and constants are tuned, not derived (docs/crop-and-pptx.md).
  const computeCropLayout = (cropAspect: number, fullAspect: number) => {
    const gap = 0.15;
    const defaultThumbW = 2;
    const minThumbW = 1.2;

    let mainW: number, mainH: number;
    if (cropAspect > slideWidth / slideHeight) {
      mainW = slideWidth; mainH = slideWidth / cropAspect;
    } else {
      mainH = slideHeight; mainW = slideHeight * cropAspect;
    }
    let mainX = (slideWidth - mainW) / 2;
    let mainY = (slideHeight - mainH) / 2;
    const origArea = mainW * mainH;

    let thumbW = defaultThumbW;
    let thumbH = thumbW / fullAspect;
    let thumbX = slideWidth - thumbW;
    let thumbY = slideHeight - thumbH;

    if (mainX + mainW > thumbX - gap && mainY + mainH > thumbY - gap) {
      const tryFit = (tw: number) => {
        const th = tw / fullAspect;
        const tx = slideWidth - tw;
        const avail = tx - gap;
        let w: number, h: number;
        if (cropAspect > avail / slideHeight) {
          w = avail; h = avail / cropAspect;
        } else {
          h = slideHeight; w = slideHeight * cropAspect;
        }
        return {
          mainW: w, mainH: h, mainX: (avail - w) / 2, mainY: slideHeight - h,
          thumbW: tw, thumbH: th, thumbX: tx, thumbY: slideHeight - th
        };
      };

      let fit = tryFit(defaultThumbW);
      if (fit.mainW * fit.mainH < origArea * 0.7) {
        fit = tryFit(minThumbW);
      }
      if (fit.mainW * fit.mainH >= origArea * 0.5) {
        return fit;
      }
    }

    return { mainW, mainH, mainX, mainY, thumbW, thumbH, thumbX, thumbY };
  };

  // Crop image, plus a full-image callout thumbnail with the region marked in red.
  const addCropSlide = async (
    cropTupleIdx: number,
    fullTupleIdx: number,
    originalModIdx: number,
    tupleName: string,
    isWinner: boolean
  ) => {
    const modality = modalities[originalModIdx];
    const cropImgData = await io.loadImage(cropTupleIdx, originalModIdx);
    if (!cropImgData) return;

    const fullImgData = await io.loadImage(fullTupleIdx, originalModIdx);
    if (!fullImgData) return;

    const cropAspect = cropImgData.width / cropImgData.height;
    const fullAspect = fullImgData.width / fullImgData.height;
    const layout = computeCropLayout(cropAspect, fullAspect);

    const slide = pptx.addSlide();
    slide.addImage({ data: cropImgData.data, x: layout.mainX, y: layout.mainY, w: layout.mainW, h: layout.mainH });
    slide.addImage({ data: fullImgData.data, x: layout.thumbX, y: layout.thumbY, w: layout.thumbW, h: layout.thumbH });

    // The red rect comes from metadata, never re-derived (docs/crop-and-pptx.md: callout-from-metadata).
    const cropMeta = await io.readCropMeta(cropTupleIdx, modality);
    // A zero srcW/srcH would put Infinity into the slide XML, which corrupts the whole deck.
    if (cropMeta && cropMeta.srcW > 0 && cropMeta.srcH > 0) {
      const scaleX = layout.thumbW / cropMeta.srcW;
      const scaleY = layout.thumbH / cropMeta.srcH;
      slide.addShape('rect', {
        x: layout.thumbX + cropMeta.x * scaleX,
        y: layout.thumbY + cropMeta.y * scaleY,
        w: cropMeta.w * scaleX,
        h: cropMeta.h * scaleY,
        line: { color: 'FF0000', width: 2 },
        fill: { type: 'none' }
      });
    }

    addCaption(slide, tupleName, modality, isWinner);
  };

  // Parent/crop pairing: a voted crop never ships without its parent (docs/crop-and-pptx.md: one-slide-per-region).
  for (let idx = 0; idx < tupleIndices.length; idx++) {
    const tupleIndex = tupleIndices[idx];
    const winnerIdx = winnerModalityIndices[idx];
    const tuple = tuples[tupleIndex];
    if (!tuple) continue;

    // A voted crop is rendered against its parent even if the parent was never voted.
    const parentIdx = findParentTuple(tuple.name);
    if (parentIdx >= 0) {
      for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
        const originalModIdx = modalityOrder[displayIdx];
        const modality = modalities[originalModIdx];
        if (!modality) continue;
        await addCropSlide(tupleIndex, parentIdx, originalModIdx, tuple.name, winnerIdx === originalModIdx);
      }
      continue;
    }

    const cropTupleIndices = findCropTuples(tuple.name);
    const hasCrops = cropTupleIndices.length > 0;
    // A voted crop child already gets its own slide, so the parent falls back to a plain one.
    const hasVotedCrops = hasCrops && cropTupleIndices.some(ci => tupleIndices.some(t => t === ci));

    for (let displayIdx = 0; displayIdx < modalityOrder.length; displayIdx++) {
      const originalModIdx = modalityOrder[displayIdx];
      const modality = modalities[originalModIdx];
      if (!modality) continue;
      const isWinner = winnerIdx === originalModIdx;

      if (!hasCrops || hasVotedCrops) {
        const imgData = await io.loadImage(tupleIndex, originalModIdx);
        if (!imgData) continue;

        const slide = pptx.addSlide();
        const imgAspect = imgData.width / imgData.height;
        const slideAspect = slideWidth / slideHeight;
        let imgW: number, imgH: number, imgX: number, imgY: number;
        if (imgAspect > slideAspect) {
          imgW = slideWidth;
          imgH = slideWidth / imgAspect;
          imgX = 0;
          imgY = (slideHeight - imgH) / 2;
        } else {
          imgH = slideHeight;
          imgW = slideHeight * imgAspect;
          imgX = (slideWidth - imgW) / 2;
          imgY = 0;
        }
        slide.addImage({ data: imgData.data, x: imgX, y: imgY, w: imgW, h: imgH });
        addCaption(slide, tuple.name, modality, isWinner);
      } else if (cropTupleIndices.length === 1) {
        // Only parent voted, exactly one crop — present as if the crop was voted.
        await addCropSlide(cropTupleIndices[0], tupleIndex, originalModIdx, tuples[cropTupleIndices[0]].name, isWinner);
      } else {
        // Several crops, none voted: resolve the ambiguity by breadth, one slide each.
        for (const cropTupleIdx of cropTupleIndices) {
          await addCropSlide(cropTupleIdx, tupleIndex, originalModIdx, tuples[cropTupleIdx].name, isWinner);
        }
      }
    }
  }
}

/** The `exportPptx` request as the webview sends it. */
export interface ExportDeckRequest {
  tupleIndices: TupleIndex[];
  winnerModalityIndices: (OriginalModalityIndex | null)[];
  modalityOrder: OriginalModalityIndex[];
}

/** Per-flow IO: pptxgenjs sourcing, name listing and output mechanics stay with each product; the flow owns the order. */
export interface ExportDeckIo {
  /** The pptxgenjs constructor (provider: the bundled import; adapter: the lazy CDN load). */
  getPptx(): Promise<new () => PptxGenJS>;
  /** Filenames in the output directory for the shared comparison_NN numbering; a missing directory is a throw, an unreadable one an empty list. */
  listExistingNames(): Promise<string[]>;
  /** Slide-image loading and crop metadata for the deck builder. */
  deckIo: DeckIo;
  /** Persist the built deck under `name`, returning the path to report (provider: nodebuffer + workspace write; adapter: browser download). */
  saveDeck(pptx: PptxGenJS, name: string): Promise<string>;
  post(message: ExtensionMessage): void;
  /** True for a disposal-cancelled throw: the whole export silences instead of answering (no answer owed to a gone panel). */
  isCancelled?(err: unknown): boolean;
  /** Product notification after the answer is posted; a throw here can no longer forge a second answer. */
  onSaved?(path: string): void | Promise<void>;
  /** Product notification alongside the pptxError answer. */
  onError?(message: string): void;
}

/** The whole export flow — name, build, save, then exactly one pptxComplete XOR pptxError — for both products (docs/crop-and-pptx.md: export-always-answers). */
export async function exportDeck(
  tuples: ReadonlyArray<{ name: string }>,
  modalities: readonly string[],
  msg: ExportDeckRequest,
  io: ExportDeckIo
): Promise<void> {
  let savedPath: string;
  try {
    const name = nextPptxName(await io.listExistingNames());
    const Pptx = await io.getPptx();
    const pptx = new Pptx();
    await buildDeck(pptx, tuples, modalities, msg.tupleIndices, msg.winnerModalityIndices, msg.modalityOrder, io.deckIo);
    savedPath = await io.saveDeck(pptx, name);
  } catch (err) {
    // A cancelled export is a closed panel, not a failure to report (docs/crop-and-pptx.md: export-always-answers).
    if (io.isCancelled?.(err)) return;
    const errorMsg = err instanceof Error ? err.message : String(err);
    io.post({ type: 'pptxError', error: errorMsg });
    io.onError?.(errorMsg);
    return;
  }
  io.post({ type: 'pptxComplete', path: savedPath });
  try {
    await io.onSaved?.(savedPath);
  } catch {
    // A notification failure is not an export failure, and the answer is already out.
  }
}

/** Export filename: comparison_NN.pptx, NN = max existing + 1 — the one naming rule for both products (docs/standalone.md: adapter-contains-no-logic). */
export function nextPptxName(existingNames: readonly string[]): string {
  let pptxNum = 1;
  const pptxPattern = /^comparison_(\d+)\.pptx$/;
  for (const name of existingNames) {
    const match = name.match(pptxPattern);
    if (match) pptxNum = Math.max(pptxNum, parseInt(match[1], 10) + 1);
  }
  return `comparison_${String(pptxNum).padStart(2, '0')}.pptx`;
}
