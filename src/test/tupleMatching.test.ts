/**
 * Tuple matching tests — matchTuplesWithTrie over filename patterns including crop files.
 * These are pure copies of fileService.ts, not the shipped code (docs/tuple-matching.md).
 *
 * Run: npx ts-node src/test/tupleMatching.test.ts
 */
import { disambiguateDirectoryNames, uniquify } from '../modalityNames';

// ── Pure copies of the matching functions (no vscode dependency) ──────────

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function longestCommonSubstring(s1: string, s2: string): string {
  if (!s1 || !s2) return '';
  const len1 = s1.length, len2 = s2.length;
  const dp: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
  let maxLen = 0, endPos = 0;
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > maxLen) { maxLen = dp[i][j]; endPos = i; }
      }
    }
  }
  return s1.substring(endPos - maxLen, endPos);
}

function findCommonSubstring(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0].replace(/\.[^.]+$/, '');
  const basenames = names.map(n => n.replace(/\.[^.]+$/, ''));
  let common = basenames[0];
  for (let i = 1; i < basenames.length; i++) {
    common = longestCommonSubstring(common, basenames[i]);
    if (!common) break;
  }
  common = common.replace(/^[\s_-]+|[\s_-]+$/g, '');
  return common;
}

// ── Simplified types (no vscode.Uri) ──────────────────────────────────────

interface SimpleFile { name: string; path: string; }
interface TrieNode { children: Map<string, TrieNode>; indices: number[]; }
interface MatchedTuple { key: string; files: Map<string, SimpleFile>; }
interface ResultTuple { name: string; images: Array<{ name: string; modality: string }>; }

// ── matchTuplesWithTrie (identical logic, simplified types) ───────────────

function matchTuplesWithTrie(
  modalityFiles: Map<string, SimpleFile[]>,
  modalities: string[]
): MatchedTuple[] {
  if (modalities.length < 2) {
    if (modalities.length === 1) {
      const mod = modalities[0];
      return (modalityFiles.get(mod) || []).map(f => ({
        key: stripExtension(f.name), files: new Map([[mod, f]])
      }));
    }
    return [];
  }

  let refMod = modalities[0];
  let maxCount = (modalityFiles.get(refMod) || []).length;
  for (const mod of modalities) {
    const count = (modalityFiles.get(mod) || []).length;
    if (count > maxCount) { maxCount = count; refMod = mod; }
  }

  const refFiles = modalityFiles.get(refMod) || [];
  if (refFiles.length === 0) return [];

  const trie: TrieNode = { children: new Map(), indices: [] };
  for (let i = 0; i < refFiles.length; i++) {
    const key = stripExtension(refFiles[i].name);
    let node = trie;
    node.indices.push(i);
    for (const char of key) {
      if (!node.children.has(char)) {
        node.children.set(char, { children: new Map(), indices: [] });
      }
      node = node.children.get(char)!;
      node.indices.push(i);
    }
  }

  // Build a lookup from ref basename -> ref index for exact matching
  const refBaseToIdx = new Map<string, number>();
  for (let i = 0; i < refFiles.length; i++) {
    refBaseToIdx.set(stripExtension(refFiles[i].name), i);
  }

  const tupleMap = new Map<number, Map<string, SimpleFile>>();
  for (let i = 0; i < refFiles.length; i++) {
    tupleMap.set(i, new Map([[refMod, refFiles[i]]]));
  }

  // Pass 1: exact matches (identical basenames across modalities, e.g. crop files)
  for (const mod of modalities) {
    if (mod === refMod) continue;
    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);
      const exactIdx = refBaseToIdx.get(query);
      if (exactIdx !== undefined) {
        tupleMap.get(exactIdx)!.set(mod, file);
      }
    }
  }

  // Pass 2: fuzzy matches via trie (for files without exact ref match)
  for (const mod of modalities) {
    if (mod === refMod) continue;
    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);
      // Skip if already matched exactly in pass 1
      if (refBaseToIdx.has(query)) continue;

      let node = trie;
      let bestNode = trie;
      for (const char of query) {
        if (!node.children.has(char)) break;
        node = node.children.get(char)!;
        if (node.indices.length > 0) bestNode = node;
      }
      const candidates = bestNode.indices;
      if (candidates.length === 0) continue;

      // Prefer: 1) non-crop over crop ref, 2) smaller length difference, 3) higher LCS
      const cropSuffixRe = /_crop\d+$/;
      let bestIdx = candidates[0];
      if (candidates.length > 1) {
        let bestIsCrop = true;
        let bestLenDiff = Infinity;
        let bestLcs = -1;
        for (const idx of candidates) {
          const refName = stripExtension(refFiles[idx].name);
          const isCrop = cropSuffixRe.test(refName);
          const lenDiff = Math.abs(refName.length - query.length);
          const lcs = lcsLength(query, refName);
          const isBetter = (!isCrop && bestIsCrop) ||
            (isCrop === bestIsCrop && lenDiff < bestLenDiff) ||
            (isCrop === bestIsCrop && lenDiff === bestLenDiff && lcs > bestLcs);
          if (isBetter) {
            bestIsCrop = isCrop; bestLenDiff = lenDiff; bestLcs = lcs; bestIdx = idx;
          }
        }
      }
      tupleMap.get(bestIdx)!.set(mod, file);
    }
  }

  const result: MatchedTuple[] = [];
  for (const [idx, filesMap] of tupleMap) {
    result.push({ key: stripExtension(refFiles[idx].name), files: filesMap });
  }
  result.sort((a, b) => naturalSort(a.key, b.key));
  return result;
}

// ── Build tuples (same as scanDirectoriesAsModalities) ────────────────────

function buildTuples(
  modalityFiles: Map<string, SimpleFile[]>,
  modalities: string[]
): ResultTuple[] {
  const matchedTuples = matchTuplesWithTrie(modalityFiles, modalities);
  const tuples: ResultTuple[] = [];
  const takenTupleNames = new Set<string>();
  for (const matched of matchedTuples) {
    const images: Array<{ name: string; modality: string }> = [];
    const names: string[] = [];
    for (const modality of modalities) {
      const file = matched.files.get(modality);
      if (file) {
        images.push({ name: file.name, modality });
        names.push(file.name);
      }
    }
    if (images.length > 0) {
      const baseName = findCommonSubstring(names) || matched.key;
      tuples.push({ name: uniquify(baseName, takenTupleNames), images });
    }
  }
  // Final order is by tuple NAME, mirroring fileService.ts — key order is intermediate only.
  tuples.sort((a, b) => naturalSort(a.name, b.name));
  return tuples;
}

// ── Test helpers ──────────────────────────────────────────────────────────

function makeFiles(dir: string, filenames: string[]): SimpleFile[] {
  return filenames.map(n => ({ name: n, path: `/${dir}/${n}` }));
}

let passed = 0, failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ── Test case 1: originals + crop01 files ─────────────────────────────────

function testOriginalsAndCrops() {
  console.log('\nTest 1: Originals + crop01 files (5 modalities)');

  const modalities = ['GT', 'pred_a', 'pred_b_new', 'pred_c', 'RGB'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_gt.png',
    'dataset_b_1024x768_rgb_00000005_gt.png',
    'dataset_b_1024x768_rgb_00000042_gt.png',
    'dataset_c_1024x768_rgb_00000409_gt.png',
  ]));
  modalityFiles.set('pred_a', makeFiles('pred_a', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
    'dataset_b_1024x768_rgb_00000005_pred.png',
    'dataset_b_1024x768_rgb_00000042_pred.png',
    'dataset_c_1024x768_rgb_00000409_pred.png',
  ]));
  modalityFiles.set('pred_b_new', makeFiles('pred_b_new', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
    'dataset_b_1024x768_rgb_00000005_pred.png',
    'dataset_b_1024x768_rgb_00000042_pred.png',
    'dataset_c_1024x768_rgb_00000409_pred.png',
  ]));
  modalityFiles.set('pred_c', makeFiles('pred_c', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
    'dataset_b_1024x768_rgb_00000005_pred.png',
    'dataset_b_1024x768_rgb_00000042_pred.png',
    'dataset_c_1024x768_rgb_00000409_pred.png',
  ]));
  modalityFiles.set('RGB', makeFiles('RGB', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_rgb.png',
    'dataset_b_1024x768_rgb_00000005_rgb.png',
    'dataset_b_1024x768_rgb_00000042_rgb.png',
    'dataset_c_1024x768_rgb_00000409_rgb.png',
  ]));

  const tuples = buildTuples(modalityFiles, modalities);

  console.log(`  Got ${tuples.length} tuples:`);
  for (const t of tuples) {
    const mods = t.images.map(i => `${i.modality}:${i.name}`).join(', ');
    console.log(`    "${t.name}" => [${mods}]`);
  }

  // 5 tuples of 5 modalities: 00000079 original, its crop01, and 00000005/42/409.
  assert(tuples.length === 5, `Expected 5 tuples, got ${tuples.length}`);

  // Find the crop tuple (name should contain "crop01")
  const cropTuple = tuples.find(t => t.name.includes('crop01'));
  assert(cropTuple !== undefined, 'Should have a crop01 tuple');
  if (cropTuple) {
    assert(cropTuple.images.length === 5, `crop01 tuple should have 5 images, got ${cropTuple.images.length}`);
    // All images in the crop tuple should have the same filename
    const cropNames = new Set(cropTuple.images.map(i => i.name));
    assert(cropNames.size === 1, `crop01 tuple images should all have same filename, got: ${[...cropNames].join(', ')}`);
  }

  // Find the original 00000079 tuple
  const origTuple = tuples.find(t => t.name.includes('00000079') && !t.name.includes('crop'));
  assert(origTuple !== undefined, 'Should have an original 00000079 tuple');
  if (origTuple) {
    assert(origTuple.images.length === 5, `Original 00000079 tuple should have 5 images, got ${origTuple.images.length}`);
    // Images should be _gt, _pred (x3), _rgb — NOT crop01
    for (const img of origTuple.images) {
      assert(!img.name.includes('crop'), `Original tuple should not contain crop file: ${img.name} (${img.modality})`);
    }
  }

  // Check the other 3 tuples
  for (const suffix of ['00000005', '00000042', '00000409']) {
    const t = tuples.find(t => t.name.includes(suffix));
    assert(t !== undefined, `Should have tuple for ${suffix}`);
    if (t) {
      assert(t.images.length === 5, `${suffix} tuple should have 5 images, got ${t.images.length}`);
    }
  }
}

// ── Test case 2: With crop01 AND crop01_crop01 ────────────────────────────

function testDoubleCrop() {
  console.log('\nTest 2: Originals + crop01 + crop01_crop01');

  const modalities = ['GT', 'pred_a', 'RGB'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'dataset_a_1024x768_rgb_00000079_crop01_crop01.png',
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_gt.png',
  ]));
  modalityFiles.set('pred_a', makeFiles('pred_a', [
    'dataset_a_1024x768_rgb_00000079_crop01_crop01.png',
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
  ]));
  modalityFiles.set('RGB', makeFiles('RGB', [
    'dataset_a_1024x768_rgb_00000079_crop01_crop01.png',
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_rgb.png',
  ]));

  const tuples = buildTuples(modalityFiles, modalities);

  console.log(`  Got ${tuples.length} tuples:`);
  for (const t of tuples) {
    const mods = t.images.map(i => `${i.modality}:${i.name}`).join(', ');
    console.log(`    "${t.name}" => [${mods}]`);
  }

  assert(tuples.length === 3, `Expected 3 tuples, got ${tuples.length}`);

  const origTuple = tuples.find(t => !t.name.includes('crop'));
  assert(origTuple !== undefined, 'Should have an original tuple');
  if (origTuple) {
    assert(origTuple.images.length === 3, `Original tuple should have 3 images, got ${origTuple.images.length}`);
    for (const img of origTuple.images) {
      assert(!img.name.includes('crop'), `Original tuple should not contain crop: ${img.name}`);
    }
  }

  const crop1Tuple = tuples.find(t => t.name.includes('crop01') && !t.name.includes('crop01_crop01'));
  assert(crop1Tuple !== undefined, 'Should have a crop01 tuple');
  if (crop1Tuple) {
    assert(crop1Tuple.images.length === 3, `crop01 tuple should have 3 images, got ${crop1Tuple.images.length}`);
  }

  const crop2Tuple = tuples.find(t => t.name.includes('crop01_crop01'));
  assert(crop2Tuple !== undefined, 'Should have a crop01_crop01 tuple');
  if (crop2Tuple) {
    assert(crop2Tuple.images.length === 3, `crop01_crop01 tuple should have 3 images, got ${crop2Tuple.images.length}`);
  }
}

// ── Test case 3: No crop files (baseline) ─────────────────────────────────

function testBaseline() {
  console.log('\nTest 3: Baseline (no crop files)');

  const modalities = ['GT', 'pred', 'RGB'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'img_001_gt.png', 'img_002_gt.png',
  ]));
  modalityFiles.set('pred', makeFiles('pred', [
    'img_001_pred.png', 'img_002_pred.png',
  ]));
  modalityFiles.set('RGB', makeFiles('RGB', [
    'img_001_rgb.png', 'img_002_rgb.png',
  ]));

  const tuples = buildTuples(modalityFiles, modalities);

  console.log(`  Got ${tuples.length} tuples:`);
  for (const t of tuples) {
    const mods = t.images.map(i => `${i.modality}:${i.name}`).join(', ');
    console.log(`    "${t.name}" => [${mods}]`);
  }

  assert(tuples.length === 2, `Expected 2 tuples, got ${tuples.length}`);
  for (const t of tuples) {
    assert(t.images.length === 3, `Each tuple should have 3 images, got ${t.images.length}`);
  }
}

// ── Test case 4: _pred matches _gt, not _crop01 (crop rule, lenDiff tied) ─

function testPredMatchesGtNotCrop() {
  console.log('\nTest 4: _pred matches _gt, not _crop01 (lenDiff ties at 2, so the crop rule decides)');

  // Rule 1 is the only rule that can decide: lenDiff is 2 to either ref (47 and 43 vs query 45),
  // so rule 2 is inert, and rule 3 would actively pick _crop01 (LCS 42 vs 41).
  const modalities = ['GT', 'pred'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'dataset_a_scene_01_1024x768_rgb_00000079_crop01.png',  // long: 47 chars (no ext)
    'dataset_a_scene_01_1024x768_rgb_00000079_gt.png',      // short: 43 chars (no ext)
  ]));
  modalityFiles.set('pred', makeFiles('pred', [
    'dataset_a_scene_01_1024x768_rgb_00000079_crop01.png',  // exact match to crop01
    'dataset_a_scene_01_1024x768_rgb_00000079_pred.png',    // should match _gt, not _crop01
  ]));

  const tuples = buildTuples(modalityFiles, modalities);

  console.log(`  Got ${tuples.length} tuples:`);
  for (const t of tuples) {
    const mods = t.images.map(i => `${i.modality}:${i.name}`).join(', ');
    console.log(`    "${t.name}" => [${mods}]`);
  }

  assert(tuples.length === 2, `Expected 2 tuples, got ${tuples.length}`);

  // The _crop01 tuple should have exact matches
  const cropTuple = tuples.find(t => t.name.includes('crop01'));
  assert(cropTuple !== undefined, 'Should have a crop01 tuple');
  if (cropTuple) {
    assert(cropTuple.images.length === 2, `crop01 tuple should have 2 images, got ${cropTuple.images.length}`);
    // Both should be _crop01 files
    for (const img of cropTuple.images) {
      assert(img.name.includes('crop01'), `crop01 tuple should only have crop01 files: ${img.name}`);
    }
  }

  // The _gt tuple should have _gt and _pred (not _crop01)
  const gtTuple = tuples.find(t => t.name.includes('_gt') || (t.name.includes('00000079') && !t.name.includes('crop')));
  assert(gtTuple !== undefined, 'Should have a _gt tuple');
  if (gtTuple) {
    assert(gtTuple.images.length === 2, `_gt tuple should have 2 images, got ${gtTuple.images.length}`);
    // Check that pred modality has _pred file, not _crop01
    const predImg = gtTuple.images.find(i => i.modality === 'pred');
    assert(predImg !== undefined, '_gt tuple should have a pred modality image');
    if (predImg) {
      assert(predImg.name.includes('_pred'), `pred image in _gt tuple should be _pred.png, got: ${predImg.name}`);
      assert(!predImg.name.includes('crop'), `pred image in _gt tuple should NOT be _crop01: ${predImg.name}`);
    }
  }
}

// ── Test case 5: long modality name should still match _gt, not _crop01 ───

function testLongModalityMatchesGtNotCrop() {
  console.log('\nTest 5: long modality name should match _gt, not _crop01 (crop deprioritized)');

  // Pins crop deprioritization: a long query suffix makes _crop01 the closer ref by length alone.
  const modalities = ['GT', 'longmodality'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'image001_crop01.png',
    'image001_gt.png',
  ]));
  modalityFiles.set('longmodality', makeFiles('longmodality', [
    'image001_crop01.png',       // exact match to crop01
    'image001_longmodality.png', // should match _gt, not _crop01
  ]));

  const tuples = buildTuples(modalityFiles, modalities);

  console.log(`  Got ${tuples.length} tuples:`);
  for (const t of tuples) {
    const mods = t.images.map(i => `${i.modality}:${i.name}`).join(', ');
    console.log(`    "${t.name}" => [${mods}]`);
  }

  assert(tuples.length === 2, `Expected 2 tuples, got ${tuples.length}`);

  // The non-crop tuple (named "image001") should have the longmodality file
  const gtTuple = tuples.find(t => !t.name.includes('crop'));
  assert(gtTuple !== undefined, 'Should have a non-crop tuple');
  if (gtTuple) {
    assert(gtTuple.images.length === 2, `_gt tuple should have 2 images, got ${gtTuple.images.length}`);
    const longImg = gtTuple.images.find(i => i.modality === 'longmodality');
    assert(longImg !== undefined, '_gt tuple should have a longmodality image');
    if (longImg) {
      assert(longImg.name.includes('_longmodality'), `longmodality image should be _longmodality.png, got: ${longImg.name}`);
      assert(!longImg.name.includes('crop'), `longmodality image should NOT be _crop01: ${longImg.name}`);
    }
  }
}

// ── Test case 6: length tie-break alone decides (docs/tuple-matching.md rule 2) ──

function testLengthTieBreak() {
  console.log('\nTest 6: the closer-length non-crop ref wins (rule 2 decides alone)');

  // Rule 2 is the only rule that can decide. Rule 1 is inert (neither ref is a crop).
  // Rule 3 cannot run (it needs a lenDiff tie) and could not decide anyway: LCS is 10 to
  // both refs. So inverting `lenDiff < bestLenDiff` must flip the match.
  const modalities = ['ref', 'query'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  // Both refs break from the query at the same char, so the trie hands back both as candidates.
  modalityFiles.set('ref', makeFiles('ref', [
    'img_00001_alpha.png', // base len 15 -> lenDiff 4
    'img_00001_a.png',     // base len 11 -> lenDiff 0  <- must win
  ]));
  modalityFiles.set('query', makeFiles('query', [
    'img_00001_q.png',     // base len 11; shares LCP "img_00001_" with both refs
  ]));

  const matched = matchTuplesWithTrie(modalityFiles, modalities);
  const withQuery = matched.filter(t => t.files.has('query'));
  assert(withQuery.length === 1, `exactly one tuple should absorb the query, got ${withQuery.length}`);
  assert(withQuery[0]?.key === 'img_00001_a',
    `query must attach to the closer-length ref (lenDiff 0), got: ${withQuery[0]?.key}`);
}

// ── Test case 7: LCS alone decides (docs/tuple-matching.md rule 3) ────────

function testLcsTieBreak() {
  console.log('\nTest 7: higher LCS wins among refs tied on crop-ness and length (rule 3 decides alone)');

  // The doc says LCS "decides only among candidates already tied on crop-ness *and* length" —
  // that state is reachable, and this is it. Rule 1 is inert (neither ref is a crop); rule 2 is
  // inert (both refs are 13 chars, as is the query, so lenDiff is 0 for both). Only LCS separates
  // them: 12 to _zab vs 11 to _zba. The winner is at index 1, so the greedy comparator can only
  // reach it through the LCS clause.
  const modalities = ['ref', 'query'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('ref', makeFiles('ref', [
    'img_00001_zba.png', // LCS 11 with the query
    'img_00001_zab.png', // LCS 12 with the query  <- must win
  ]));
  modalityFiles.set('query', makeFiles('query', [
    'img_00001_qab.png', // diverges from both refs at the same char -> both are candidates
  ]));

  const matched = matchTuplesWithTrie(modalityFiles, modalities);
  const withQuery = matched.filter(t => t.files.has('query'));
  assert(withQuery.length === 1, `exactly one tuple should absorb the query, got ${withQuery.length}`);
  assert(withQuery[0]?.key === 'img_00001_zab',
    `query must attach to the higher-LCS ref, got: ${withQuery[0]?.key}`);
}

// ── Test case 8: rows sorted by ref basename (docs/tuple-matching.md: rows-keyed-by-reference) ──

function testSortOrderByIndex() {
  console.log('\nTest 8: matcher keys sort naturally, and the final row order is by tuple NAME (docs/tuple-matching.md: rows-keyed-by-reference)');

  const modalities = ['GT', 'pred'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  // Insertion order (2, 10, 1) is neither the sorted nor the reverse-sorted order, so asserting
  // by index catches an inverted sort, a removed sort, and a lexicographic (non-natural) sort.
  modalityFiles.set('GT', makeFiles('GT', [
    'img_2_gt.png', 'img_10_gt.png', 'img_1_gt.png',
  ]));
  modalityFiles.set('pred', makeFiles('pred', [
    'img_2_pred.png', 'img_10_pred.png', 'img_1_pred.png',
  ]));

  const matched = matchTuplesWithTrie(modalityFiles, modalities);
  assert(matched.length === 3, `Expected 3 matched tuples, got ${matched.length}`);
  ['img_1_gt', 'img_2_gt', 'img_10_gt'].forEach((key, i) => {
    assert(matched[i]?.key === key, `matched[${i}].key should be "${key}", got: ${matched[i]?.key}`);
  });

  const tuples = buildTuples(modalityFiles, modalities);
  assert(tuples.length === 3, `Expected 3 tuples, got ${tuples.length}`);
  ['img_1', 'img_2', 'img_10'].forEach((name, i) => {
    assert(tuples[i]?.name === name, `tuples[${i}].name should be "${name}", got: ${tuples[i]?.name}`);
  });

  // Key order and NAME order differ here: by key, img_1_crop01_gt < img_1_gt (c < g); by name,
  // img_1 < img_1_crop01. The shipped final sort is by name, so the parent row precedes its crop —
  // a fixture where the orders coincide would leave the name-sort deletable without a failure.
  const cropFiles = new Map<string, SimpleFile[]>();
  cropFiles.set('GT', makeFiles('GT', ['img_1_crop01_gt.png', 'img_1_gt.png']));
  cropFiles.set('pred', makeFiles('pred', ['img_1_crop01_pred.png', 'img_1_pred.png']));
  const cropTuples = buildTuples(cropFiles, modalities);
  assert(cropTuples.length === 2, `Expected 2 tuples, got ${cropTuples.length}`);
  assert(cropTuples[0]?.name === 'img_1' && cropTuples[1]?.name === 'img_1_crop01',
    `parent row must precede its crop despite reversed key order: got [${cropTuples.map(t => t.name).join(', ')}]`);
}

// ── Test case 9: colliding tuple names are made unique ────────────────────

function testCollidingTupleNames() {
  console.log('\nTest 9: colliding tuple names get a " (N)" suffix');
  // Both reference files reduce to the same emergent name. `ImageTuple.name` is the durable
  // results.txt key, so without a suffix one vote would land on both rows.
  const modalityFiles = new Map<string, SimpleFile[]>();
  modalityFiles.set('GT', makeFiles('GT', ['img.png', 'img.tiff']));
  modalityFiles.set('pred', makeFiles('pred', ['img.png', 'img.tiff']));

  const tuples = buildTuples(modalityFiles, ['GT', 'pred']);
  const names = tuples.map(t => t.name);
  console.log(`  names: ${JSON.stringify(names)}`);
  assert(new Set(names).size === names.length, `tuple names must be unique, got ${JSON.stringify(names)}`);
  assert(names.some(n => / \(\d+\)$/.test(n)), `expected a " (N)" suffix, got ${JSON.stringify(names)}`);
}

// ── Run all tests ─────────────────────────────────────────────────────────

testBaseline();
testOriginalsAndCrops();
testDoubleCrop();
testPredMatchesGtNotCrop();
testLongModalityMatchesGtNotCrop();
testLengthTieBreak();
testLcsTieBreak();
testSortOrderByIndex();
testCollidingTupleNames();

console.log('Test 10: disambiguateDirectoryNames yields unique modality names');
{
  // Shortest unique tail.
  const a = disambiguateDirectoryNames([{ path: '/runs/exp1/out' }, { path: '/runs/exp2/out' }]);
  assert(a.map(x => x.name).join(',') === 'exp1/out,exp2/out', `got ${a.map(x => x.name).join(',')}`);

  // Already unique at depth 1.
  const b = disambiguateDirectoryNames([{ path: '/a/gt' }, { path: '/b/pred' }]);
  assert(b.map(x => x.name).join(',') === 'gt,pred', `got ${b.map(x => x.name).join(',')}`);

  // The fallback: equal tails with one path shorter, so the loop exhausts maxDepth. Without a suffix
  // these collide, and a duplicate name silently merges two modalities.
  const c = disambiguateDirectoryNames([
    { path: '/data/results' },
    { path: '/home/u/data/results' },
    { path: '/tmp/other' }
  ]);
  const names = c.map(x => x.name);
  assert(new Set(names).size === names.length, `names must be unique, got ${JSON.stringify(names)}`);
  assert(names.some(n => / \(\d+\)$/.test(n)), `expected a " (N)" suffix, got ${JSON.stringify(names)}`);

  // Every input keeps its own uri.
  assert(c[1].uri.path === '/home/u/data/results', 'uri must stay paired with its name');

  // The generated suffix must not collide with a directory literally named `x (2)`. Counting
  // occurrences instead of probing the set gets this wrong and silently drops a column.
  const d = disambiguateDirectoryNames([
    { path: '/data/results' },
    { path: '/home/u/data/results' },
    { path: '/x/data/results (2)' }
  ]);
  const dn = d.map(x => x.name);
  assert(new Set(dn).size === dn.length, `suffix must not collide with a real name, got ${JSON.stringify(dn)}`);

  // Three colliding bases: the second takes ` (2)`, so the third must probe past it to ` (3)`.
  // A counter that stops at the first candidate hands out ` (2)` twice.
  const e = disambiguateDirectoryNames([{ path: '/p/out' }, { path: '/q/out' }, { path: '/out' }]);
  const en = e.map(x => x.name);
  assert(new Set(en).size === en.length, `expected unique names, got ${JSON.stringify(en)}`);
  assert(en.includes('out (3)'), `expected a third distinct suffix, got ${JSON.stringify(en)}`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
