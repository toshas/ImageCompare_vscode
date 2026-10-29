/** The two StandaloneFs backends: FSA directory handle (writable) and webkitdirectory FileList (read-only) — IO only, no decisions (docs/standalone.md). */
import { FileType, StandaloneFs } from './shims/vscode';
import { DEFAULT_HOST_REGIME, HostRegimeName, isHostRegimeName } from './hostRegimes';
import { isPublishedPath } from './publishedPath';

export interface OpenedRoot {
  fs: StandaloneFs;
  rootPath: string;
  rootName: string;
  /** Present only for FSA roots — the observer/poll accelerator needs the raw handle. */
  handle?: FileSystemDirectoryHandle;
  /** True for a path this root can never delete; the webview greys Delete for it (docs/standalone.md: published-originals-never-written). */
  isReadOnly(path: string): boolean;
}

function splitPath(rootPath: string, path: string): string[] {
  if (path !== rootPath && !path.startsWith(rootPath + '/')) {
    throw new Error(`Path outside the opened directory: ${path}`);
  }
  const rel = path.substring(rootPath.length);
  return rel.split('/').filter(s => s.length > 0);
}

/** Writable backend over a File System Access directory handle (picker or drag-drop). */
export function createFsaBackend(root: FileSystemDirectoryHandle): OpenedRoot {
  const rootPath = `/${root.name || 'folder'}`;

  const resolveDir = async (path: string, create = false): Promise<FileSystemDirectoryHandle> => {
    let dir = root;
    for (const seg of splitPath(rootPath, path)) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir;
  };

  const resolveFile = async (path: string, create = false): Promise<FileSystemFileHandle> => {
    const segs = splitPath(rootPath, path);
    const name = segs.pop();
    if (!name) throw new Error(`Not a file path: ${path}`);
    let dir = root;
    for (const seg of segs) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir.getFileHandle(name, { create });
  };

  const fs: StandaloneFs = {
    writable: true,
    stat: async (path) => {
      try {
        await resolveDir(path);
        return FileType.Directory;
      } catch {
        await resolveFile(path);
        return FileType.File;
      }
    },
    readDirectory: async (path) => {
      const dir = await resolveDir(path);
      const entries: Array<[string, FileType]> = [];
      for await (const [name, handle] of dir.entries()) {
        entries.push([name, handle.kind === 'directory' ? FileType.Directory : FileType.File]);
      }
      return entries;
    },
    readFile: async (path) => {
      const file = await (await resolveFile(path)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    writeFile: async (path, content) => {
      const handle = await resolveFile(path, true);
      const writable = await handle.createWritable();
      // Pass an ArrayBuffer copy: a SharedArrayBuffer-backed view is rejected by write().
      await writable.write(content.slice().buffer as ArrayBuffer);
      await writable.close();
    },
    delete: async (path) => {
      const segs = splitPath(rootPath, path);
      const name = segs.pop();
      if (!name) throw new Error(`Cannot delete the root: ${path}`);
      let dir = root;
      for (const seg of segs) {
        dir = await dir.getDirectoryHandle(seg);
      }
      await dir.removeEntry(name);
    },
    // One getFile() per entry — the per-entry cost the poll planner lets IO defer (docs/file-watching.md: poll-diff-names-first).
    fingerprint: async (path) => {
      const file = await (await resolveFile(path)).getFile();
      return { mtime: file.lastModified, size: file.size };
    },
  };

  return { fs, rootPath, rootName: root.name || 'folder', handle: root, isReadOnly: () => false };
}

/** The webkitGetAsEntry file/reader callbacks, promisified. */
function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // fullPath is '/root/mod/img.png'; the FileList backend keys on webkitRelativePath's 'root/mod/img.png' shape.
    Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
    out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns bounded batches (Chromium: 100) and then an empty one — loop until it does.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return;
    for (const child of batch) {
      await walkEntry(child, out);
    }
  }
}

/** Firefox/Safari drop path: walk a webkitGetAsEntry directory recursively into the SAME read-only FileList backend the picker feeds (docs/standalone.md). */
export async function createDroppedEntryBackend(root: FileSystemDirectoryEntry): Promise<OpenedRoot> {
  const files: File[] = [];
  await walkEntry(root, files);
  return createFileListBackend(files);
}

export interface PublishedManifest {
  /** The listing: relative paths of the comparison's files. */
  files: string[];
  /** The hosting regime the manifest names; absent is `static` (docs/standalone.md: host-regime-is-one-table). */
  host: HostRegimeName;
  /** Relative paths of packed-thumbnail files; empty when none are listed. */
  thumbs: string[];
}

/** Throws unless every entry is a relative path inside the page's directory. */
function assertRelativePaths(paths: unknown[]): asserts paths is string[] {
  for (const file of paths) {
    if (!isPublishedPath(file)) {
      throw new Error(`imagecompare.json: not a relative path inside the page's directory: ${JSON.stringify(file)}`);
    }
  }
}

/** The published-comparison manifest, or a thrown reason; only relative paths inside the page's directory and a known host pass (docs/standalone.md: published-comparison-opens-itself). */
export function parsePublishedManifest(text: string): PublishedManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('imagecompare.json: not valid JSON');
  }
  const { files, host, thumbs } = (manifest ?? {}) as { files?: unknown; host?: unknown; thumbs?: unknown };
  if (!Array.isArray(files) || files.length === 0) throw new Error('imagecompare.json: must list "files"');
  assertRelativePaths(files);
  // An unknown regime is reported, never defaulted: a guess could offer an export its host blocks (docs/standalone.md: host-regime-is-one-table).
  if (host !== undefined && !isHostRegimeName(host)) throw new Error(`imagecompare.json: unknown "host": ${JSON.stringify(host)}`);
  if (thumbs !== undefined && (!Array.isArray(thumbs) || thumbs.length === 0)) throw new Error('imagecompare.json: "thumbs" must list files');
  if (thumbs !== undefined) assertRelativePaths(thumbs);
  return { files, host: host ?? DEFAULT_HOST_REGIME, thumbs: thumbs ?? [] };
}

/** Read-only backend over a published comparison: the listed paths stand in for a dropped folder, each fetched when read (docs/standalone.md: published-comparison-opens-itself). */
export function createPublishedBackend(files: readonly string[], fetchFile: (path: string) => Promise<ArrayBuffer>): OpenedRoot {
  return createFileListBackend(files.map(path => ({
    name: path.split('/').pop(),
    webkitRelativePath: `comparison/${path}`,
    arrayBuffer: () => fetchFile(path),
  }) as unknown as File));
}

/** Read-only backend over a `webkitdirectory` FileList (Firefox/Safari fallback) — nothing can be written. */
export function createFileListBackend(files: readonly File[]): OpenedRoot {
  const byPath = new Map<string, File>();
  const dirs = new Set<string>();
  let rootName = 'folder';

  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const segs = rel.split('/').filter(s => s.length > 0);
    if (segs.length === 0) continue;
    rootName = segs[0];
    byPath.set(`/${segs.join('/')}`, file);
    for (let i = 1; i <= segs.length - 1; i++) {
      dirs.add(`/${segs.slice(0, i).join('/')}`);
    }
  }

  const rootPath = `/${rootName}`;

  const fs: StandaloneFs = {
    writable: false,
    stat: async (path) => {
      if (dirs.has(path)) return FileType.Directory;
      if (byPath.has(path)) return FileType.File;
      throw new Error(`No such entry: ${path}`);
    },
    readDirectory: async (path) => {
      if (!dirs.has(path)) throw new Error(`No such directory: ${path}`);
      const seen = new Map<string, FileType>();
      const prefix = `${path}/`;
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && !dir.substring(prefix.length).includes('/')) {
          seen.set(dir.substring(prefix.length), FileType.Directory);
        }
      }
      for (const filePath of byPath.keys()) {
        if (filePath.startsWith(prefix) && !filePath.substring(prefix.length).includes('/')) {
          seen.set(filePath.substring(prefix.length), FileType.File);
        }
      }
      return [...seen.entries()];
    },
    readFile: async (path) => {
      const file = byPath.get(path);
      if (!file) throw new Error(`No such file: ${path}`);
      return new Uint8Array(await file.arrayBuffer());
    },
    writeFile: async () => {
      throw new Error('This directory was opened read-only');
    },
    delete: async () => {
      throw new Error('This directory was opened read-only');
    },
  };

  return { fs, rootPath, rootName, isReadOnly: () => true };
}
