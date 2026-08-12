import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeSolidPng, makePpmx } from '../fixtures/synthetic';

/**
 * Create a temporary "mode 1" tree on disk: one parent dir with N modality
 * subdirs, each holding the same set of basenames so they match into tuples.
 * Returns the parent dir path; caller should rm it when done.
 */
export function makeModalityTree(
  modalities: string[],
  basenames: string[],
  opts: { ppmx?: boolean } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imagecompare-it-'));
  modalities.forEach((mod, mi) => {
    const dir = path.join(root, mod);
    fs.mkdirSync(dir, { recursive: true });
    basenames.forEach((base, bi) => {
      if (opts.ppmx && mi === modalities.length - 1) {
        fs.writeFileSync(
          path.join(dir, `${base}_${mod}.ppmx`),
          makePpmx(8, 6, (x, y) => (x + y + bi) / 14),
        );
      } else {
        fs.writeFileSync(
          path.join(dir, `${base}_${mod}.png`),
          makeSolidPng(16, 12, [30 + bi * 40, 80, 200 - mi * 40]),
        );
      }
    });
  });
  return root;
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
