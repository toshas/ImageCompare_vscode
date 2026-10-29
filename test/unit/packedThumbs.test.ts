/**
 * Packed thumbnails (docs/standalone.md: packed-thumbs-never-required): the format the sharing
 * script writes and the page reads, and the load that never fails the strip. Imports the REAL
 * standalone/packedThumbs.ts; the adapter's use of it (no image request for a packed strip, the
 * full-image fallback) is pinned end to end in test/webview/standalone-build.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  PACKED_THUMBS_FORMAT,
  decodePackedThumb,
  loadPackedThumbs,
  packThumbFiles,
  parsePackedThumbs,
  thumbnailMimeFor,
} from '../../standalone/packedThumbs';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const file = (entries: Record<string, unknown>, format: unknown = 'imagecompare-thumbs-1') => JSON.stringify({ format, entries });

describe('packed thumbs format', () => {
  it('is the documented format name', () => {
    expect(PACKED_THUMBS_FORMAT).toBe('imagecompare-thumbs-1');
  });

  it('parses entries keyed by listed path', () => {
    const parsed = parsePackedThumbs(file({
      'gt/a.png': { mime: 'image/png', data: b64([1, 2]) },
      'pred/a b.jpg': { mime: 'image/jpeg', data: b64([3]) },
    }));
    expect([...parsed.keys()]).toEqual(['gt/a.png', 'pred/a b.jpg']);
    expect(Array.from(decodePackedThumb(parsed.get('gt/a.png')!)!)).toEqual([1, 2]);
    expect(parsed.get('pred/a b.jpg')!.mime).toBe('image/jpeg');
  });

  it('refuses an unknown format or a file that is not one', () => {
    expect(() => parsePackedThumbs(file({}, 'imagecompare-thumbs-2'))).toThrow();
    expect(() => parsePackedThumbs(JSON.stringify({ entries: {} }))).toThrow();
    expect(() => parsePackedThumbs('<!DOCTYPE html>')).toThrow();
    expect(() => parsePackedThumbs(JSON.stringify({ format: 'imagecompare-thumbs-1', entries: [] }))).toThrow();
  });

  it('skips an entry with a mime it does not serve or no data, keeping the rest', () => {
    const parsed = parsePackedThumbs(file({
      'a.png': { mime: 'image/gif', data: b64([1]) },
      'b.png': { mime: 'image/png' },
      'c.png': { mime: 'image/png', data: '' },
      'd.png': null,
      'e.png': { mime: 'image/png', data: b64([5]) },
    }));
    expect([...parsed.keys()]).toEqual(['e.png']);
  });

  it('decodes bad base64 to null, so the caller decodes the full image', () => {
    expect(decodePackedThumb({ mime: 'image/png', data: '%%% not base64' })).toBeNull();
  });

  it('keeps a PNG source a PNG thumbnail and makes everything else JPEG', () => {
    expect(thumbnailMimeFor('gt/a.PNG')).toBe('image/png');
    expect(thumbnailMimeFor('gt/a.jpg')).toBe('image/jpeg');
    expect(thumbnailMimeFor('gt/a.webp')).toBe('image/jpeg');
  });
});

describe('packed thumbs load: never required', () => {
  it('merges every listed file, fetched in parallel', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const texts: Record<string, string> = {
      't0.json': file({ 'gt/a.png': { mime: 'image/png', data: b64([1]) } }),
      't1.json': file({ 'pred/a.png': { mime: 'image/png', data: b64([2]) } }),
    };
    const loading = loadPackedThumbs(['t0.json', 't1.json'], async path => {
      started.push(path);
      await gate;
      return texts[path];
    });
    await Promise.resolve();
    expect(started).toEqual(['t0.json', 't1.json']);
    release();
    expect([...(await loading).keys()].sort()).toEqual(['gt/a.png', 'pred/a.png']);
  });

  it('drops a missing, malformed or unknown-format file and keeps the others', async () => {
    const loaded = await loadPackedThumbs(['missing.json', 'html.json', 'v2.json', 'good.json'], async path => {
      if (path === 'missing.json') throw new Error('missing.json: HTTP 404');
      if (path === 'html.json') return '<!DOCTYPE html><html></html>';
      if (path === 'v2.json') return file({ 'gt/b.png': { mime: 'image/png', data: b64([9]) } }, 'imagecompare-thumbs-2');
      return file({ 'gt/a.png': { mime: 'image/png', data: b64([1]) } });
    });
    expect([...loaded.keys()]).toEqual(['gt/a.png']);
  });

  it('gives up on a file that never answers instead of stalling the strip', async () => {
    const loaded = await loadPackedThumbs(['hangs.json', 'good.json'], path =>
      path === 'hangs.json' ? new Promise<string>(() => undefined) : Promise.resolve(file({ 'gt/a.png': { mime: 'image/png', data: b64([1]) } })), 30);
    expect([...loaded.keys()]).toEqual(['gt/a.png']);
  });

  it('resolves empty when nothing is listed', async () => {
    expect((await loadPackedThumbs([], async () => { throw new Error('never called'); })).size).toBe(0);
  });
});

describe('packed thumbs files: split within a text-file limit', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ path: `gt/scene_${i}.png`, mime: 'image/png' as const, data: 'A'.repeat(100) }));

  it('writes one file with no limit, entries in order, parseable as the page parses it', () => {
    const { texts, oversized } = packThumbFiles(entries, null);
    expect(oversized).toEqual([]);
    expect(texts).toHaveLength(1);
    expect([...parsePackedThumbs(texts[0]).keys()]).toEqual(entries.map(e => e.path));
  });

  it('splits so every file is within the limit, losing no entry', () => {
    const limit = 400;
    const { texts, oversized } = packThumbFiles(entries, limit);
    expect(oversized).toEqual([]);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(limit);
    expect(texts.flatMap(t => [...parsePackedThumbs(t).keys()])).toEqual(entries.map(e => e.path));
  });

  it('measures the limit in UTF-8 bytes, not characters', () => {
    const wide = [{ path: 'gt/场景_1.png', mime: 'image/png' as const, data: 'A'.repeat(50) }, { path: 'gt/场景_2.png', mime: 'image/png' as const, data: 'A'.repeat(50) }];
    const one = packThumbFiles(wide, null).texts[0];
    const limit = new TextEncoder().encode(one).length - 1;
    expect(one.length).toBeLessThanOrEqual(limit);
    const { texts } = packThumbFiles(wide, limit);
    expect(texts).toHaveLength(2);
  });

  it('reports an entry too big for any file instead of dropping it', () => {
    const { texts, oversized } = packThumbFiles([...entries.slice(0, 2), { path: 'gt/huge.png', mime: 'image/png', data: 'A'.repeat(1000) }], 400);
    expect(oversized).toEqual(['gt/huge.png']);
    expect(texts.flatMap(t => [...parsePackedThumbs(t).keys()])).toEqual(['gt/scene_0.png', 'gt/scene_1.png']);
  });
});
