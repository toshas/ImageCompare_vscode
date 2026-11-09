import { ThumbnailBytes } from '../../src/thumbnailPlan';

// Shared fixtures for the pure sweep suites. Not a suite itself: no `.test.ts` suffix.

/** A dense grid of `tuples` rows x `mods` columns; every slot populated unless `holes` says otherwise. */
export function grid(tuples: number, mods: number, holes: ReadonlySet<string> = new Set()) {
  const modalities = Array.from({ length: mods }, (_, m) => `m${m}`);
  const rows = Array.from({ length: tuples }, (_, t) => ({
    images: modalities.filter(m => !holes.has(`${t}-${m}`)).map(m => ({ modality: m, name: `${t}_${m}.png` })),
  }));
  return { rows, modalities };
}

export const flush = () => new Promise<void>(r => setTimeout(r, 0));
export const jpeg = (length: number): ThumbnailBytes => ({ bytes: new Uint8Array(length), mime: 'image/jpeg' });

/** 32-bit LCG; same seed, same run, on every machine and every day. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Rejects rather than hanging the runner if the sweep never resolves. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sweep did not settle in ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
