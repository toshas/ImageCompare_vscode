/** The per-viewer writable layer over a published comparison: listed files read-only, the viewer's own writes kept in the browser (docs/standalone.md, "The viewer layer"). */
import { FileType, StandaloneFs } from './shims/vscode';

/** Where a layer persists, keyed by the comparison's namespace and a root-relative path; injected so the layer is testable without a browser. */
export interface LayerStore {
  load(namespace: string): Promise<Array<[string, Uint8Array]>>;
  put(namespace: string, path: string, bytes: Uint8Array): Promise<void>;
  remove(namespace: string, path: string): Promise<void>;
}

/** The root the layer wraps — the published backend's shape, restated so this module stays free of the DOM-typed backends. */
export interface LayerBase {
  fs: StandaloneFs;
  rootPath: string;
  rootName: string;
}

export interface LayeredRoot extends LayerBase {
  /** True for a listed (published) path: it can be neither written nor deleted. */
  isReadOnly(path: string): boolean;
}

/** The comparison's URL directory — the manifest URL with its filename, query and fragment dropped (docs/standalone.md: viewer-layer-per-comparison). */
export function viewerLayerNamespace(manifestUrl: string): string {
  const url = new URL(manifestUrl);
  url.search = '';
  url.hash = '';
  return url.href.substring(0, url.href.lastIndexOf('/') + 1);
}

const IDB_NAME = 'imagecompare-viewer-layer';
const IDB_STORE = 'files';

/** The browser's persistent store: one IndexedDB object store, every key prefixed by its comparison's namespace. */
export function indexedDbLayerStore(): LayerStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return db;
  };
  const key = (namespace: string, path: string) => `${namespace}\u0000${path}`;
  const run = async (mode: IDBTransactionMode, act: (store: IDBObjectStore) => void): Promise<void> => {
    const tx = (await open()).transaction(IDB_STORE, mode);
    act(tx.objectStore(IDB_STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    load: async namespace => {
      const out: Array<[string, Uint8Array]> = [];
      const prefix = key(namespace, '');
      await run('readonly', store => {
        const cursor = store.openCursor(IDBKeyRange.bound(prefix, `${namespace}\u0001`, false, true));
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          out.push([String(c.key).substring(prefix.length), new Uint8Array(c.value as ArrayBuffer)]);
          c.continue();
        };
      });
      return out;
    },
    put: (namespace, path, bytes) => run('readwrite', store => { store.put(bytes.slice().buffer, key(namespace, path)); }),
    remove: (namespace, path) => run('readwrite', store => { store.delete(key(namespace, path)); }),
  };
}

/** Wrap a published root in the viewer's layer, loaded from `store` before it is returned; a store that fails to load leaves the layer in memory for the visit, and a write the store refuses is lost on reload alone. */
export async function createViewerLayer(base: LayerBase, listedPaths: ReadonlySet<string>, store: LayerStore, namespace: string): Promise<LayeredRoot> {
  const prefix = `${base.rootPath}/`;
  const listedDirs = new Set<string>();
  for (const path of listedPaths) {
    for (let cut = path.indexOf('/', prefix.length); cut >= 0; cut = path.indexOf('/', cut + 1)) listedDirs.add(path.substring(0, cut));
  }
  const layer = new Map<string, Uint8Array>();
  let persistent = true;
  try {
    for (const [rel, bytes] of await store.load(namespace)) layer.set(prefix + rel, bytes);
  } catch {
    persistent = false;
  }
  // Unread contents are never written over; a refused write costs that write only (docs/standalone.md, "The viewer layer").
  const persist = (act: () => Promise<void>): Promise<void> => {
    if (!persistent) return Promise.resolve();
    return act().catch(() => undefined);
  };
  // The layer refuses both writes and deletes of a published path (docs/standalone.md: published-originals-never-written).
  const refuseListed = (path: string): void => {
    if (!path.startsWith(prefix)) throw new Error(`Path outside the comparison: ${path}`);
    if (listedPaths.has(path) || listedDirs.has(path)) throw new Error(`Published files are read-only: ${path}`);
  };
  const layerChildren = (dir: string): Map<string, FileType> => {
    const out = new Map<string, FileType>();
    const dirPrefix = `${dir}/`;
    for (const path of layer.keys()) {
      if (!path.startsWith(dirPrefix)) continue;
      const rest = path.substring(dirPrefix.length);
      const cut = rest.indexOf('/');
      if (cut < 0) out.set(rest, FileType.File);
      else out.set(rest.substring(0, cut), FileType.Directory);
    }
    return out;
  };

  const fs: StandaloneFs = {
    writable: true,
    stat: async path => {
      try {
        return await base.fs.stat(path);
      } catch (err) {
        if (layer.has(path)) return FileType.File;
        if (path === base.rootPath || layerChildren(path).size > 0) return FileType.Directory;
        throw err;
      }
    },
    readDirectory: async path => {
      let listed: Array<[string, FileType]> | undefined;
      try {
        listed = await base.fs.readDirectory(path);
      } catch (err) {
        if (path !== base.rootPath && layerChildren(path).size === 0) throw err;
      }
      const merged = new Map<string, FileType>(listed ?? []);
      for (const [name, type] of layerChildren(path)) if (!merged.has(name)) merged.set(name, type);
      return [...merged];
    },
    readFile: async path => layer.get(path)?.slice() ?? base.fs.readFile(path),
    writeFile: async (path, content) => {
      refuseListed(path);
      const bytes = content.slice();
      layer.set(path, bytes);
      await persist(() => store.put(namespace, path.substring(prefix.length), bytes));
    },
    delete: async path => {
      refuseListed(path);
      if (!layer.delete(path)) throw new Error(`No such file: ${path}`);
      await persist(() => store.remove(namespace, path.substring(prefix.length)));
    },
  };

  return { fs, rootPath: base.rootPath, rootName: base.rootName, isReadOnly: path => listedPaths.has(path) };
}
