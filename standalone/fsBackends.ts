/** The two StandaloneFs backends: FSA directory handle (writable) and webkitdirectory FileList (read-only) — IO only, no decisions (docs/standalone.md). */
import { FileType, StandaloneFs } from './shims/vscode';

export interface OpenedRoot {
  fs: StandaloneFs;
  rootPath: string;
  rootName: string;
  /** Present only for FSA roots — the observer/poll accelerator needs the raw handle. */
  handle?: FileSystemDirectoryHandle;
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

  return { fs, rootPath, rootName: root.name || 'folder', handle: root };
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

  return { fs, rootPath, rootName };
}
