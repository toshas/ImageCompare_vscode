/** Pure: the packed-thumbnails format a published comparison may list — read by the page, written by the sharing script (docs/standalone.md: packed-thumbs-never-required). */

export const PACKED_THUMBS_FORMAT = 'imagecompare-thumbs-1';

/** The standalone's `thumbnailSize` (the extension's default); a strip thumbnail is decoded at twice it, longest side. */
export const THUMBNAIL_SIZE = 100;

/** JPEG quality of a non-PNG strip thumbnail, on the 1-100 scale. */
export const THUMBNAIL_JPEG_QUALITY = 80;

export type PackedThumbMime = 'image/png' | 'image/jpeg';

export interface PackedThumb {
  mime: PackedThumbMime;
  /** Base64 of the encoded thumbnail. */
  data: string;
}

/** A PNG source keeps a PNG thumbnail (alpha survives); everything else is JPEG. */
export function thumbnailMimeFor(name: string): PackedThumbMime {
  return name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/** One thumbs file's entries keyed by listed path; throws on bad JSON or an unknown format, skips a malformed entry. */
export function parsePackedThumbs(text: string): Map<string, PackedThumb> {
  const parsed = JSON.parse(text) as { format?: unknown; entries?: unknown } | null;
  if (parsed?.format !== PACKED_THUMBS_FORMAT) throw new Error(`not an ${PACKED_THUMBS_FORMAT} file`);
  const entries = parsed.entries;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) throw new Error('no entries');
  const out = new Map<string, PackedThumb>();
  for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
    const e = entry as { mime?: unknown; data?: unknown } | null;
    if ((e?.mime === 'image/png' || e?.mime === 'image/jpeg') && typeof e.data === 'string' && e.data.length > 0) {
      out.set(path, { mime: e.mime, data: e.data });
    }
  }
  return out;
}

/** How long the strip waits on one thumbs file before decoding full images instead. */
const PACKED_THUMBS_TIMEOUT_MS = 20_000;

/** Every listed thumbs file fetched in parallel and merged; one that is missing, unreachable, malformed or slower than `timeoutMs` contributes nothing and never rejects the load (docs/standalone.md: packed-thumbs-never-required). */
export async function loadPackedThumbs(paths: readonly string[], fetchText: (path: string) => Promise<string>, timeoutMs = PACKED_THUMBS_TIMEOUT_MS): Promise<Map<string, PackedThumb>> {
  const withDeadline = (path: string) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${path}: timed out`)), timeoutMs);
    fetchText(path).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const loaded = await Promise.allSettled(paths.map(async path => parsePackedThumbs(await withDeadline(path))));
  const merged = new Map<string, PackedThumb>();
  for (const result of loaded) {
    if (result.status !== 'fulfilled') continue;
    for (const [path, entry] of result.value) merged.set(path, entry);
  }
  return merged;
}

/** The entry's bytes, or null when its base64 does not decode (the caller then decodes the full image). */
export function decodePackedThumb(entry: PackedThumb): Uint8Array | null {
  try {
    const binary = atob(entry.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** UTF-8 byte length, which is what a host's text-file limit counts. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Thumbs files' texts, entries in order, each file within `maxBytes` (null: one file); an entry too big to fit any file is returned in `oversized`, never dropped silently. */
export function packThumbFiles(entries: ReadonlyArray<{ path: string } & PackedThumb>, maxBytes: number | null): { texts: string[]; oversized: string[] } {
  const head = `{"format":${JSON.stringify(PACKED_THUMBS_FORMAT)},"entries":{`;
  const tail = '}}';
  const texts: string[] = [];
  const oversized: string[] = [];
  let parts: string[] = [];
  let size = utf8Length(head) + utf8Length(tail);
  const flush = () => {
    if (parts.length > 0) texts.push(head + parts.join(',') + tail);
    parts = [];
    size = utf8Length(head) + utf8Length(tail);
  };
  for (const entry of entries) {
    const part = `${JSON.stringify(entry.path)}:${JSON.stringify({ mime: entry.mime, data: entry.data })}`;
    const partSize = utf8Length(part);
    const alone = utf8Length(head) + utf8Length(tail) + partSize;
    if (maxBytes !== null && alone > maxBytes) {
      oversized.push(entry.path);
      continue;
    }
    const added = partSize + (parts.length > 0 ? 1 : 0);
    if (maxBytes !== null && size + added > maxBytes) flush();
    size += partSize + (parts.length > 0 ? 1 : 0);
    parts.push(part);
  }
  flush();
  return { texts, oversized };
}
