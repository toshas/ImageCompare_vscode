/** Pure, vscode-free core of the .imagecompare format — keep it importable by ts-node tests (docs/session-files.md: sessionfile-vscode-free). */
import * as path from 'path';

/** Parsed .imagecompare session file; format and semantics: docs/session-files.md. */
export interface SessionSpec {
  paths: string[];
  labels?: string[];
  colors?: string[];
}

/** Highest format version this build understands; bump only on semantic changes (docs/session-files.md: version-gate-forward). */
export const CURRENT_SESSION_VERSION = 1;

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parseSessionFile(text: string, baseDir: string): SessionSpec {
  let parsed: { version?: unknown; paths?: unknown; labels?: unknown; colors?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON. Expected {"paths": ["/abs/dir_or_image", ...], "labels"?: [...], "colors"?: [...]}');
  }

  // A half-understood file must be rejected, not half-opened (docs/session-files.md: version-gate-forward).
  const version = parsed?.version;
  if (version !== undefined) {
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new Error('"version" must be a positive integer');
    }
    if ((version as number) > CURRENT_SESSION_VERSION) {
      throw new Error(`This session file is version ${version}; this build of ImageCompare supports up to ${CURRENT_SESSION_VERSION}. Update the extension.`);
    }
  }

  const rawPaths = parsed?.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 ||
      !rawPaths.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error('"paths" must be a non-empty array of non-empty strings');
  }
  // baseDir is the session file's directory, never workspace root or cwd (docs/session-files.md: relative-to-session-dir).
  const paths = rawPaths.map((p) => path.resolve(baseDir, p));

  /* A repeated path puts two modalities on one URI; every URI-keyed lookup then resolves both to the first (docs/session-files.md: unique-modality-names). */
  /* win32 only: APFS is frequently case-sensitive, so folding there would reject two real directories. */
  const compared = process.platform === 'win32' ? paths.map(p => p.toLowerCase()) : paths;
  if (new Set(compared).size !== compared.length) {
    throw new Error('"paths" must not repeat the same location');
  }

  const spec: SessionSpec = { paths };

  const labels = parsed.labels;
  if (labels !== undefined) {
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string' && l.length > 0)) {
      throw new Error('"labels" must be an array of non-empty strings');
    }
    if (labels.length !== paths.length) {
      throw new Error(`"labels" length (${labels.length}) must match "paths" length (${paths.length})`);
    }
    // A modality name is the downstream join key; duplicates would silently merge modalities (docs/session-files.md: aligned-unique-labels).
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

/**
 * Serialize a session for saving at destDir. Paths are relativized only when every compared root
 * lies inside destDir; one escapee keeps all absolute (docs/session-files.md: saveas-relative-only-inside).
 */
export function serializeSessionFile(
  absPaths: string[],
  destDir: string,
  labels?: string[],
  colors?: string[]
): string {
  const rels = absPaths.map((p) => {
    const rel = path.relative(destDir, p);
    return rel === '' ? '.' : rel;
  });
  const escapes = rels.some((r) => r.startsWith('..') || path.isAbsolute(r));
  const out: { version: number; paths: string[]; labels?: string[]; colors?: string[] } = {
    version: CURRENT_SESSION_VERSION,
    paths: escapes ? absPaths : rels
  };
  if (labels) out.labels = labels;
  if (colors) out.colors = colors;
  return JSON.stringify(out, null, 2) + '\n';
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

/** Session file name (no extension) from selection display names — it is the tab title (docs/session-files.md: filename-is-tab-title). */
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

/** Override directory display names with labels keyed by URI string (structurally typed to stay vscode-free). */
export function applyLabels<T extends { toString(): string }>(
  dirs: Array<{ name: string; uri: T }>,
  labels?: Map<string, string>
): Array<{ name: string; uri: T }> {
  if (!labels) {
    return dirs;
  }
  return dirs.map((d) => ({ name: labels.get(d.uri.toString()) ?? d.name, uri: d.uri }));
}
