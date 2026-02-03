/**
 * Tuple matching tests — exercises matchTuplesWithTrie logic
 * with real-world filename patterns including crop files.
 *
 * Run: npx ts-node src/test/tupleMatching.test.ts
 */
export {};

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

  // Track which ref indices have at least one exact match from another modality.
  // These are "claimed" by exact matches and should be excluded from fuzzy matching.
  const exactMatchedRefs = new Set<number>();

  // Pass 1: exact matches (identical basenames across modalities, e.g. crop files)
  for (const mod of modalities) {
    if (mod === refMod) continue;
    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);
      const exactIdx = refBaseToIdx.get(query);
      if (exactIdx !== undefined) {
        tupleMap.get(exactIdx)!.set(mod, file);
        exactMatchedRefs.add(exactIdx);
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
      // Filter out exact-matched refs from candidates
      const candidates = bestNode.indices.filter(i => !exactMatchedRefs.has(i));
      if (candidates.length === 0) continue;

      let bestIdx = candidates[0];
      if (candidates.length > 1) {
        let bestLenDiff = Infinity;
        let bestLcs = -1;
        for (const idx of candidates) {
          const refName = stripExtension(refFiles[idx].name);
          const lenDiff = Math.abs(refName.length - query.length);
          const lcs = lcsLength(query, refName);
          if (lenDiff < bestLenDiff || (lenDiff === bestLenDiff && lcs > bestLcs)) {
            bestLenDiff = lenDiff; bestLcs = lcs; bestIdx = idx;
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
      const tupleName = findCommonSubstring(names) || matched.key;
      tuples.push({ name: tupleName, images });
    }
  }
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

// ── Test case 1: User's exact tree ────────────────────────────────────────

function testUserTree() {
  console.log('\nTest 1: User tree (originals + crop01 files)');

  const modalities = ['GT', 'res518_p14', 'res672_p16_new', 'res768_p16', 'RGB'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_gt.png',
    'dataset_b_1024x768_rgb_00000005_gt.png',
    'dataset_b_1024x768_rgb_00000042_gt.png',
    'dataset_c_1024x768_rgb_00000409_gt.png',
  ]));
  modalityFiles.set('res518_p14', makeFiles('res518_p14', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
    'dataset_b_1024x768_rgb_00000005_pred.png',
    'dataset_b_1024x768_rgb_00000042_pred.png',
    'dataset_c_1024x768_rgb_00000409_pred.png',
  ]));
  modalityFiles.set('res672_p16_new', makeFiles('res672_p16_new', [
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_pred.png',
    'dataset_b_1024x768_rgb_00000005_pred.png',
    'dataset_b_1024x768_rgb_00000042_pred.png',
    'dataset_c_1024x768_rgb_00000409_pred.png',
  ]));
  modalityFiles.set('res768_p16', makeFiles('res768_p16', [
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

  // Expected: 5 tuples, each with exactly 5 modalities
  // - Original _gt/_pred/_rgb tuple for 00000079
  // - Crop tuple for 00000079_crop01 (identical filename in all dirs)
  // - 3 other original tuples (00000005, 00000042, 00000409)
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

  const modalities = ['GT', 'res518_p14', 'RGB'];
  const modalityFiles = new Map<string, SimpleFile[]>();

  modalityFiles.set('GT', makeFiles('GT', [
    'dataset_a_1024x768_rgb_00000079_crop01_crop01.png',
    'dataset_a_1024x768_rgb_00000079_crop01.png',
    'dataset_a_1024x768_rgb_00000079_gt.png',
  ]));
  modalityFiles.set('res518_p14', makeFiles('res518_p14', [
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

// ── Run all tests ─────────────────────────────────────────────────────────

testBaseline();
testUserTree();
testDoubleCrop();

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
