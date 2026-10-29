/**
 * The per-viewer layer over a published comparison (docs/standalone.md, "The viewer layer";
 * invariants published-originals-never-written and viewer-layer-per-comparison). Imports the REAL
 * standalone/viewerLayer.ts over the REAL published backend, with the in-memory store standing in
 * for IndexedDB — the store is the layer's only browser dependency, injected for exactly this.
 * The IndexedDB store itself and the adapter's wiring are pinned end to end by the published
 * tests in test/webview/standalone-build.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { createViewerLayer, viewerLayerNamespace, LayerStore } from '../../standalone/viewerLayer';
import { FileType } from '../../standalone/shims/vscode';

/** A store that lives for the test only: IndexedDB's stand-in. */
function memoryLayerStore(): LayerStore {
  const data = new Map<string, Map<string, Uint8Array>>();
  const space = (namespace: string) => {
    let m = data.get(namespace);
    if (!m) data.set(namespace, (m = new Map()));
    return m;
  };
  return {
    load: async namespace => [...space(namespace)].map(([path, bytes]) => [path, bytes.slice()]),
    put: async (namespace, path, bytes) => { space(namespace).set(path, bytes.slice()); },
    remove: async (namespace, path) => { space(namespace).delete(path); },
  };
}

// Runtime-computed, as in publishedComparison.test.ts: fsBackends compiles under the standalone tsconfig.
const backendsModule = '../../standalone/fsBackends';
const { createPublishedBackend } = await import(backendsModule) as {
  createPublishedBackend(files: readonly string[], fetchFile: (path: string) => Promise<ArrayBuffer>): {
    fs: import('../../standalone/shims/vscode').StandaloneFs; rootPath: string; rootName: string;
  };
};

const LISTED = ['gt/scene_01.png', 'gt/scene_02.png', 'pred/scene_01.png'];
const NS = 'https://example.org/cmp/a/';
const bytes = (...b: number[]) => new Uint8Array(b);

function published() {
  const fetched: string[] = [];
  const base = createPublishedBackend(LISTED, async path => {
    fetched.push(path);
    return bytes(1, 2, 3).buffer;
  });
  const listedPaths = new Set(LISTED.map(f => `${base.rootPath}/${f}`));
  return { base, listedPaths, fetched };
}

async function layered(store: LayerStore = memoryLayerStore(), namespace = NS) {
  const { base, listedPaths, fetched } = published();
  return { root: await createViewerLayer(base, listedPaths, store, namespace), fetched, store };
}

const sorted = (entries: Array<[string, FileType]>) => [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

describe('viewer layer: one writable view over read-only published files', () => {
  it('is writable, and merges its own files into the published listing', async () => {
    const { root } = await layered();
    expect(root.fs.writable).toBe(true);
    await root.fs.writeFile('/comparison/results.txt', bytes(9));
    await root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(7));
    await root.fs.writeFile('/comparison/notes/deep/n.txt', bytes(5));
    expect(sorted(await root.fs.readDirectory('/comparison'))).toEqual([
      ['gt', FileType.Directory],
      ['notes', FileType.Directory],
      ['pred', FileType.Directory],
      ['results.txt', FileType.File],
    ]);
    expect(sorted(await root.fs.readDirectory('/comparison/gt'))).toEqual([
      ['scene_01.png', FileType.File],
      ['scene_01_crop01.png', FileType.File],
      ['scene_02.png', FileType.File],
    ]);
    expect(await root.fs.readDirectory('/comparison/notes')).toEqual([['deep', FileType.Directory]]);
    await expect(root.fs.readDirectory('/comparison/nowhere')).rejects.toThrow();
  });

  it('stats both layers, and a path in neither is not found', async () => {
    const { root } = await layered();
    await root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(7));
    await root.fs.writeFile('/comparison/mine/x.png', bytes(7));
    expect(await root.fs.stat('/comparison/gt/scene_01.png')).toBe(FileType.File);
    expect(await root.fs.stat('/comparison/gt')).toBe(FileType.Directory);
    expect(await root.fs.stat('/comparison/gt/scene_01_crop01.png')).toBe(FileType.File);
    expect(await root.fs.stat('/comparison/mine')).toBe(FileType.Directory);
    await expect(root.fs.stat('/comparison/gt/nothing.png')).rejects.toThrow();
    await expect(root.fs.readFile('/comparison/gt/nothing.png')).rejects.toThrow();
  });

  it('reads its own files without a fetch, and published ones through it', async () => {
    const { root, fetched } = await layered();
    await root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(7, 7));
    expect(Array.from(await root.fs.readFile('/comparison/gt/scene_01_crop01.png'))).toEqual([7, 7]);
    expect(fetched).toEqual([]);
    expect(Array.from(await root.fs.readFile('/comparison/pred/scene_01.png'))).toEqual([1, 2, 3]);
    expect(fetched).toEqual(['pred/scene_01.png']);
  });

  it('prefers the layer when it holds a path the listing also has', async () => {
    const store = memoryLayerStore();
    await store.put(NS, 'gt/scene_01.png', bytes(4, 4));
    const { root, fetched } = await layered(store);
    expect(Array.from(await root.fs.readFile('/comparison/gt/scene_01.png'))).toEqual([4, 4]);
    expect(fetched).toEqual([]);
  });

  // docs/standalone.md: published-originals-never-written
  it('refuses to write or delete a published file or directory, and touches nothing doing so', async () => {
    const store = memoryLayerStore();
    const { root } = await layered(store);
    for (const path of ['/comparison/gt/scene_01.png', '/comparison/pred/scene_01.png', '/comparison/gt']) {
      await expect(root.fs.writeFile(path, bytes(0))).rejects.toThrow(/read-only/);
      await expect(root.fs.delete(path)).rejects.toThrow(/read-only/);
    }
    await expect(root.fs.writeFile('/elsewhere/x.png', bytes(0))).rejects.toThrow(/outside/);
    expect(await store.load(NS)).toEqual([]);
    expect(Array.from(await root.fs.readFile('/comparison/gt/scene_01.png'))).toEqual([1, 2, 3]);
  });

  it('deletes the viewer\'s own files, and a delete of nothing is not found', async () => {
    const { root, store } = await layered();
    await root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(7));
    await root.fs.delete('/comparison/gt/scene_01_crop01.png');
    await expect(root.fs.stat('/comparison/gt/scene_01_crop01.png')).rejects.toThrow();
    expect(await store.load(NS)).toEqual([]);
    await expect(root.fs.delete('/comparison/gt/scene_01_crop01.png')).rejects.toThrow(/No such file/);
  });

  it('flags only published paths read-only', async () => {
    const { root } = await layered();
    await root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(7));
    expect(root.isReadOnly('/comparison/gt/scene_01.png')).toBe(true);
    expect(root.isReadOnly('/comparison/gt/scene_01_crop01.png')).toBe(false);
    expect(root.isReadOnly('/comparison/results.txt')).toBe(false);
  });

  it('survives a reload: a fresh layer over the same store and namespace sees the viewer\'s files', async () => {
    const store = memoryLayerStore();
    const first = await layered(store);
    await first.root.fs.writeFile('/comparison/results.txt', bytes(1, 1));
    await first.root.fs.writeFile('/comparison/pred/scene_01_crop01.png', bytes(2));
    await first.root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(3));
    await first.root.fs.delete('/comparison/gt/scene_01_crop01.png');

    const second = await layered(store);
    expect(Array.from(await second.root.fs.readFile('/comparison/results.txt'))).toEqual([1, 1]);
    expect(sorted(await second.root.fs.readDirectory('/comparison/pred'))).toEqual([
      ['scene_01.png', FileType.File],
      ['scene_01_crop01.png', FileType.File],
    ]);
    await expect(second.root.fs.stat('/comparison/gt/scene_01_crop01.png')).rejects.toThrow();
  });

  // docs/standalone.md: viewer-layer-per-comparison
  it('never shows one comparison\'s files to another sharing the store', async () => {
    const store = memoryLayerStore();
    const a = await layered(store, 'https://example.org/cmp/a/');
    await a.root.fs.writeFile('/comparison/results.txt', bytes(1));
    const b = await layered(store, 'https://example.org/cmp/b/');
    await expect(b.root.fs.readFile('/comparison/results.txt')).rejects.toThrow();
    await b.root.fs.writeFile('/comparison/results.txt', bytes(2));
    expect(Array.from(await (await layered(store, 'https://example.org/cmp/a/')).root.fs.readFile('/comparison/results.txt'))).toEqual([1]);
  });

  it('falls back to memory for the visit when the store refuses, with no error to the viewer', async () => {
    const refusing: LayerStore = {
      load: async () => { throw new Error('QuotaExceededError'); },
      put: async () => { throw new Error('should not be reached after a failed load'); },
      remove: async () => { throw new Error('should not be reached after a failed load'); },
    };
    const { root } = await layered(refusing);
    await root.fs.writeFile('/comparison/results.txt', bytes(5));
    expect(Array.from(await root.fs.readFile('/comparison/results.txt'))).toEqual([5]);
    await root.fs.delete('/comparison/results.txt');

    const failingWrites: LayerStore = { ...memoryLayerStore(), put: async () => { throw new Error('denied'); } };
    const second = await layered(failingWrites);
    await second.root.fs.writeFile('/comparison/results.txt', bytes(6));
    expect(Array.from(await second.root.fs.readFile('/comparison/results.txt'))).toEqual([6]);
  });

  it('loses only the write the store refuses: the ones after it still survive a reload', async () => {
    // One crop over the browser's quota must not leave every later vote and delete unsaved.
    const store = memoryLayerStore();
    let refuse = true;
    const flaky: LayerStore = {
      ...store,
      put: async (namespace, path, data) => {
        if (refuse) { refuse = false; throw new Error('QuotaExceededError'); }
        return store.put(namespace, path, data);
      },
    };
    const first = await layered(flaky);
    await first.root.fs.writeFile('/comparison/gt/scene_01_crop01.png', bytes(9));
    await first.root.fs.writeFile('/comparison/results.txt', bytes(1, 1));
    await first.root.fs.writeFile('/comparison/pred/scene_01_crop01.png', bytes(2));
    await first.root.fs.delete('/comparison/pred/scene_01_crop01.png');

    const second = await layered(store);
    await expect(second.root.fs.stat('/comparison/gt/scene_01_crop01.png')).rejects.toThrow();
    expect(Array.from(await second.root.fs.readFile('/comparison/results.txt'))).toEqual([1, 1]);
    await expect(second.root.fs.stat('/comparison/pred/scene_01_crop01.png')).rejects.toThrow();
  });
});

describe('viewer layer namespace: the comparison\'s URL directory', () => {
  it('drops the manifest filename, query and fragment', () => {
    expect(viewerLayerNamespace('https://example.org/cmp/a/imagecompare.json')).toBe('https://example.org/cmp/a/');
    expect(viewerLayerNamespace('https://example.org/cmp/a/imagecompare.json?v=2#x')).toBe('https://example.org/cmp/a/');
    expect(viewerLayerNamespace('http://127.0.0.1:8000/imagecompare.json')).toBe('http://127.0.0.1:8000/');
  });

  it('separates sibling and nested comparisons on one origin', () => {
    const names = [
      'https://example.org/cmp/a/imagecompare.json',
      'https://example.org/cmp/b/imagecompare.json',
      'https://example.org/cmp/a/sub/imagecompare.json',
      'https://other.example.org/cmp/a/imagecompare.json',
    ].map(viewerLayerNamespace);
    expect(new Set(names).size).toBe(4);
  });
});
