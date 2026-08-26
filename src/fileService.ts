import * as vscode from 'vscode';
import { ImageFile, ImageTuple, ScanResult, isImageFile } from './types';
import { disambiguateDirectoryNames, uniquify } from './modalityNames';
export { disambiguateDirectoryNames };
import { applyLabels } from './sessionFile';
import { parseResults, serializeResults } from './resultsFile';
import { debugEnabled, debugWrite } from './debugLog';
/**
 * Debug logging for tuple matching (controlled by imageCompare.debug setting); the shared
 * sink short-circuits on a cached flag (docs/loading-architecture.md: debug-off-costs-nothing).
 */
function debugLog(...args: unknown[]): void {
  debugWrite('[IC-MATCH]', args);
}

// One comparator shared with the watcher-time row insertion (docs/file-watching.md: rows-insert-in-order).
import { naturalCompare as naturalSort } from './watcherLogic';

/**
 * Strip file extension from filename
 */
function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

/** Prepend parent segments until basenames are unique: ["/a/x/results", "/b/y/results"] → ["x/results", "y/results"]. */

/** Longest Common Subsequence length (two-row, O(n) space) — the last tie-break in tuple matching. */
function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i-1] === b[j-1]) {
        curr[j] = prev[j-1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j-1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  indices: number[];
}

interface MatchedTuple {
  key: string;
  files: Map<string, { name: string; uri: vscode.Uri }>;
}

/** Group each modality's files into tuples keyed by the reference modality's basenames — see docs/tuple-matching.md. */
export function matchTuplesWithTrie(
  modalityFiles: Map<string, Array<{ name: string; uri: vscode.Uri }>>,
  modalities: string[]
): MatchedTuple[] {
  if (modalities.length < 2) {
    // Single modality - return each file as its own tuple
    if (modalities.length === 1) {
      const mod = modalities[0];
      const files = modalityFiles.get(mod) || [];
      return files.map(f => ({
        key: stripExtension(f.name),
        files: new Map([[mod, f]])
      }));
    }
    return [];
  }

  // Reference modality = most files (max coverage); ties go to the earliest in `modalities`.
  let refMod = modalities[0];
  let maxCount = (modalityFiles.get(refMod) || []).length;
  for (const mod of modalities) {
    const count = (modalityFiles.get(mod) || []).length;
    if (count > maxCount) {
      maxCount = count;
      refMod = mod;
    }
  }

  const refFiles = modalityFiles.get(refMod) || [];
  if (refFiles.length === 0) return [];

  if (debugEnabled()) {
    debugLog('=== TUPLE MATCHING START ===');
    debugLog('Modalities:', modalities);
    debugLog('Reference modality:', refMod, 'with', refFiles.length, 'files');
    for (const mod of modalities) {
      const files = modalityFiles.get(mod) || [];
      debugLog(`  ${mod}: ${files.length} files -`, files.map(f => stripExtension(f.name)).join(', '));
    }
  }

  // Trie of reference basenames; each node holds the indices of every ref file passing through it.
  const trie: TrieNode = { children: new Map(), indices: [] };

  for (let i = 0; i < refFiles.length; i++) {
    const key = stripExtension(refFiles[i].name);
    let node = trie;
    // Add index at root level too (for files with no common prefix)
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

  // Create tuple map: refIndex -> Map(modality -> file)
  const tupleMap = new Map<number, Map<string, { name: string; uri: vscode.Uri }>>();
  // Every reference file seeds exactly one tuple; nothing else creates tuples (docs/tuple-matching.md: reference-seeds-one-tuple).
  for (let i = 0; i < refFiles.length; i++) {
    tupleMap.set(i, new Map([[refMod, refFiles[i]]]));
  }

  // Pass 1: exact matches (identical basenames across modalities, e.g. crop files)
  if (debugEnabled()) debugLog('--- Pass 1: Exact matches ---');
  for (const mod of modalities) {
    if (mod === refMod) continue;
    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);
      const exactIdx = refBaseToIdx.get(query);
      if (exactIdx !== undefined) {
        if (debugEnabled()) debugLog(`  EXACT: ${mod}/${file.name} -> ref[${exactIdx}] (${refFiles[exactIdx].name})`);
        tupleMap.get(exactIdx)!.set(mod, file);
      }
    }
  }

  // Pass 2: fuzzy matches via trie (for files without exact ref match)
  if (debugEnabled()) debugLog('--- Pass 2: Fuzzy matches ---');
  // Pass 1 must have run to completion over all modalities before this loop (docs/tuple-matching.md: exact-before-fuzzy).
  for (const mod of modalities) {
    if (mod === refMod) continue;

    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);
      // Skip if already matched exactly in pass 1
      if (refBaseToIdx.has(query)) {
        if (debugEnabled()) debugLog(`  SKIP (exact): ${mod}/${file.name}`);
        continue;
      }

      // Walk trie to find deepest matching node (longest common prefix)
      let node = trie;
      let bestNode = trie;
      let lcpLength = 0;

      for (const char of query) {
        if (!node.children.has(char)) break;
        node = node.children.get(char)!;
        lcpLength++;
        if (node.indices.length > 0) {
          bestNode = node;
        }
      }

      const candidates = bestNode.indices;
      if (candidates.length === 0) {
        if (debugEnabled()) debugLog(`  NO MATCH: ${mod}/${file.name} (no candidates, LCP=${lcpLength})`);
        continue;
      }

      // A crop ref never beats a non-crop one (docs/tuple-matching.md: crop-never-beats-noncrop); then length diff, then LCS.
      const cropSuffixRe = /_crop\d+$/; // Must keep matching the writer (docs/crop-and-pptx.md: cropnn-writer-reader-match).
      let bestIdx = candidates[0];

      if (candidates.length > 1) {
        let bestIsCrop = true;
        let bestLenDiff = Infinity;
        let bestLcs = -1;
        if (debugEnabled()) debugLog(`  FUZZY: ${mod}/${file.name} - ${candidates.length} candidates (LCP=${lcpLength}):`);
        for (const idx of candidates) {
          const refName = stripExtension(refFiles[idx].name);
          const isCrop = cropSuffixRe.test(refName);
          const lenDiff = Math.abs(refName.length - query.length);
          const lcs = lcsLength(query, refName);
          if (debugEnabled()) debugLog(`    candidate ref[${idx}] ${refName}: crop=${isCrop}, lenDiff=${lenDiff}, LCS=${lcs}`);
          const isBetter = (!isCrop && bestIsCrop) ||
            (isCrop === bestIsCrop && lenDiff < bestLenDiff) ||
            (isCrop === bestIsCrop && lenDiff === bestLenDiff && lcs > bestLcs);
          if (isBetter) {
            bestIsCrop = isCrop;
            bestLenDiff = lenDiff;
            bestLcs = lcs;
            bestIdx = idx;
          }
        }
        if (debugEnabled()) debugLog(`    -> best: ref[${bestIdx}] ${stripExtension(refFiles[bestIdx].name)}`);
      } else {
        if (debugEnabled()) debugLog(`  FUZZY: ${mod}/${file.name} -> ref[${bestIdx}] (${refFiles[bestIdx].name}) (single candidate)`);
      }

      tupleMap.get(bestIdx)!.set(mod, file);
    }
  }

  const result: MatchedTuple[] = [];
  for (const [idx, filesMap] of tupleMap) {
    result.push({
      key: stripExtension(refFiles[idx].name),
      files: filesMap
    });
  }

  // Rows are keyed by reference basename; this key sort is intermediate — final order is by tuple name (docs/tuple-matching.md: rows-keyed-by-reference).
  result.sort((a, b) => naturalSort(a.key, b.key));

  if (debugEnabled()) {
    debugLog('--- Final tuples ---');
    for (const tuple of result) {
      const mods = Array.from(tuple.files.keys());
      const missing = modalities.filter(m => !mods.includes(m));
      debugLog(`  ${tuple.key}: [${mods.join(', ')}]${missing.length ? ` MISSING: [${missing.join(', ')}]` : ''}`);
    }
    debugLog('=== TUPLE MATCHING END ===');
  }

  return result;
}

/**
 * Find longest common substring between two strings
 */
function longestCommonSubstring(s1: string, s2: string): string {
  if (!s1 || !s2) return '';

  const len1 = s1.length;
  const len2 = s2.length;
  const dp: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
  let maxLen = 0;
  let endPos = 0;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > maxLen) {
          maxLen = dp[i][j];
          endPos = i;
        }
      }
    }
  }

  return s1.substring(endPos - maxLen, endPos);
}

/** Tuple name from the cluster's filenames — the durable vote key, see docs/session-files.md. */
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

/** Modality names for mode 3: each filename stripped of the common prefix and suffix. */
export function findDifferingParts(names: string[]): string[] {
  if (names.length < 2) return names;

  const basenames = names.map(n => n.replace(/\.[^.]+$/, ''));

  let prefix = basenames[0];
  let suffix = basenames[0];

  for (const name of basenames) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.substring(0, i);

    let j = 0;
    while (j < suffix.length && j < name.length &&
      suffix[suffix.length - 1 - j] === name[name.length - 1 - j]) j++;
    suffix = suffix.substring(suffix.length - j);
  }

  return basenames.map(name => {
    let diff = name.substring(prefix.length, name.length - suffix.length);
    diff = diff.replace(/^[\s_-]+|[\s_-]+$/g, '');
    return diff || name;
  });
}

/**
 * Scan URIs into modalities and tuples; `labels` (keyed by URI string) override modality names in mode 2.
 * Mode is decided here from what the paths are on disk; a session file adds none (docs/session-files.md: sessions-add-no-mode).
 */
export async function scanForImages(uris: vscode.Uri[], labels?: Map<string, string>): Promise<ScanResult> {
  if (uris.length === 0) {
    throw new Error('No files or directories provided');
  }

  // Classify URIs as files or directories
  const classified = await classifyUris(uris);

  // Case 1: Single directory → check for subdirectories as modalities
  if (classified.directories.length === 1 && classified.files.length === 0) {
    return scanDirectory(classified.directories[0]);
  }

  // Case 2: Multiple directories → each directory is a modality
  if (classified.directories.length >= 2 && classified.files.length === 0) {
    // The second of the two naming sites; both must apply labels or neither (docs/session-files.md: labels-all-or-none).
    const dirs = applyLabels(disambiguateDirectoryNames(classified.directories), labels);
    const result = await scanDirectoriesAsModalities(dirs, 2);
    if (result) {
      return result;
    }
    throw new Error('Selected directories must each contain images with matching names');
  }

  // Case 3: Multiple files → single tuple
  if (classified.files.length >= 2 && classified.directories.length === 0) {
    return scanFiles(classified.files);
  }

  // Mixed selection or insufficient items
  if (classified.directories.length > 0 && classified.files.length > 0) {
    throw new Error('Cannot mix files and directories. Select either multiple directories OR multiple image files.');
  }

  throw new Error('Please select at least 2 image files or 2 directories');
}

/**
 * Classify URIs into files and directories
 */
async function classifyUris(uris: vscode.Uri[]): Promise<{ files: vscode.Uri[]; directories: vscode.Uri[] }> {
  const files: vscode.Uri[] = [];
  const directories: vscode.Uri[] = [];

  // Stat in parallel, assemble in input order — modality order is the caller's (docs/tuple-matching.md: modality-order-is-callers).
  const types = await Promise.all(uris.map(async (uri) => {
    try {
      return (await vscode.workspace.fs.stat(uri)).type;
    } catch {
      return undefined;
    }
  }));
  // Bitmask, never equality: a symlink carries bit 64 on top of its target's kind (docs/tuple-matching.md: entry-type-is-a-bitmask).
  uris.forEach((uri, i) => {
    if (((types[i] ?? 0) & vscode.FileType.Directory) !== 0) {
      directories.push(uri);
    } else if (((types[i] ?? 0) & vscode.FileType.File) !== 0) {
      files.push(uri);
    }
  });

  return { files, directories };
}

/**
 * Scan a directory for images (may have subdirectories as modalities)
 */
async function scanDirectory(dirUri: vscode.Uri): Promise<ScanResult> {
  const entries = await vscode.workspace.fs.readDirectory(dirUri);

  const subdirs: Array<{ name: string; uri: vscode.Uri }> = [];
  const files: Array<{ name: string; uri: vscode.Uri }> = [];

  // Bitmask, never equality: a symlinked subdir is a subdir, a broken link (64 alone) is neither (docs/tuple-matching.md: entry-type-is-a-bitmask).
  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    if ((type & vscode.FileType.Directory) !== 0) {
      subdirs.push({ name, uri: childUri });
    } else if ((type & vscode.FileType.File) !== 0 && isImageFile(name)) {
      files.push({ name, uri: childUri });
    }
  }

  // Check for multi-modality mode (2+ subdirectories with images)
  if (subdirs.length >= 2) {
    // Subdirectories have no caller-intended order, so sort them for a stable view.
    subdirs.sort((a, b) => naturalSort(a.name, b.name));
    const modalityResult = await scanDirectoriesAsModalities(subdirs, 1);
    if (modalityResult) {
      return { ...modalityResult, roots: [dirUri] };
    }
  }

  // A directory of only files has no second axis and is not a mode (docs/session-files.md).
  if (files.length > 0) {
    throw new Error(
      'This directory contains only image files without subdirectory structure.\n\n' +
      'For multi-modality comparison, please either:\n' +
      '• Select a directory containing 2+ subdirectories (each subdirectory becomes a modality)\n' +
      '• Select multiple directories (each directory becomes a modality)\n' +
      '• Select specific image files to compare directly'
    );
  }

  throw new Error('Directory must contain 2+ subdirectories with images for comparison');
}

/** Directory listings in flight at once; the scan costs one round trip per wave (docs/tuple-matching.md: dir-listings-overlap). */
const DIR_LISTING_CONCURRENCY = 16;

interface DirListing {
  dir: { name: string; uri: vscode.Uri };
  images?: Array<{ name: string; uri: vscode.Uri }>;
  failure?: { error: unknown };
}

/** One directory's images, in natural name order. */
async function listImagesIn(dir: { name: string; uri: vscode.Uri }): Promise<Array<{ name: string; uri: vscode.Uri }>> {
  const entries = await vscode.workspace.fs.readDirectory(dir.uri);
  const images: Array<{ name: string; uri: vscode.Uri }> = [];

  // Bitmask, never equality: a symlinked image is an image (docs/tuple-matching.md: entry-type-is-a-bitmask).
  for (const [name, type] of entries) {
    if ((type & vscode.FileType.File) !== 0 && isImageFile(name)) {
      images.push({ name, uri: vscode.Uri.joinPath(dir.uri, name) });
    }
  }

  images.sort((a, b) => naturalSort(a.name, b.name));
  return images;
}

/** Every directory's images, one result per input dir in input order, at most DIR_LISTING_CONCURRENCY listings in flight. */
async function listModalityDirectories(
  dirs: Array<{ name: string; uri: vscode.Uri }>
): Promise<DirListing[]> {
  const listings: DirListing[] = new Array(dirs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let i = next++; i < dirs.length; i = next++) {
      try {
        listings[i] = { dir: dirs[i], images: await listImagesIn(dirs[i]) };
      } catch (error) {
        listings[i] = { dir: dirs[i], failure: { error } };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DIR_LISTING_CONCURRENCY, dirs.length) }, () => worker())
  );
  return listings;
}

/** Each directory becomes one modality, in the caller's order — callers sort first (docs/tuple-matching.md: modality-order-is-callers). */
async function scanDirectoriesAsModalities(
  dirs: Array<{ name: string; uri: vscode.Uri }>,
  mode: 1 | 2
): Promise<ScanResult | null> {
  const modalityFiles: Map<string, Array<{ name: string; uri: vscode.Uri }>> = new Map();

  // Listings overlap, but the Map is filled in the caller's dir order, never completion order (docs/tuple-matching.md: modality-order-is-callers).
  const listings = await listModalityDirectories(dirs);

  // A serial loop threw on the first unreadable dir in input order; concurrency must not change which error the user sees (docs/tuple-matching.md: dir-listings-overlap).
  const failed = listings.find(listing => listing.failure);
  if (failed?.failure) {
    throw failed.failure.error;
  }

  for (const listing of listings) {
    if (listing.images && listing.images.length > 0) {
      // Keyed by name, so a duplicate silently merges two modalities (docs/tuple-matching.md: names-are-join-key).
      modalityFiles.set(listing.dir.name, listing.images);
    }
  }

  if (modalityFiles.size < 2) {
    return null; // Not enough directories with images
  }

  const modalities = Array.from(modalityFiles.keys());

  // One flag read gates the scan's own numbers for the open rollup (docs/loading-architecture.md: debug-off-costs-nothing).
  const timed = debugEnabled();
  const scannedFiles = timed ? [...modalityFiles.values()].reduce((n, files) => n + files.length, 0) : 0;
  const matchStart = timed ? Date.now() : 0;
  const matchedTuples = matchTuplesWithTrie(modalityFiles, modalities);
  // The matcher is nested inside the provider's scan span, so the rollup can only split them from here (docs/loading-architecture.md: open-spans-account-for-the-whole-open).
  const matchMs = timed ? Date.now() - matchStart : 0;

  if (matchedTuples.length === 0) {
    return null;
  }

  const tuples: ImageTuple[] = [];
  // Tuple name is the durable vote key; collisions apply one vote to many tuples (docs/session-files.md).
  const takenTupleNames = new Set<string>();
  for (const matched of matchedTuples) {
    const images: ImageFile[] = [];
    const names: string[] = [];

    // Sparse: only modalities the tuple actually has (docs/tuple-matching.md: sparse-vs-dense-tuples).
    for (const modality of modalities) {
      const file = matched.files.get(modality);
      if (file) {
        images.push({
          uri: file.uri,
          name: file.name,
          modality
        });
        names.push(file.name);
      }
    }

    // Only create tuple if at least one image exists
    if (images.length > 0) {
      const baseName = findCommonSubstring(names) || matched.key;
      // Suffix collisions ` (2)`, `(3)`… in tuple order (docs/session-files.md: durable-vote-key).
      tuples.push({ name: uniquify(baseName, takenTupleNames), images });
    }
  }

  // Final order is by tuple NAME, the one the watcher-time insertion maintains — reference keys put `X_crop01` before an `X_gt`-keyed parent (docs/file-watching.md: rows-insert-in-order) (docs/tuple-matching.md: rows-keyed-by-reference).
  tuples.sort((a, b) => naturalSort(a.name, b.name));

  return {
    modalities,
    tuples,
    mode,
    roots: dirs.map(d => d.uri),
    isMultiTupleMode: tuples.length > 1,
    stats: timed ? { files: scannedFiles, matchMs } : undefined
  };
}

/**
 * Scan selected files as a single tuple
 */
async function scanFiles(uris: vscode.Uri[]): Promise<ScanResult> {
  const imageUris = uris.filter(uri => isImageFile(uri.path));

  if (imageUris.length < 2) {
    throw new Error('Please select at least 2 image files');
  }

  imageUris.sort((a, b) => naturalSort(
    a.path.split('/').pop() || '',
    b.path.split('/').pop() || ''
  ));

  return scanFilesAsTuple(imageUris.map(uri => ({
    name: uri.path.split('/').pop() || 'unknown',
    uri
  })));
}

/**
 * Convert a list of files into a single tuple
 */
function scanFilesAsTuple(
  files: Array<{ name: string; uri: vscode.Uri }>
): ScanResult {
  const names = files.map(f => f.name);
  const modalities = findDifferingParts(names);

  // Modality names are the join key downstream; duplicates would silently merge (docs/tuple-matching.md: names-are-join-key).
  const takenModalities = new Set<string>();
  const uniqueModalities = modalities.map(m => uniquify(m, takenModalities));

  const images: ImageFile[] = files.map((f, i) => ({
    uri: f.uri,
    name: f.name,
    modality: uniqueModalities[i]
  }));

  const tupleName = findCommonSubstring(names) || 'Untitled';

  return {
    modalities: uniqueModalities,
    tuples: [{ name: tupleName, images }],
    mode: 3,
    roots: files.map(f => f.uri),
    isMultiTupleMode: false,
    // A file list runs no matcher, so its scan span is all listing (docs/loading-architecture.md: open-spans-account-for-the-whole-open).
    stats: debugEnabled() ? { files: files.length, matchMs: 0 } : undefined
  };
}

export const RESULTS_FILENAME = 'results.txt';

/** Read a results file into Map<tuple name, winner modality name>; empty when unreadable. */
export async function readResultsFile(baseUri: vscode.Uri, filename: string = RESULTS_FILENAME): Promise<Map<string, string>> {
  const resultsUri = vscode.Uri.joinPath(baseUri, filename);

  try {
    const data = await vscode.workspace.fs.readFile(resultsUri);
    // IO wrapper only: the format is decided in resultsFile.ts (docs/standalone.md: results-format-shared).
    return parseResults(Buffer.from(data).toString('utf-8'));
  } catch {
    // File doesn't exist or can't be read - that's OK
    return new Map<string, string>();
  }
}

/** Write the human-editable `<tuple name> = <winner modality>` results file (docs/session-files.md). */
// Retained for the integration round-trip test; the provider persists via resultsFile.persistResults.
export async function writeResultsFile(
  baseUri: vscode.Uri,
  tuples: ImageTuple[],
  winners: Map<number, string>, // tupleIndex -> modality name
  modalities: string[],
  filename: string = RESULTS_FILENAME
): Promise<void> {
  const resultsUri = vscode.Uri.joinPath(baseUri, filename);

  // IO wrapper only: the format is decided in resultsFile.ts (docs/standalone.md: results-format-shared).
  const content = serializeResults(tuples, winners, modalities);
  await vscode.workspace.fs.writeFile(resultsUri, Buffer.from(content, 'utf-8'));
}

/** Resolve loaded winners (by tuple name) to Map<tupleIndex, modalityIndex>; unknown names are dropped. */
export function mapWinnersToIndices(
  winners: Map<string, string>,
  tuples: ImageTuple[],
  modalities: string[]
): Map<number, number> {
  const result = new Map<number, number>();

  for (let tupleIndex = 0; tupleIndex < tuples.length; tupleIndex++) {
    const tuple = tuples[tupleIndex];
    // Must look up by the same durable key writeResultsFile wrote (docs/session-files.md: durable-vote-key).
    const winnerModality = winners.get(tuple.name);

    if (winnerModality) {
      const modalityIndex = modalities.indexOf(winnerModality);
      if (modalityIndex >= 0) {
        result.set(tupleIndex, modalityIndex);
      }
    }
  }

  return result;
}
