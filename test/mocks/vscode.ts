/**
 * Minimal `vscode` stub for Vitest unit tests.
 *
 * Only the surface actually touched by the pure functions under test is
 * implemented. The goal is to let us `import` real production modules
 * (fileService, thumbnailService) — which do `import * as vscode` at the top —
 * without pulling in the real extension host. Anything not implemented here is
 * intentionally absent: if a test trips over a missing API, that function
 * wasn't pure and belongs in Layer 2 (integration), not Layer 1.
 */

import * as nodeFs from 'node:fs';

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly path: string,
  ) {}

  static file(p: string): Uri {
    // Mirror real vscode.Uri.file normalization so cross-platform logic tests
    // can feed Windows-style paths and exercise the same code paths as Windows:
    //  - backslashes become forward slashes
    //  - a drive-letter path (C:\...) gains a leading slash => /C:/...
    let value = p.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(value)) {
      value = '/' + value;
    }
    return new Uri('file', value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...parts].join('/');
    return new Uri(base.scheme, joined);
  }

  // The watcher setup re-schemes a path before building its glob, so the open path needs `with`.
  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
  }

  get fsPath(): string {
    // Mirror real vscode: a drive-letter path '/C:/x' maps to a filesystem path 'C:/x'
    // (node's fs accepts forward slashes on Windows); POSIX paths pass through unchanged.
    return /^\/[a-zA-Z]:/.test(this.path) ? this.path.slice(1) : this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

// Mirrors vscode's DiskFileSystemProvider.toType: the target's kind ORed with
// SymbolicLink (so a symlinked dir is 66, a symlinked file 65), and a dangling
// link is Unknown|SymbolicLink = 64. Reproducing the bitmask is what lets Layer 1
// exercise the real classification code against real symlinks on disk.
async function fileTypeOf(fsPath: string): Promise<FileType> {
  const link = await nodeFs.promises.lstat(fsPath);
  const kind = (s: nodeFs.Stats): FileType =>
    s.isFile() ? FileType.File : s.isDirectory() ? FileType.Directory : FileType.Unknown;
  if (!link.isSymbolicLink()) {
    return kind(link);
  }
  try {
    return kind(await nodeFs.promises.stat(fsPath)) | FileType.SymbolicLink;
  } catch {
    return FileType.Unknown | FileType.SymbolicLink;
  }
}

export interface Disposable {
  dispose(): void;
}

// Settings the test can override; empty by default, so every other suite keeps seeing the
// production defaults. `__setConfig`/`__fireConfigChange` are the levers a test pulls to drive
// real config-reading code (debugLog's cached flags) through a change event.
const configOverrides = new Map<string, unknown>();
const configListeners: Array<(e: { affectsConfiguration(section: string): boolean }) => void> = [];

export function __setConfig(key: string, value: unknown): void {
  configOverrides.set(key, value);
}

export function __resetConfig(): void {
  configOverrides.clear();
}

export function __fireConfigChange(section = 'imageCompare'): void {
  const event = { affectsConfiguration: (s: string) => section.startsWith(s) || s.startsWith(section) };
  for (const listener of [...configListeners]) listener(event);
}

// Every line an OutputChannel receives, keyed by channel name, for assertions.
const channelLines = new Map<string, string[]>();
const disposedChannels: string[] = [];

export function __channelLines(name: string): string[] {
  return channelLines.get(name) ?? [];
}

export function __resetChannels(): void {
  // Clear in place, never drop the arrays: a channel created earlier holds its own reference, so
  // clearing the map would leave it writing where no test can see — a false green for any test
  // that resets mid-run and then asserts on emptiness.
  for (const lines of channelLines.values()) {
    lines.length = 0;
  }
  disposedChannels.length = 0;
}

export function __disposedChannels(): string[] {
  return [...disposedChannels];
}

// Config is read in a couple of pure-ish helpers; return defaults (or a test override).
// `workspace.fs` delegates to the real node fs so scan pipelines (scanForImages)
// can run end-to-end against deterministic temp-dir fixtures.
export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (configOverrides.has(key) ? configOverrides.get(key) as T : defaultValue),
  }),
  createFileSystemWatcher: (_pattern: unknown) => ({
    onDidCreate: (_l: (uri: Uri) => void): Disposable => inertDisposable,
    onDidChange: (_l: (uri: Uri) => void): Disposable => inertDisposable,
    onDidDelete: (_l: (uri: Uri) => void): Disposable => inertDisposable,
    dispose: () => undefined,
  }),
  onDidChangeConfiguration: (
    listener: (e: { affectsConfiguration(section: string): boolean }) => void,
  ): Disposable => {
    configListeners.push(listener);
    return {
      dispose: () => {
        const i = configListeners.indexOf(listener);
        if (i >= 0) configListeners.splice(i, 1);
      },
    };
  },
  fs: {
    stat: async (uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> => {
      const type = await fileTypeOf(uri.fsPath);
      // A dangling link has no target to stat; report the link itself, as vscode does.
      const s = type === (FileType.Unknown | FileType.SymbolicLink)
        ? await nodeFs.promises.lstat(uri.fsPath)
        : await nodeFs.promises.stat(uri.fsPath);
      // `ctime` is birthtime, not inode change time: vscode documents FileStat.ctime as the
      // *creation* timestamp and its disk provider returns `stat.birthtime`. Reporting ctimeMs here
      // would be a lie that hides a real bug class — an in-place overwrite moves ctimeMs but not
      // birthtime, so a cache keyed off this field would look invalidated in tests and serve stale
      // pixels in production (docs/image-backends.md, "What the cache key sees").
      return {
        type,
        ctime: s.birthtimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    },
    readDirectory: async (uri: Uri): Promise<Array<[string, FileType]>> => {
      const entries = await nodeFs.promises.readdir(uri.fsPath, { withFileTypes: true });
      return Promise.all(entries.map(async (e): Promise<[string, FileType]> => [
        e.name,
        await fileTypeOf(`${uri.fsPath}/${e.name}`),
      ]));
    },
    // Write side, same delegation: it lets Layer 1 drive ThumbnailService's real disk cache and
    // packfile publication (tmp file then rename) against a real temp globalStorage dir.
    createDirectory: async (uri: Uri): Promise<void> => {
      await nodeFs.promises.mkdir(uri.fsPath, { recursive: true });
    },
    readFile: async (uri: Uri): Promise<Uint8Array> => nodeFs.promises.readFile(uri.fsPath),
    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
      await nodeFs.promises.writeFile(uri.fsPath, content);
    },
    rename: async (source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> => {
      if (!options?.overwrite && nodeFs.existsSync(target.fsPath)) {
        throw new Error(`EEXIST: ${target.fsPath}`);
      }
      await nodeFs.promises.rename(source.fsPath, target.fsPath);
    },
    delete: async (uri: Uri): Promise<void> => {
      await nodeFs.promises.rm(uri.fsPath, { recursive: true, force: true });
    },
  },
};

// Watcher surface: inert, but present. The open path (`openCompare`) arms a watcher per directory
// before it assigns the html, so a Layer 1 test of the *open* — e.g. where the open trace takes its
// marks — cannot run without it. Nothing here fires; a test that needs watcher *events* belongs in
// Layer 2, and the pure decisions live in `watcherLogic.ts`/`pollPlan.ts`.
export class RelativePattern {
  constructor(public readonly baseUri: unknown, public readonly pattern: string) {}
}

const inertDisposable: Disposable = { dispose: () => undefined };

// `env.remoteName` is the signal the transport budget keys off (undefined = local); tests set it.
export const env: { remoteName: string | undefined } = { remoteName: undefined };

export function __setRemoteName(name: string | undefined): void {
  env.remoteName = name;
}

export const window = {
  createOutputChannel: (name: string) => {
    const lines = channelLines.get(name) ?? [];
    channelLines.set(name, lines);
    return {
      name,
      append: (value: string) => { lines.push(value); },
      appendLine: (value: string) => { lines.push(value); },
      replace: (value: string) => { lines.length = 0; lines.push(value); },
      clear: () => { lines.length = 0; },
      show: (..._args: unknown[]) => undefined,
      hide: () => undefined,
      dispose: () => { disposedChannels.push(name); },
    };
  },
  showWarningMessage: (..._args: unknown[]) => undefined,
  showErrorMessage: (..._args: unknown[]) => undefined,
  showInformationMessage: (..._args: unknown[]) => undefined,
};
