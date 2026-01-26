import * as vscode from 'vscode';
import { ImageFile, ImageTuple, ScanResult, isImageFile } from './types';

/**
 * Natural sort comparator for filenames
 */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
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

  // Extract a matching key from filename (leading identifier before varying suffixes)
  // e.g., "202505210021_LMU_..." -> "202505210021"
  // e.g., "20251023_#WH768x1024.ppmx" -> "20251023"
  // e.g., "250928_01_#WH768x1024.ppmx" -> "250928_01"
  function extractMatchingKey(filename: string): string {
    // Remove extension
    const baseName = filename.replace(/\.[^.]+$/, '');
    
    // Try to extract leading numeric identifier
    // Match: any sequence of digits, optionally followed by underscore and more digits
    // Examples: "202505210021", "20251023", "250928_01"
    const numericMatch = baseName.match(/^(\d+(?:_\d+)*)/);
    if (numericMatch) {
      return numericMatch[1];
    }
    
    // Try to extract alphanumeric identifier with optional sequence numbers
    // Pattern: letters + optional digits + optional (_digits) groups
    // Examples: "test1", "image_001", "sample_42", "test"
    // This handles both "test1_suffix" -> "test1" and "image_001_suffix" -> "image_001"
    const alphaNumMatch = baseName.match(/^([a-zA-Z]+\d*(?:_\d+)*)/);
    if (alphaNumMatch) {
      return alphaNumMatch[1];
    }
    
    // Fallback: use everything up to first underscore or special character
    const prefixMatch = baseName.match(/^([^_#]+)/);
    if (prefixMatch) {
      return prefixMatch[1];
    }
    
    return baseName;
  }

  // Build a map of matching key -> modality -> file
  const filesByKey: Map<string, Map<string, { name: string; uri: vscode.Uri }>> = new Map();
  
  for (const [modality, files] of modalityFiles.entries()) {
    for (const file of files) {
      const key = extractMatchingKey(file.name);
      
      if (!filesByKey.has(key)) {
        filesByKey.set(key, new Map());
      }
      // If multiple files from same modality have same key, keep the first one
      if (!filesByKey.get(key)!.has(modality)) {
        filesByKey.get(key)!.set(modality, file);
      }
    }
  }

  if (filesByKey.size === 0) {
    return null;
  }

  // Sort keys naturally
  const sortedKeys = Array.from(filesByKey.keys()).sort(naturalSort);

  // Build tuples from matched files
  const tuples: ImageTuple[] = [];
  for (const key of sortedKeys) {
    const filesForTuple = filesByKey.get(key)!;
    const images: ImageFile[] = [];
    const names: string[] = [];

    // Add files in modality order
    for (const modality of modalities) {
      const file = filesForTuple.get(modality);
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
      const tupleName = findCommonSubstring(names) || key;
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
