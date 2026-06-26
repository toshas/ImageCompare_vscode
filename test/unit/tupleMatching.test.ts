import { describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import { matchTuplesWithTrie } from '../../src/fileService';

type ModFiles = Map<string, Array<{ name: string; uri: Uri }>>;

function makeFiles(dir: string, names: string[]): Array<{ name: string; uri: Uri }> {
  return names.map((name) => ({ name, uri: Uri.file(`/${dir}/${name}`) }));
}

function build(spec: Record<string, string[]>): { files: ModFiles; modalities: string[] } {
  const files: ModFiles = new Map();
  for (const [mod, names] of Object.entries(spec)) files.set(mod, makeFiles(mod, names));
  return { files, modalities: Object.keys(spec) };
}

describe('matchTuplesWithTrie (real fileService code)', () => {
  it('matches identical basenames across modalities (exact pass)', () => {
    const { files, modalities } = build({
      GT: ['00000079_gt.png', '00000080_gt.png'],
      RGB: ['00000079_rgb.png', '00000080_rgb.png'],
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);
    expect(tuples.length).toBe(2);
    for (const t of tuples) expect(t.files.size).toBe(2);
  });

  // KNOWN BUG surfaced by this testbed (see TESTING.md "Findings"):
  // When originals and crops coexist with DIFFERENT suffixes per modality,
  // the orig+crop query files collide on the same reference slot and the crop
  // overwrites the original — so `00000079_gt.png` ends up paired with
  // `00000079_rgb_crop01.png`, and the GT crop is left with no RGB match.
  // The "crops never steal originals" rule only deprioritizes crops on the
  // REFERENCE side, not the query side. `it.fails` keeps the suite green and
  // will flip to failing (alerting us) once the matcher is fixed.
  it.fails('CORRECT behavior: orig pairs with orig, crop pairs with crop', () => {
    const { files, modalities } = build({
      GT: ['00000079_gt.png', '00000079_gt_crop01.png'],
      RGB: ['00000079_rgb.png', '00000079_rgb_crop01.png'],
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);

    const origTuple = tuples.find((t) => t.files.get('GT')?.name === '00000079_gt.png');
    const cropTuple = tuples.find((t) => t.files.get('GT')?.name === '00000079_gt_crop01.png');
    expect(origTuple?.files.get('RGB')?.name).toBe('00000079_rgb.png');
    expect(cropTuple?.files.get('RGB')?.name).toBe('00000079_rgb_crop01.png');
  });

  it('a _pred file matches the _gt original, not its _crop01 sibling', () => {
    const { files, modalities } = build({
      GT: ['img_00001_gt.png', 'img_00001_gt_crop01.png'],
      PRED: ['img_00001_pred.png'],
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);
    const predTuple = tuples.find((t) => t.files.get('PRED')?.name === 'img_00001_pred.png');
    expect(predTuple).toBeDefined();
    expect(predTuple!.files.get('GT')?.name).toBe('img_00001_gt.png');
  });

  it('creates partial tuples when a modality is missing a file', () => {
    const { files, modalities } = build({
      GT: ['a_gt.png', 'b_gt.png'],
      RGB: ['a_rgb.png'], // missing b
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);
    const bTuple = tuples.find((t) => t.files.get('GT')?.name === 'b_gt.png');
    expect(bTuple).toBeDefined();
    expect(bTuple!.files.has('RGB')).toBe(false);
  });
});
