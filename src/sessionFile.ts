import * as path from 'path';

/**
 * Parsed .imagecompare session file.
 * Format: JSON {"paths": [...], "labels"?: [...], "colors"?: [...]}
 * Relative paths are resolved against the session file's directory.
 * Labels and colors are aligned with paths; labels override modality display
 * names and colors override modality pill colors (multi-directory mode only).
 */
export interface SessionSpec {
  paths: string[];
  labels?: string[];
  colors?: string[];
}

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parseSessionFile(text: string, baseDir: string): SessionSpec {
  let parsed: { paths?: unknown; labels?: unknown; colors?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON. Expected {"paths": ["/abs/dir_or_image", ...], "labels"?: [...], "colors"?: [...]}');
  }

  const rawPaths = parsed?.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 ||
      !rawPaths.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error('"paths" must be a non-empty array of non-empty strings');
  }
  const paths = rawPaths.map((p) => path.resolve(baseDir, p));

  const spec: SessionSpec = { paths };

  const labels = parsed.labels;
  if (labels !== undefined) {
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string' && l.length > 0)) {
      throw new Error('"labels" must be an array of non-empty strings');
    }
    if (labels.length !== paths.length) {
      throw new Error(`"labels" length (${labels.length}) must match "paths" length (${paths.length})`);
    }
    if (new Set(labels).size !== labels.length) {
      throw new Error('"labels" must be unique');
    }
    spec.labels = labels;
  }

  const colors = parsed.colors;
  if (colors !== undefined) {
    if (!Array.isArray(colors) || !colors.every((c) => typeof c === 'string' && COLOR_RE.test(c))) {
      throw new Error('"colors" must be an array of hex colors (#rgb or #rrggbb)');
    }
    if (colors.length !== paths.length) {
      throw new Error(`"colors" length (${colors.length}) must match "paths" length (${paths.length})`);
    }
    spec.colors = colors;
  }

  return spec;
}

// Generic names that make poor session file names
const GENERIC_NAMES = new Set([
  'image', 'images', 'img', 'imgs', 'photo', 'photos', 'pic', 'pics', 'picture', 'pictures',
  'file', 'files', 'folder', 'folders', 'dir', 'directory', 'directories',
  'data', 'output', 'input', 'result', 'results', 'test', 'tests', 'tmp', 'temp',
  'new', 'old', 'copy', 'backup', 'untitled', 'unnamed'
]);

function isGenericName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[\s_\-./\\0-9]+/g, '');
  return GENERIC_NAMES.has(lower) || lower.length < 2;
}

function findCommonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0];
  for (let i = 1; i < names.length && prefix.length > 0; i++) {
    while (prefix.length > 0 && !names[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix.replace(/[\s_\-./\\]+$/, '').trim();
}

/**
 * Suggest a session file name (without extension) from the selection's
 * display names (directory basenames, or file basenames without extension).
 * The name becomes the editor tab title, so prefer the meaningful common
 * prefix over generic fallbacks.
 */
export function suggestSessionFileName(names: string[]): string {
  let base: string;
  if (names.length === 1) {
    base = names[0];
  } else {
    const prefix = findCommonPrefix(names);
    base = prefix.length >= 3 && !isGenericName(prefix) ? prefix : `compare_${names.length}`;
  }
  base = base.replace(/[^\w.@+-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  if (base.length > 60) {
    base = base.slice(0, 60).replace(/[._-]+$/g, '');
  }
  return base.length >= 2 ? base : 'comparison';
}

/**
 * Override directory display names with user-provided labels, keyed by URI string.
 * Structural typing keeps this vscode-free for standalone tests.
 */
export function applyLabels<T extends { toString(): string }>(
  dirs: Array<{ name: string; uri: T }>,
  labels?: Map<string, string>
): Array<{ name: string; uri: T }> {
  if (!labels) {
    return dirs;
  }
  return dirs.map((d) => ({ name: labels.get(d.uri.toString()) ?? d.name, uri: d.uri }));
}
