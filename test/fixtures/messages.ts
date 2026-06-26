/**
 * Canned extension->webview message sequences for the Playwright testbed.
 *
 * These mirror the real ExtensionMessage protocol (see src/types.ts) so the
 * harness drives the actual webview bundle exactly as the extension host would.
 * All image payloads are synthetic solid-color PNGs (deterministic bytes).
 */
import { makeSolidPng } from './synthetic';

export interface FixtureSpec {
  tupleNames: string[];
  modalities: string[];
  width: number;
  height: number;
  votingEnabled: boolean;
}

export const DEFAULT_SPEC: FixtureSpec = {
  tupleNames: ['scene_000', 'scene_001', 'scene_002'],
  modalities: ['GT', 'PRED'],
  width: 320,
  height: 200,
  votingEnabled: true,
};

/** Distinct, stable color per (tuple, modality) so screenshots differ predictably. */
export function colorFor(tupleIndex: number, modalityIndex: number): [number, number, number] {
  const r = modalityIndex === 0 ? 210 : 40;
  const b = modalityIndex === 0 ? 40 : 210;
  const g = 30 + tupleIndex * 60; // varies per tuple
  return [r, Math.min(g, 255), b];
}

function pngDataUrl(width: number, height: number, rgb: [number, number, number]): string {
  return 'data:image/png;base64,' + makeSolidPng(width, height, rgb).toString('base64');
}

export function initMessage(spec: FixtureSpec = DEFAULT_SPEC) {
  const tuples = spec.tupleNames.map((name, tupleIndex) => ({
    name,
    images: spec.modalities.map((modality, modalityIndex) => ({
      name: `${name}_${modality}.png`,
      modality,
      tupleIndex,
      modalityIndex,
    })),
  }));

  return {
    type: 'init' as const,
    tuples,
    modalities: spec.modalities,
    modalityPaths: spec.modalities.map((m) => `/fixtures/${m}`),
    config: { thumbnailSize: 100, prefetchCount: 3 },
    winners: {} as Record<number, number>,
    votingEnabled: spec.votingEnabled,
    ppmxColormap: 'grayscale' as const,
  };
}

/** Full-resolution image messages for every tuple/modality. */
export function imageMessages(spec: FixtureSpec = DEFAULT_SPEC) {
  const msgs: Array<Record<string, unknown>> = [];
  spec.tupleNames.forEach((_n, tupleIndex) => {
    spec.modalities.forEach((_m, modalityIndex) => {
      msgs.push({
        type: 'image',
        tupleIndex,
        modalityIndex,
        dataUrl: pngDataUrl(spec.width, spec.height, colorFor(tupleIndex, modalityIndex)),
        width: spec.width,
        height: spec.height,
      });
    });
  });
  return msgs;
}

/** Thumbnail messages (smaller solid pngs) for the carousel. */
export function thumbnailMessages(spec: FixtureSpec = DEFAULT_SPEC) {
  const msgs: Array<Record<string, unknown>> = [];
  spec.tupleNames.forEach((_n, tupleIndex) => {
    spec.modalities.forEach((_m, modalityIndex) => {
      msgs.push({
        type: 'thumbnail',
        tupleIndex,
        modalityIndex,
        dataUrl: pngDataUrl(64, 40, colorFor(tupleIndex, modalityIndex)),
      });
    });
  });
  return msgs;
}
