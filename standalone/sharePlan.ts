/** The sharing script's decisions — layout, limit checks, thumbs packing, publish batches — and its sequence over injected IO (docs/standalone.md, "The sharing script"). */
import * as path from 'path';
import { parseSessionFile } from '../src/sessionFile';
import { disambiguateDirectoryNames } from '../src/modalityNames';
import { isImageFile } from '../src/types';
import { enumeratedImages } from '../src/cropPlan';
import { MODES } from '../src/modePolicy';
import { isPublishedPath } from './publishedPath';
import { hostRegime, HostRegimeName, PublishLimits } from './hostRegimes';
import { PackedThumbMime, packThumbFiles, THUMBNAIL_JPEG_QUALITY, THUMBNAIL_SIZE, thumbnailMimeFor } from './packedThumbs';

export type EntryKind = 'file' | 'dir' | undefined;

/** Everything the flow touches on disk, plus the thumbnail encoder; the script supplies the node implementation (standalone/shareNodeIo.ts). */
export interface ShareIo {
  /** Follows symlinks; undefined when the path does not exist. */
  kind(p: string): Promise<EntryKind>;
  list(dir: string): Promise<Array<{ name: string; kind: EntryKind }>>;
  readText(p: string): Promise<string>;
  size(p: string): Promise<number>;
  /** The encoded thumbnail, longest side at most `maxSide`, never enlarged; null when the source does not decode. */
  thumbnail(source: string, maxSide: number, mime: PackedThumbMime, jpegQuality: number): Promise<Uint8Array | null>;
  mkdirp(dir: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  writeFile(p: string, content: string): Promise<void>;
  removeTree(p: string): Promise<void>;
}

/** A refusal: every violation found, reported together; nothing is staged (docs/standalone.md: pack-refuses-never-alters). */
export class ShareRefusal extends Error {
  constructor(readonly violations: string[]) {
    super(violations.join('\n'));
    this.name = 'ShareRefusal';
  }
}

/** One comparison image: where it is read from and the page-relative path it is published at. */
export interface LayoutImage {
  source: string;
  path: string;
}

export interface ShareLayout {
  /** The comparison's name: the input folder's, or the session file's stem. */
  name: string;
  images: LayoutImage[];
}

const PAGE_NAME = 'image_compare.html';
const MANIFEST_NAME = 'imagecompare.json';
const PLAN_NAME = 'publish-plan.json';
const thumbsFileName = (index: number): string => `imagecompare.thumbs.${index}.json`;

const byPath = (a: LayoutImage, b: LayoutImage) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Two names folding alike are one file on macOS, which ignores case and Unicode normalization, or on Windows, which ignores case. */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/** One image as the input names it, before its names are made safe: an optional column directory and a file name. */
interface RawImage {
  source: string;
  column?: string;
  /** The session label the column name came from, so a refusal can say which label to change. */
  label?: string;
  name: string;
}

/** Each character unsafe in a file or folder name on some OS, or refused by the page's listing rule, and its fixed visual lookalike. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '/': '\u2215',
  ':': '\uA789',
  '\\': '\u29F5',
  '*': '\u2217',
  '?': '\uFF1F',
  '"': '\uFF02',
  '<': '\u2039',
  '>': '\u203A',
  '|': '\u2223',
};

/** A name made safe by the one lookalike table, or null when no substitution can make it so (control character, empty, `.`/`..`, a trailing dot or space). */
function safeSegment(name: string): string | null {
  const safe = [...name].map(c => LOOKALIKES[c] ?? c).join('');
  // eslint-disable-next-line no-control-regex
  if (safe === '' || /[\u0000-\u001f\u007f]/.test(safe) || /[. ]$/.test(safe)) return null;
  return safe;
}

/** Every staged path the page's own listing rule would refuse, named by its source — the deciding check (docs/standalone.md: pack-refuses-never-alters). */
export function unopenablePaths(images: readonly LayoutImage[]): string[] {
  const out: string[] = [];
  for (const img of images) {
    if (!isPublishedPath(img.path)) out.push(`${img.source} would be listed as ${JSON.stringify(img.path)}, which the page refuses to open`);
  }
  return out;
}

async function imagesIn(dir: string, io: ShareIo): Promise<string[]> {
  return (await io.list(dir)).filter(e => e.kind === 'file' && isImageFile(e.name)).map(e => e.name);
}

/** A folder as the extension reads it: image subdirectories are the columns, else its loose images are a flat comparison. */
async function folderLayout(dir: string, io: ShareIo): Promise<RawImage[]> {
  const entries = await io.list(dir);
  const columns: RawImage[] = [];
  for (const sub of entries.filter(e => e.kind === 'dir')) {
    const subDir = path.join(dir, sub.name);
    for (const name of await imagesIn(subDir, io)) columns.push({ source: path.join(subDir, name), column: sub.name, name });
  }
  // Structure wins wherever any subdirectory holds images, as in the extension's scan (docs/session-files.md: subdir-structure-wins).
  if (columns.length > 0) return columns;
  const loose = await imagesIn(dir, io);
  if (loose.length === 0) throw new ShareRefusal([`No images to share in ${dir}: neither image subdirectories nor loose images`]);
  // Loose images open as a file list, which needs two (docs/session-files.md: folder-of-images-is-a-file-list).
  if (loose.length < MODES[3].minColumns) throw new ShareRefusal([`${path.join(dir, loose[0])} is the only image in ${dir}; a comparison needs at least ${MODES[3].minColumns}`]);
  return loose.map(name => ({ source: path.join(dir, name), name }));
}

/** A session resolved as the extension resolves it: one directory as its folder, several as named columns, files flat. */
async function sessionLayout(sessionPath: string, io: ShareIo): Promise<{ images: RawImage[]; fileList: boolean }> {
  let spec;
  try {
    spec = parseSessionFile(await io.readText(sessionPath), path.dirname(sessionPath));
  } catch (err) {
    throw new ShareRefusal([`${sessionPath}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const kinds = await Promise.all(spec.paths.map(p => io.kind(p)));
  // Paths that do not exist are dropped, as the extension's scan drops them.
  const dirs = spec.paths.map((p, i) => ({ path: p, label: spec.labels?.[i] })).filter((_, i) => kinds[i] === 'dir');
  const files = spec.paths.filter((_, i) => kinds[i] === 'file');
  if (dirs.length > 0 && files.length > 0) throw new ShareRefusal(['Cannot mix files and directories in one session']);
  if (dirs.length === 1) return { images: await folderLayout(dirs[0].path, io), fileList: false };
  if (dirs.length >= 2) {
    // Named over the '/'-separated path a vscode Uri carries, so a Windows path derives the same name.
    const named = disambiguateDirectoryNames(dirs.map(d => ({ ...d, path: process.platform === 'win32' ? d.path.replace(/\\/g, '/') : d.path, source: d.path })));
    const images: RawImage[] = [];
    const imageless: string[] = [];
    for (const { name: derived, uri: dir } of named) {
      const column = dir.label ?? derived;
      const names = await imagesIn(dir.source, io);
      if (names.length === 0) imageless.push(dir.source);
      for (const name of names) images.push({ source: path.join(dir.source, name), column, label: dir.label, name });
    }
    // Staged, the columns would open as one folder, which runs at one column; the extension refuses the session (docs/session-files.md: mode-behaviour-is-a-table).
    const imageful = named.length - imageless.length;
    if (imageful < MODES[2].minColumns) {
      throw new ShareRefusal([`Only ${imageful} of the session's directories holds images, and a comparison of directories needs at least ${MODES[2].minColumns}; without images: ${imageless.join(', ')}`]);
    }
    return { images, fileList: false };
  }
  const flat = files.filter(f => isImageFile(f));
  if (flat.length === 0) throw new ShareRefusal([`${sessionPath}: lists no existing images or directories`]);
  return { images: flat.map(f => ({ source: f, name: path.basename(f) })), fileList: true };
}

/** The raw layout with every segment made safe, or a refusal naming each source the table cannot place, each collision it would cause, and anything the page would still refuse (docs/standalone.md, "The sharing script"). */
function safeLayout(raw: readonly RawImage[]): LayoutImage[] {
  const problems: string[] = [];
  const columnOf = new Map<string, string>();
  const images: LayoutImage[] = [];
  for (const img of raw) {
    const name = safeSegment(img.name);
    const column = img.column === undefined ? undefined : safeSegment(img.column);
    if (name === null) problems.push(`${img.source}: the file name ${JSON.stringify(img.name)} cannot be made a safe file name`);
    if (column === null) {
      const fix = img.label !== undefined ? `; change the session label ${JSON.stringify(img.label)}` : '';
      problems.push(`${img.source}: the column name ${JSON.stringify(img.column)} cannot be made a safe folder name${fix}`);
    }
    if (name === null || column === null) continue;
    if (column !== undefined) {
      const earlier = columnOf.get(folded(column));
      if (earlier !== undefined && earlier !== img.column) {
        problems.push(`Columns ${JSON.stringify(earlier)} and ${JSON.stringify(img.column)} would share the folder ${JSON.stringify(column)}${img.label !== undefined ? '; change a session label' : ''}`);
        continue;
      }
      columnOf.set(folded(column), img.column!);
    }
    images.push({ source: img.source, path: column === undefined ? name : `${column}/${name}` });
  }
  const bySafePath = new Map<string, { path: string; sources: string[] }>();
  for (const img of images) {
    const at = bySafePath.get(folded(img.path)) ?? { path: img.path, sources: [] };
    at.sources.push(img.source);
    bySafePath.set(folded(img.path), at);
  }
  for (const { path: p, sources } of bySafePath.values()) {
    if (sources.length > 1) problems.push(`${sources.length} files would be staged at the same path ${p}: ${sources.join(', ')}`);
  }
  problems.push(...unopenablePaths(images));
  if (problems.length > 0) throw new ShareRefusal([...new Set(problems)]);
  return images;
}

/** A file list is staged flat, which the page reads as a folder of loose images: refused unless that reading keeps every file (docs/session-files.md: folder-of-images-is-a-file-list). */
function fileListProblems(images: readonly LayoutImage[]): string[] {
  const kept = new Set(enumeratedImages(images.map(img => ({ name: img.path }))).map(f => f.name));
  const dropped = images.filter(img => !kept.has(img.path));
  if (dropped.length > 0) return [`The page reads a flat file list as a folder of loose images and would set aside ${dropped.length} of them: ${dropped.map(img => img.source).join(', ')}`];
  if (images.length < MODES[3].minColumns) return [`A file list needs at least ${MODES[3].minColumns} images; the page would not open ${images.length}`];
  return [];
}

/** What gets shared from `input` (a folder, or a `.imagecompare` session) and under which name. */
export async function planLayout(input: string, io: ShareIo): Promise<ShareLayout> {
  const kind = await io.kind(input);
  if (kind === 'dir') return { name: path.basename(path.resolve(input)), images: safeLayout(await folderLayout(input, io)).sort(byPath) };
  if (kind === 'file' && input.toLowerCase().endsWith('.imagecompare')) {
    const session = await sessionLayout(input, io);
    const images = safeLayout(session.images).sort(byPath);
    const problems = session.fileList ? fileListProblems(images) : [];
    if (problems.length > 0) throw new ShareRefusal(problems);
    return { name: path.basename(input).replace(/\.imagecompare$/i, ''), images };
  }
  throw new ShareRefusal([kind === undefined ? `No such file or folder: ${input}` : `Not a folder or a .imagecompare session: ${input}`]);
}

/** One staged file with its size; `kind` decides which limits it is held to. */
export interface StagedFile {
  path: string;
  bytes: number;
  kind: 'page' | 'manifest' | 'thumbs' | 'image';
}

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
const listed = (files: ReadonlyArray<{ path: string; bytes?: number }>): string =>
  files.map(f => (f.bytes === undefined ? f.path : `${f.path} (${mb(f.bytes)})`)).join(', ');

/** Every limit the regime's row sets that the staged set exceeds, each naming the limit, the measured value and the offending files (docs/standalone.md: pack-refuses-never-alters). */
export function limitViolations(files: readonly StagedFile[], limits: PublishLimits | null): string[] {
  if (!limits) return [];
  const out: string[] = [];
  const images = files.filter(f => f.kind === 'image');
  const texts = files.filter(f => f.kind !== 'image');
  const unserved = images.filter(f => !limits.imageExtensions.includes(path.extname(f.path).toLowerCase()));
  if (unserved.length > 0) {
    out.push(`${unserved.length} image(s) of a type this host does not serve (it serves ${limits.imageExtensions.join(' ')}): ${listed(unserved.map(f => ({ path: f.path })))}`);
  }
  const bigImages = images.filter(f => f.bytes > limits.maxBytesPerImage);
  if (bigImages.length > 0) out.push(`${bigImages.length} image(s) over the ${mb(limits.maxBytesPerImage)} per-image limit: ${listed(bigImages)}`);
  const bigTexts = texts.filter(f => f.bytes > limits.maxBytesPerTextFile);
  if (bigTexts.length > 0) out.push(`${bigTexts.length} text file(s) over the ${mb(limits.maxBytesPerTextFile)} per-text-file limit: ${listed(bigTexts)}`);
  if (files.length > limits.maxFilesPerVersion) {
    out.push(`${files.length} files (${texts.length} page/manifest/thumbs + ${images.length} images) exceed the ${limits.maxFilesPerVersion}-file limit per published version`);
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > limits.maxBytesPerVersion) out.push(`${mb(total)} in total exceeds the ${mb(limits.maxBytesPerVersion)} limit per published version`);
  const textBytes = texts.reduce((n, f) => n + f.bytes, 0);
  if (texts.length > limits.maxFilesPerPublish || textBytes > limits.maxBytesPerPublish) {
    out.push(`The page, manifest and thumbs files alone (${texts.length} files, ${mb(textBytes)}) exceed one publish call (${limits.maxFilesPerPublish} files, ${mb(limits.maxBytesPerPublish)}): ${listed(texts)}`);
  }
  return out;
}

/** Ordered publish batches, each within the per-publish caps; the page, manifest and thumbs lead the first, and every later batch starts with the page again, since each publish call sends it (null limits: one batch). */
export function planBatches(files: readonly StagedFile[], limits: PublishLimits | null): Array<Array<{ path: string; bytes: number }>> {
  const ordered = [...files.filter(f => f.kind !== 'image'), ...files.filter(f => f.kind === 'image')];
  const page = files.filter(f => f.kind === 'page').map(f => ({ path: f.path, bytes: f.bytes }));
  const batches: Array<Array<{ path: string; bytes: number }>> = [];
  let current: Array<{ path: string; bytes: number }> = [];
  let bytes = 0;
  for (const f of ordered) {
    const full = limits && (current.length + 1 > limits.maxFilesPerPublish || bytes + f.bytes > limits.maxBytesPerPublish);
    if (full && current.length > 0) {
      batches.push(current);
      current = [...page];
      bytes = page.reduce((n, p) => n + p.bytes, 0);
    }
    current.push({ path: f.path, bytes: f.bytes });
    bytes += f.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page with its `<title>` set to the comparison's name; nothing else in it changes. */
export function setPageTitle(html: string, title: string): string {
  const match = /<title>[^<]*<\/title>/.exec(html);
  if (!match) throw new Error(`${PAGE_NAME} has no <title> to set`);
  return html.substring(0, match.index) + `<title>${escapeHtml(title)}</title>` + html.substring(match.index + match[0].length);
}

export interface ShareOptions {
  input: string;
  out: string;
  host: HostRegimeName;
  title?: string;
  /** The built standalone page's text. */
  pageHtml: string;
  base64(bytes: Uint8Array): string;
}

export interface ShareSummary {
  name: string;
  host: HostRegimeName;
  images: number;
  imageBytes: number;
  thumbsFiles: number;
  /** Listed images the thumbnail encoder could not decode; they decode in the page instead. */
  thumbless: string[];
  batches: number;
  totalBytes: number;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Thumbnails for the listed images, a few at a time. */
async function makeThumbs(images: readonly LayoutImage[], io: ShareIo, base64: (b: Uint8Array) => string): Promise<{ entries: Array<{ path: string; mime: PackedThumbMime; data: string }>; thumbless: string[] }> {
  const results: Array<{ path: string; mime: PackedThumbMime; data: string } | null> = new Array(images.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < images.length; i = next++) {
      const mime = thumbnailMimeFor(images[i].path);
      // The strip's own decode target, single-sourced with the page (docs/standalone.md: packed-thumbs-never-required).
      const bytes = await io.thumbnail(images[i].source, THUMBNAIL_SIZE * 2, mime, THUMBNAIL_JPEG_QUALITY).catch(() => null);
      if (bytes) results[i] = { path: images[i].path, mime, data: base64(bytes) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, images.length) }, worker));
  return {
    entries: results.filter((r): r is NonNullable<typeof r> => r !== null),
    thumbless: images.filter((_, i) => results[i] === null).map(img => img.path),
  };
}

/** The whole share: check `--out`, lay out, measure, check every limit, and only then stage — refusing changes nothing (docs/standalone.md: pack-refuses-never-alters). */
export async function shareComparison(options: ShareOptions, io: ShareIo): Promise<ShareSummary> {
  const early: string[] = [];
  const outKind = await io.kind(options.out);
  if (outKind === 'file') early.push(`--out ${options.out} is a file, not a folder`);
  if (outKind === 'dir' && (await io.list(options.out)).length > 0) early.push(`--out ${options.out} is not empty`);

  // Limits come from the regime's row and nowhere else (docs/standalone.md: host-regime-is-one-table).
  const limits = hostRegime(options.host).limits;
  let layout: ShareLayout;
  try {
    layout = await planLayout(options.input, io);
  } catch (err) {
    if (err instanceof ShareRefusal) throw new ShareRefusal([...early, ...err.violations]);
    throw err;
  }
  const sizes = await Promise.all(layout.images.map(img => io.size(img.source)));
  const page = setPageTitle(options.pageHtml, options.title ?? layout.name);
  const manifestFor = (thumbsNames: readonly string[]) =>
    `${JSON.stringify({ files: layout.images.map(img => img.path), host: options.host, ...(thumbsNames.length > 0 ? { thumbs: thumbsNames } : {}) }, null, 1)}\n`;
  const pageFile: StagedFile = { path: PAGE_NAME, bytes: utf8Bytes(page), kind: 'page' };
  const imageFiles = layout.images.map((img, i): StagedFile => ({ path: img.path, bytes: sizes[i], kind: 'image' }));

  // Every type, count, size and name check runs before any thumbnail is built, so a refusal is immediate.
  const before = [...early, ...limitViolations([pageFile, { path: MANIFEST_NAME, bytes: utf8Bytes(manifestFor([])), kind: 'manifest' }, ...imageFiles], limits)];
  if (before.length > 0) throw new ShareRefusal(before);

  const thumbs = await makeThumbs(layout.images, io, options.base64);
  const packed = packThumbFiles(thumbs.entries, limits ? limits.maxBytesPerTextFile : null);
  const thumbsNames = packed.texts.map((_, i) => thumbsFileName(i));
  const manifest = manifestFor(thumbsNames);
  const staged: StagedFile[] = [
    pageFile,
    { path: MANIFEST_NAME, bytes: utf8Bytes(manifest), kind: 'manifest' },
    ...packed.texts.map((text, i) => ({ path: thumbsNames[i], bytes: utf8Bytes(text), kind: 'thumbs' as const })),
    ...imageFiles,
  ];
  // Thumbs files count and weigh too: the same limits again, now with them in.
  const violations = limitViolations(staged, limits);
  if (packed.oversized.length > 0) violations.push(`${packed.oversized.length} thumbnail(s) too large for any thumbs file: ${packed.oversized.join(', ')}`);
  if (violations.length > 0) throw new ShareRefusal(violations);

  const batches = planBatches(staged, limits);
  const plan = { host: options.host, page: PAGE_NAME, batches: batches.map(files => ({ files, bytes: files.reduce((n, f) => n + f.bytes, 0) })) };

  const createdOut = outKind === undefined;
  try {
    await io.mkdirp(options.out);
    await io.writeFile(path.join(options.out, PAGE_NAME), page);
    await io.writeFile(path.join(options.out, MANIFEST_NAME), manifest);
    for (let i = 0; i < packed.texts.length; i++) await io.writeFile(path.join(options.out, thumbsNames[i]), packed.texts[i]);
    for (const img of layout.images) {
      const dest = path.join(options.out, ...img.path.split('/'));
      await io.mkdirp(path.dirname(dest));
      // Byte for byte: the image is copied, never decoded or re-encoded (docs/standalone.md: pack-refuses-never-alters).
      await io.copyFile(img.source, dest);
    }
    await io.writeFile(path.join(options.out, PLAN_NAME), `${JSON.stringify(plan, null, 1)}\n`);
  } catch (err) {
    // A failed stage leaves --out as it found it: absent, or empty.
    if (createdOut) await io.removeTree(options.out).catch(() => undefined);
    else for (const e of await io.list(options.out).catch(() => [])) await io.removeTree(path.join(options.out, e.name)).catch(() => undefined);
    throw err;
  }

  return {
    name: layout.name,
    host: options.host,
    images: layout.images.length,
    imageBytes: sizes.reduce((n, b) => n + b, 0),
    thumbsFiles: packed.texts.length,
    thumbless: thumbs.thumbless,
    batches: batches.length,
    totalBytes: staged.reduce((n, f) => n + f.bytes, 0),
  };
}
