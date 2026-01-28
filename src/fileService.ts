import * as vscode from 'vscode';
import { ImageFile, ImageTuple, ScanResult, isImageFile } from './types';

/**
 * Natural sort comparator for filenames
 */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Strip file extension from filename
 */
function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

/**
 * Longest Common Subsequence length for tie-breaking
 * Uses O(n) space with two-row optimization
 */
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

/**
 * Trie-based tuple matching with LCP scoring and LCS tie-breaking
 *
 * Algorithm:
 * 1. Pick reference modality (one with most files)
 * 2. Build trie from reference filenames - each node tracks which files pass through
 * 3. For each file in other modalities:
 *    - Walk trie to find longest matching prefix (LCP)
 *    - Collect candidate reference files at deepest matched node
 *    - Use LCS (longest common subsequence) as tie-breaker
 * 4. Group files by their matched reference file
 *
 * Complexity: O(N * L) for trie ops, O(ties * L²) for LCS tie-breaking
 * where N = total files, L = max filename length
 */
function matchTuplesWithTrie(
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

  // Pick reference modality (most files) - ensures best coverage
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

  // Build trie from reference filenames
  // Each node has: children (Map), indices (array of refFile indices that pass through)
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

  // Create tuple map: refIndex -> Map(modality -> file)
  const tupleMap = new Map<number, Map<string, { name: string; uri: vscode.Uri }>>();
  for (let i = 0; i < refFiles.length; i++) {
    tupleMap.set(i, new Map([[refMod, refFiles[i]]]));
  }

  // Match files from other modalities using trie lookup
  for (const mod of modalities) {
    if (mod === refMod) continue;

    const files = modalityFiles.get(mod) || [];
    for (const file of files) {
      const query = stripExtension(file.name);

      // Walk trie to find deepest matching node (longest common prefix)
      let node = trie;
      let bestNode = trie;  // Track deepest node with indices

      for (const char of query) {
        if (!node.children.has(char)) break;
        node = node.children.get(char)!;
        if (node.indices.length > 0) {
          bestNode = node;
        }
      }

      const candidates = bestNode.indices;
      if (candidates.length === 0) {
        // No match found - skip (shouldn't happen with valid trie)
        continue;
      }

      // Find best match among candidates
      let bestIdx = candidates[0];

      if (candidates.length > 1) {
        // Tie-breaker: use LCS (longest common subsequence)
        // Files with more characters in common (even non-contiguous) score higher
        let bestScore = -1;
        for (const idx of candidates) {
          const refName = stripExtension(refFiles[idx].name);
          const score = lcsLength(query, refName);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
          }
        }
      }

      // Add to tuple
      tupleMap.get(bestIdx)!.set(mod, file);
    }
  }

  // Convert to array format
  const result: MatchedTuple[] = [];
  for (const [idx, filesMap] of tupleMap) {
    result.push({
      key: stripExtension(refFiles[idx].name),
      files: filesMap
    });
  }

  // Sort by key for consistent ordering
  result.sort((a, b) => naturalSort(a.key, b.key));

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

/**
 * Find common substring among multiple filenames (for tuple naming)
 */
function findCommonSubstring(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0].replace(/\.[^.]+$/, '');

  // Remove extensions
  const basenames = names.map(n => n.replace(/\.[^.]+$/, ''));

  // Find longest common substring
  let common = basenames[0];
  for (let i = 1; i < basenames.length; i++) {
    common = longestCommonSubstring(common, basenames[i]);
    if (!common) break;
  }

  // Clean up trailing/leading underscores, dashes, spaces
  common = common.replace(/^[\s_-]+|[\s_-]+$/g, '');
  return common;
}

/**
 * Find differing parts of filenames (for modality naming when files are selected)
 */
function findDifferingParts(names: string[]): string[] {
  if (names.length < 2) return names;

  // Remove extensions
  const basenames = names.map(n => n.replace(/\.[^.]+$/, ''));

  // Find common prefix and suffix
  let prefix = basenames[0];
  let suffix = basenames[0];

  for (const name of basenames) {
    // Find common prefix
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.substring(0, i);

    // Find common suffix
    let j = 0;
    while (j < suffix.length && j < name.length &&
      suffix[suffix.length - 1 - j] === name[name.length - 1 - j]) j++;
    suffix = suffix.substring(suffix.length - j);
  }

  // Extract differing parts
  return basenames.map(name => {
    let diff = name.substring(prefix.length, name.length - suffix.length);
    diff = diff.replace(/^[\s_-]+|[\s_-]+$/g, '');
    return diff || name;
  });
}

/**
 * Scan a directory or set of files and return structured image data
 * 
 * Three modes:
 * 1. Single directory with subdirectories → each subdirectory is a modality
 * 2. Multiple directories selected → each directory is a modality  
 * 3. Multiple image files selected → single tuple with files as modalities
 */
export async function scanForImages(uris: vscode.Uri[]): Promise<ScanResult> {
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
    const dirs = classified.directories.map(uri => ({
      name: uri.path.split('/').pop() || 'unknown',
      uri
    }));
    const result = await scanDirectoriesAsModalities(dirs);
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

  await Promise.all(uris.map(async (uri) => {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        directories.push(uri);
      } else if (stat.type === vscode.FileType.File) {
        files.push(uri);
      }
    } catch {
      // Skip URIs that can't be stat'd
    }
  }));

  return { files, directories };
}

/**
 * Scan a directory for images (may have subdirectories as modalities)
 */
async function scanDirectory(dirUri: vscode.Uri): Promise<ScanResult> {
  const entries = await vscode.workspace.fs.readDirectory(dirUri);

  const subdirs: Array<{ name: string; uri: vscode.Uri }> = [];
  const files: Array<{ name: string; uri: vscode.Uri }> = [];

  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    if (type === vscode.FileType.Directory) {
      subdirs.push({ name, uri: childUri });
    } else if (type === vscode.FileType.File && isImageFile(name)) {
      files.push({ name, uri: childUri });
    }
  }

  // Check for multi-modality mode (2+ subdirectories with images)
  if (subdirs.length >= 2) {
    const modalityResult = await scanDirectoriesAsModalities(subdirs);
    if (modalityResult) {
      return modalityResult;
    }
  }

  // Single directory with only files (no valid subdirectory structure)
  // This is NOT a valid comparison mode - user should either:
  // - Select a directory with 2+ subdirectories (each subdirectory = modality)
  // - Select multiple directories (each directory = modality)  
  // - Select specific image files to compare
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

/**
 * Scan directories as modalities (each directory = one modality)
 * Works for both subdirectories of a parent and independently selected directories
 */
async function scanDirectoriesAsModalities(
  dirs: Array<{ name: string; uri: vscode.Uri }>
): Promise<ScanResult | null> {
  // Sort modalities alphabetically
  dirs.sort((a, b) => naturalSort(a.name, b.name));

  // Read image files from each directory
  const modalityFiles: Map<string, Array<{ name: string; uri: vscode.Uri }>> = new Map();

  for (const dir of dirs) {
    const entries = await vscode.workspace.fs.readDirectory(dir.uri);
    const images: Array<{ name: string; uri: vscode.Uri }> = [];

    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && isImageFile(name)) {
        images.push({ name, uri: vscode.Uri.joinPath(dir.uri, name) });
      }
    }

    if (images.length > 0) {
      images.sort((a, b) => naturalSort(a.name, b.name));
      modalityFiles.set(dir.name, images);
    }
  }

  if (modalityFiles.size < 2) {
    return null; // Not enough directories with images
  }

  const modalities = Array.from(modalityFiles.keys());

  // Use trie-based matching to group files into tuples
  const matchedTuples = matchTuplesWithTrie(modalityFiles, modalities);

  if (matchedTuples.length === 0) {
    return null;
  }

  // Build tuples from matched files
  const tuples: ImageTuple[] = [];
  for (const matched of matchedTuples) {
    const images: ImageFile[] = [];
    const names: string[] = [];

    // Add files in modality order
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
      const tupleName = findCommonSubstring(names) || matched.key;
      tuples.push({ name: tupleName, images });
    }
  }

  // Log info about partial tuples
  const partialCount = tuples.filter(t => t.images.length < modalities.length).length;
  // partialCount tuples are missing some modalities - this is expected and handled gracefully

  return {
    modalities,
    tuples,
    isMultiTupleMode: tuples.length > 1
  };
}

/**
 * Scan selected files as a single tuple
 */
async function scanFiles(uris: vscode.Uri[]): Promise<ScanResult> {
  // Filter to only image files
  const imageUris = uris.filter(uri => isImageFile(uri.path));

  if (imageUris.length < 2) {
    throw new Error('Please select at least 2 image files');
  }

  // Sort by filename
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

  // Ensure unique modality names
  const seen = new Map<string, number>();
  const uniqueModalities = modalities.map(m => {
    const count = seen.get(m) || 0;
    seen.set(m, count + 1);
    return count > 0 ? `${m} (${count + 1})` : m;
  });

  const images: ImageFile[] = files.map((f, i) => ({
    uri: f.uri,
    name: f.name,
    modality: uniqueModalities[i]
  }));

  const tupleName = findCommonSubstring(names) || 'Untitled';

  return {
    modalities: uniqueModalities,
    tuples: [{ name: tupleName, images }],
    isMultiTupleMode: false
  };
}

/**
 * Results file name
 */
export const RESULTS_FILENAME = 'results.txt';

/**
 * Read results.txt and parse winner data
 * Returns a Map of tuple key (name) -> winner modality name
 */
export async function readResultsFile(baseUri: vscode.Uri): Promise<Map<string, string>> {
  const resultsUri = vscode.Uri.joinPath(baseUri, RESULTS_FILENAME);
  const winners = new Map<string, string>();

  try {
    const data = await vscode.workspace.fs.readFile(resultsUri);
    const content = Buffer.from(data).toString('utf-8');

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Parse format: tuple_key = winner_modality
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const tupleKey = trimmed.substring(0, eqIndex).trim();
        const modality = trimmed.substring(eqIndex + 1).trim();
        if (tupleKey && modality) {
          winners.set(tupleKey, modality);
        }
      }
    }
  } catch {
    // File doesn't exist or can't be read - that's OK
  }

  return winners;
}

/**
 * Write results.txt with current winner data
 * Format is human-readable and editable:
 *   # ImageCompare Results
 *   # Format: tuple_key = winner_modality
 *   tuple_name_1 = ModA
 *   tuple_name_2 = ModB
 */
export async function writeResultsFile(
  baseUri: vscode.Uri,
  tuples: ImageTuple[],
  winners: Map<number, string>, // tupleIndex -> modality name
  modalities: string[]
): Promise<void> {
  const resultsUri = vscode.Uri.joinPath(baseUri, RESULTS_FILENAME);

  // Build file content
  const lines: string[] = [
    '# ImageCompare Results',
    `# Generated: ${new Date().toISOString()}`,
    `# Modalities: ${modalities.join(', ')}`,
    '#',
    '# Format: tuple_key = winner_modality',
    '# Delete a line to remove the vote, edit modality name to change vote',
    ''
  ];

  // Add winner entries for tuples that have winners
  for (let i = 0; i < tuples.length; i++) {
    const winnerModality = winners.get(i);
    if (winnerModality) {
      lines.push(`${tuples[i].name} = ${winnerModality}`);
    }
  }

  const content = lines.join('\n') + '\n';
  await vscode.workspace.fs.writeFile(resultsUri, Buffer.from(content, 'utf-8'));
}

/**
 * Map loaded winners (by tuple name) to tuple indices
 * Returns Map<tupleIndex, modalityIndex>
 */
export function mapWinnersToIndices(
  winners: Map<string, string>,
  tuples: ImageTuple[],
  modalities: string[]
): Map<number, number> {
  const result = new Map<number, number>();

  for (let tupleIndex = 0; tupleIndex < tuples.length; tupleIndex++) {
    const tuple = tuples[tupleIndex];
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
