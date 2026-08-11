import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { Uri } from '../mocks/vscode';
import { matchTuplesWithTrie, scanForImages } from '../../src/fileService';
import { disambiguateDirectoryNames, uniquify } from '../../src/modalityNames';

type ModFiles = Map<string, Array<{ name: string; uri: Uri }>>;

function makeFiles(dir: string, names: string[]): Array<{ name: string; uri: Uri }> {
  return names.map((name) => ({ name, uri: Uri.file(`/${dir}/${name}`) }));
}

function build(spec: Record<string, string[]>): { files: ModFiles; modalities: string[] } {
  const files: ModFiles = new Map();
  for (const [mod, names] of Object.entries(spec)) files.set(mod, makeFiles(mod, names));
  return { files, modalities: Object.keys(spec) };
}

// ── Full-pipeline fixtures: real directories on disk, scanned by the REAL
// scanForImages (mode 2) so tuple naming, uniquify and the final name-sort in
// scanDirectoriesAsModalities are the shipped code, not a copy. ──
const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

async function scanDirs(spec: Record<string, string[]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-tuples-'));
  tmpRoots.push(root);
  const uris = Object.entries(spec).map(([mod, names]) => {
    const dir = path.join(root, mod);
    fs.mkdirSync(dir);
    for (const n of names) fs.writeFileSync(path.join(dir, n), '');
    return Uri.file(dir);
  });
  return scanForImages(uris as never);
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

  // Rule 1 is the only rule that can decide: lenDiff is 2 to either ref (47 and 43
  // vs query 45), so rule 2 is inert, and rule 3 would actively pick _crop01
  // (LCS 42 vs 41).
  it('_pred matches _gt, not _crop01, when lenDiff ties (crop rule decides alone)', () => {
    const { files, modalities } = build({
      GT: [
        'dataset_a_scene_01_1024x768_rgb_00000079_crop01.png', // long: 47 chars (no ext)
        'dataset_a_scene_01_1024x768_rgb_00000079_gt.png', // short: 43 chars (no ext)
      ],
      pred: [
        'dataset_a_scene_01_1024x768_rgb_00000079_crop01.png', // exact match to crop01
        'dataset_a_scene_01_1024x768_rgb_00000079_pred.png', // must match _gt, not _crop01
      ],
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);
    expect(tuples.length).toBe(2);

    const cropTuple = tuples.find((t) => t.key.includes('crop01'));
    expect(cropTuple).toBeDefined();
    expect(cropTuple!.files.size).toBe(2);
    for (const f of cropTuple!.files.values()) expect(f.name).toContain('crop01');

    const gtTuple = tuples.find((t) => t.key.endsWith('_gt'));
    expect(gtTuple).toBeDefined();
    expect(gtTuple!.files.get('pred')?.name).toBe('dataset_a_scene_01_1024x768_rgb_00000079_pred.png');
  });

  // Pins crop deprioritization: a long query suffix makes _crop01 the closer ref
  // by length alone (lenDiff 6 vs 10), so only rule 1 keeps it off the crop.
  it('a long modality name still matches _gt, not the closer-length _crop01', () => {
    const { files, modalities } = build({
      GT: ['image001_crop01.png', 'image001_gt.png'],
      longmodality: [
        'image001_crop01.png', // exact match to crop01
        'image001_longmodality.png', // must match _gt, not _crop01
      ],
    });
    const tuples = matchTuplesWithTrie(files as never, modalities);
    expect(tuples.length).toBe(2);

    const gtTuple = tuples.find((t) => t.key === 'image001_gt');
    expect(gtTuple).toBeDefined();
    expect(gtTuple!.files.get('longmodality')?.name).toBe('image001_longmodality.png');
  });

  // Rule 2 is the only rule that can decide. Rule 1 is inert (neither ref is a
  // crop). Rule 3 cannot run (it needs a lenDiff tie) and could not decide anyway:
  // LCS is 10 to both refs. So inverting `lenDiff < bestLenDiff` must flip the match.
  it('the closer-length non-crop ref wins (length tie-break decides alone)', () => {
    const { files, modalities } = build({
      // Both refs break from the query at the same char, so the trie hands back both.
      ref: [
        'img_00001_alpha.png', // base len 15 -> lenDiff 4
        'img_00001_a.png', // base len 11 -> lenDiff 0  <- must win
      ],
      query: ['img_00001_q.png'], // base len 11; shares LCP "img_00001_" with both refs
    });
    const matched = matchTuplesWithTrie(files as never, modalities);
    const withQuery = matched.filter((t) => t.files.has('query'));
    expect(withQuery.length).toBe(1);
    expect(withQuery[0].key).toBe('img_00001_a');
  });

  // LCS "decides only among candidates already tied on crop-ness *and* length" —
  // that state is reachable, and this is it. Rule 1 is inert (neither ref is a
  // crop); rule 2 is inert (both refs are 13 chars, as is the query, so lenDiff is
  // 0 for both). Only LCS separates them: 12 to _zab vs 11 to _zba. The winner is
  // at index 1, so the greedy comparator can only reach it through the LCS clause.
  it('higher LCS wins among refs tied on crop-ness and length (LCS decides alone)', () => {
    const { files, modalities } = build({
      ref: [
        'img_00001_zba.png', // LCS 11 with the query
        'img_00001_zab.png', // LCS 12 with the query  <- must win
      ],
      query: ['img_00001_qab.png'], // diverges from both refs at the same char -> both are candidates
    });
    const matched = matchTuplesWithTrie(files as never, modalities);
    const withQuery = matched.filter((t) => t.files.has('query'));
    expect(withQuery.length).toBe(1);
    expect(withQuery[0].key).toBe('img_00001_zab');
  });

  // Insertion order (2, 10, 1) is neither the sorted nor the reverse-sorted order,
  // so asserting by index catches an inverted sort, a removed sort, and a
  // lexicographic (non-natural) sort (docs/tuple-matching.md: rows-keyed-by-reference).
  it('matcher keys sort naturally, asserted by index', () => {
    const { files, modalities } = build({
      GT: ['img_2_gt.png', 'img_10_gt.png', 'img_1_gt.png'],
      pred: ['img_2_pred.png', 'img_10_pred.png', 'img_1_pred.png'],
    });
    const matched = matchTuplesWithTrie(files as never, modalities);
    expect(matched.length).toBe(3);
    expect(matched.map((t) => t.key)).toEqual(['img_1_gt', 'img_2_gt', 'img_10_gt']);
  });
});

describe('scanForImages mode 2 pipeline (real scanDirectoriesAsModalities)', () => {
  it('groups originals + crop01 files across 5 modalities', async () => {
    const files = [
      'dataset_a_1024x768_rgb_00000079_crop01.png',
      'dataset_a_1024x768_rgb_00000079_%SUF%.png',
      'dataset_b_1024x768_rgb_00000005_%SUF%.png',
      'dataset_b_1024x768_rgb_00000042_%SUF%.png',
      'dataset_c_1024x768_rgb_00000409_%SUF%.png',
    ];
    const withSuffix = (suf: string) => files.map((f) => f.replace('%SUF%', suf));
    const result = await scanDirs({
      GT: withSuffix('gt'),
      pred_a: withSuffix('pred'),
      pred_b_new: withSuffix('pred'),
      pred_c: withSuffix('pred'),
      RGB: withSuffix('rgb'),
    });

    // 5 tuples of 5 modalities: 00000079 original, its crop01, and 00000005/42/409.
    expect(result.tuples.length).toBe(5);

    const cropTuple = result.tuples.find((t) => t.name.includes('crop01'));
    expect(cropTuple).toBeDefined();
    expect(cropTuple!.images.length).toBe(5);
    // All images in the crop tuple share the same filename.
    expect(new Set(cropTuple!.images.map((i) => i.name)).size).toBe(1);

    const origTuple = result.tuples.find(
      (t) => t.name.includes('00000079') && !t.name.includes('crop')
    );
    expect(origTuple).toBeDefined();
    expect(origTuple!.images.length).toBe(5);
    for (const img of origTuple!.images) expect(img.name).not.toContain('crop');

    for (const suffix of ['00000005', '00000042', '00000409']) {
      const t = result.tuples.find((t) => t.name.includes(suffix));
      expect(t).toBeDefined();
      expect(t!.images.length).toBe(5);
    }
  });

  it('separates originals, crop01 and nested crop01_crop01 into three tuples', async () => {
    const withSuffix = (suf: string) => [
      'dataset_a_1024x768_rgb_00000079_crop01_crop01.png',
      'dataset_a_1024x768_rgb_00000079_crop01.png',
      `dataset_a_1024x768_rgb_00000079_${suf}.png`,
    ];
    const result = await scanDirs({
      GT: withSuffix('gt'),
      pred_a: withSuffix('pred'),
      RGB: withSuffix('rgb'),
    });
    expect(result.tuples.length).toBe(3);

    const origTuple = result.tuples.find((t) => !t.name.includes('crop'));
    expect(origTuple).toBeDefined();
    expect(origTuple!.images.length).toBe(3);
    for (const img of origTuple!.images) expect(img.name).not.toContain('crop');

    const crop1Tuple = result.tuples.find(
      (t) => t.name.includes('crop01') && !t.name.includes('crop01_crop01')
    );
    expect(crop1Tuple).toBeDefined();
    expect(crop1Tuple!.images.length).toBe(3);

    const crop2Tuple = result.tuples.find((t) => t.name.includes('crop01_crop01'));
    expect(crop2Tuple).toBeDefined();
    expect(crop2Tuple!.images.length).toBe(3);
  });

  it('baseline: no crop files, dense tuples', async () => {
    const result = await scanDirs({
      GT: ['img_001_gt.png', 'img_002_gt.png'],
      pred: ['img_001_pred.png', 'img_002_pred.png'],
      RGB: ['img_001_rgb.png', 'img_002_rgb.png'],
    });
    expect(result.tuples.length).toBe(2);
    for (const t of result.tuples) expect(t.images.length).toBe(3);
  });

  it('orders rows naturally by tuple NAME', async () => {
    const result = await scanDirs({
      GT: ['img_2_gt.png', 'img_10_gt.png', 'img_1_gt.png'],
      pred: ['img_2_pred.png', 'img_10_pred.png', 'img_1_pred.png'],
    });
    expect(result.tuples.map((t) => t.name)).toEqual(['img_1', 'img_2', 'img_10']);
  });

  // Key order and NAME order differ here: by key, img_1_crop01_gt < img_1_gt
  // (c < g); by name, img_1 < img_1_crop01. The shipped final sort is by name, so
  // the parent row precedes its crop — a fixture where the orders coincide would
  // leave the name-sort deletable without a failure.
  it('parent row precedes its crop despite reversed key order (final sort is by NAME)', async () => {
    const result = await scanDirs({
      GT: ['img_1_crop01_gt.png', 'img_1_gt.png'],
      pred: ['img_1_crop01_pred.png', 'img_1_pred.png'],
    });
    expect(result.tuples.map((t) => t.name)).toEqual(['img_1', 'img_1_crop01']);
  });

  // Both reference files reduce to the same emergent name. `ImageTuple.name` is
  // the durable results.txt key, so without a suffix one vote would land on both rows.
  it('colliding tuple names get a " (N)" suffix', async () => {
    const result = await scanDirs({
      GT: ['img.png', 'img.tiff'],
      pred: ['img.png', 'img.tiff'],
    });
    const names = result.tuples.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => / \(\d+\)$/.test(n))).toBe(true);
  });
});

describe('disambiguateDirectoryNames / uniquify (real modalityNames code)', () => {
  it('extends to the shortest unique tail', () => {
    const a = disambiguateDirectoryNames([{ path: '/runs/exp1/out' }, { path: '/runs/exp2/out' }]);
    expect(a.map((x) => x.name)).toEqual(['exp1/out', 'exp2/out']);
  });

  it('keeps names already unique at depth 1', () => {
    const b = disambiguateDirectoryNames([{ path: '/a/gt' }, { path: '/b/pred' }]);
    expect(b.map((x) => x.name)).toEqual(['gt', 'pred']);
  });

  // The fallback: equal tails with one path shorter, so the loop exhausts
  // maxDepth. Without a suffix these collide, and a duplicate name silently
  // merges two modalities.
  it('suffixes tails the depth loop cannot separate, keeping each uri paired', () => {
    const c = disambiguateDirectoryNames([
      { path: '/data/results' },
      { path: '/home/u/data/results' },
      { path: '/tmp/other' },
    ]);
    const names = c.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => / \(\d+\)$/.test(n))).toBe(true);
    // Every input keeps its own uri.
    expect(c[1].uri.path).toBe('/home/u/data/results');
  });

  // The generated suffix must not collide with a directory literally named
  // `x (2)`. Counting occurrences instead of probing the set gets this wrong and
  // silently drops a column.
  it('never collides a generated suffix with a real "x (2)" name', () => {
    const d = disambiguateDirectoryNames([
      { path: '/data/results' },
      { path: '/home/u/data/results' },
      { path: '/x/data/results (2)' },
    ]);
    const dn = d.map((x) => x.name);
    expect(new Set(dn).size).toBe(dn.length);
  });

  // Three colliding bases: the second takes ` (2)`, so the third must probe past
  // it to ` (3)`. A counter that stops at the first candidate hands out ` (2)` twice.
  it('probes past a handed-out suffix to " (3)" for a third collision', () => {
    const e = disambiguateDirectoryNames([{ path: '/p/out' }, { path: '/q/out' }, { path: '/out' }]);
    const en = e.map((x) => x.name);
    expect(new Set(en).size).toBe(en.length);
    expect(en).toContain('out (3)');
  });

  it('uniquify registers the name it hands out', () => {
    const taken = new Set<string>();
    expect(uniquify('img', taken)).toBe('img');
    expect(uniquify('img', taken)).toBe('img (2)');
    expect(uniquify('img', taken)).toBe('img (3)');
  });
});
