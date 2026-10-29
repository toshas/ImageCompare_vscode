/**
 * The published-comparison backend (docs/standalone.md: published-comparison-opens-itself):
 * imagecompare.json is a listing of relative paths that stands in for a dropped folder. These tests
 * import the REAL standalone/fsBackends.ts; the end-to-end boot (one fetch, landing kept without a
 * manifest, the shared scanner over the listing) is pinned by the webview standalone spec.
 */
import { describe, it, expect } from 'vitest';

interface PublishedFs {
  writable: boolean;
  readDirectory(path: string): Promise<Array<[string, number]>>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

// Runtime-computed on purpose, as in sweepHostEquivalence.test.ts: standalone/ compiles under
// tsconfig.standalone.json (DOM lib), so a literal specifier would drag it into tsconfig.test.json.
const backendsModule = '../../standalone/fsBackends';
const shimModule = '../../standalone/shims/vscode';
const { createPublishedBackend, parsePublishedManifest } = await import(backendsModule) as {
  parsePublishedManifest(text: string): { files: string[]; host: string; thumbs: string[] };
  createPublishedBackend(files: readonly string[], fetchFile: (path: string) => Promise<ArrayBuffer>): { fs: PublishedFs; rootPath: string; isReadOnly(path: string): boolean };
};
const { FileType } = await import(shimModule) as { FileType: { File: number; Directory: number } };

describe('parsePublishedManifest', () => {
  it('returns the listed relative paths in manifest order', () => {
    const files = ['gt/scene_01.png', 'pred/scene_01.png', 'gt/scene 02.png'];
    expect(parsePublishedManifest(JSON.stringify({ files })).files).toEqual(files);
  });

  // docs/standalone.md: host-regime-is-one-table — absent is static; anything the table lacks is
  // reported, never defaulted to a row the manifest did not name.
  it('reads the hosting regime, absent meaning static', () => {
    expect(parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'] })).host).toBe('static');
    expect(parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], host: 'static' })).host).toBe('static');
    expect(parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], host: 'claude-artifact' })).host).toBe('claude-artifact');
  });

  it('reports a host the regime table does not know instead of opening', () => {
    for (const host of ['github-pages', 'Claude-Artifact', '', 'constructor', '__proto__', 7, null]) {
      expect(() => parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], host })))
        .toThrow(/^imagecompare\.json: unknown "host"/);
    }
  });

  it('reads the thumbs list, absent meaning none', () => {
    expect(parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'] })).thumbs).toEqual([]);
    expect(parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], thumbs: ['imagecompare.thumbs.0.json', 'more/t 1.json'] })).thumbs)
      .toEqual(['imagecompare.thumbs.0.json', 'more/t 1.json']);
  });

  it('reports a thumbs list that is empty, not a list, or leaves the page directory', () => {
    for (const thumbs of [[], 'imagecompare.thumbs.0.json', {}]) {
      expect(() => parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], thumbs }))).toThrow(/^imagecompare\.json: "thumbs" must list files/);
    }
    for (const bad of ['../t.json', './t.json', '/t.json', 'https://example.com/t.json', 'a\\t.json', 7]) {
      expect(() => parsePublishedManifest(JSON.stringify({ files: ['gt/a.png'], thumbs: ['t.json', bad] })))
        .toThrow(/^imagecompare\.json: not a relative path/);
    }
  });

  it('rejects a manifest with no files', () => {
    expect(() => parsePublishedManifest('{"files": []}')).toThrow(/^imagecompare\.json: must list "files"/);
    expect(() => parsePublishedManifest('{}')).toThrow(/^imagecompare\.json: must list "files"/);
    expect(() => parsePublishedManifest('null')).toThrow(/^imagecompare\.json: must list "files"/);
    expect(() => parsePublishedManifest('{"files": "gt/a.png"}')).toThrow(/^imagecompare\.json: must list "files"/);
  });

  it('rejects paths that leave the page directory', () => {
    for (const bad of ['../gt/a.png', 'gt/../../a.png', './gt/a.png', 'gt/./a.png', '/gt/a.png', 'https://example.com/a.png', 'gt\\a.png', 'gt//a.png', 7]) {
      expect(() => parsePublishedManifest(JSON.stringify({ files: ['gt/ok.png', bad] }))).toThrow(/^imagecompare\.json: not a relative path/);
    }
  });

  it('reports a page that is not JSON as a parse failure, not a comparison', () => {
    expect(() => parsePublishedManifest('<!DOCTYPE html><html></html>')).toThrow(/^imagecompare\.json: not valid JSON$/);
  });
});

describe('createPublishedBackend', () => {
  const files = ['gt/scene_01.png', 'gt/scene_02.png', 'pred/scene_01.png'];

  it('lists the manifest as a folder whose subdirectories are the columns', async () => {
    const root = createPublishedBackend(files, async () => new ArrayBuffer(0));
    expect(root.rootPath).toBe('/comparison');
    expect((await root.fs.readDirectory('/comparison')).sort()).toEqual([
      ['gt', FileType.Directory],
      ['pred', FileType.Directory],
    ]);
    expect((await root.fs.readDirectory('/comparison/gt')).sort()).toEqual([
      ['scene_01.png', FileType.File],
      ['scene_02.png', FileType.File],
    ]);
  });

  it('reads each file through the injected fetch by its manifest-relative path, lazily, not at listing time', async () => {
    const fetched: string[] = [];
    const root = createPublishedBackend(files, async (path) => {
      fetched.push(path);
      return new Uint8Array([path.length]).buffer;
    });
    expect(fetched).toEqual([]);
    expect(Array.from(await root.fs.readFile('/comparison/pred/scene_01.png'))).toEqual(['pred/scene_01.png'.length]);
    expect(fetched).toEqual(['pred/scene_01.png']);
  });

  it('is read-only: nothing a published page lists can be written or deleted', async () => {
    const root = createPublishedBackend(files, async () => new ArrayBuffer(0));
    expect(root.fs.writable).toBe(false);
    expect(root.isReadOnly('/comparison/gt/scene_01.png')).toBe(true);
    await expect(root.fs.writeFile('/comparison/results.txt', new Uint8Array([1]))).rejects.toThrow(/read-only/);
    await expect(root.fs.delete('/comparison/gt/scene_01.png')).rejects.toThrow(/read-only/);
  });
});

describe('hosting regimes (standalone/hostRegimes.ts, real code)', async () => {
  const { HOST_REGIMES, DEFAULT_HOST_REGIME, hostRegime } = await import('../../standalone/hostRegimes');

  // Literals from the contract and the 2026-10-28 probe (docs/standalone.md, "Publishing a
  // comparison"), not read back from the table: a changed flag or limit shows up here as a diff.
  it('states the flags a published page offers per regime', () => {
    expect(DEFAULT_HOST_REGIME).toBe('static');
    expect(HOST_REGIMES.static.capabilities).toEqual({ exportPptx: true, copyResults: true });
    expect(HOST_REGIMES['claude-artifact'].capabilities).toEqual({ exportPptx: false, copyResults: true });
    expect(Object.keys(HOST_REGIMES).sort()).toEqual(['claude-artifact', 'static']);
  });

  it('holds the claude-artifact publish limits, decimal megabytes', () => {
    expect(HOST_REGIMES.static.limits).toBeNull();
    expect(HOST_REGIMES['claude-artifact'].limits).toEqual({
      imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
      maxFilesPerVersion: 511,
      maxBytesPerVersion: 256_000_000,
      maxBytesPerImage: 15_000_000,
      maxBytesPerTextFile: 16_000_000,
      maxFilesPerPublish: 255,
      maxBytesPerPublish: 64_000_000,
    });
  });

  it('throws for a regime it does not have rather than defaulting', () => {
    expect(hostRegime('claude-artifact')).toBe(HOST_REGIMES['claude-artifact']);
    expect(() => hostRegime('netlify')).toThrow(/unknown host "netlify"/);
    expect(() => hostRegime('toString')).toThrow(/unknown host/);
  });
});
