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

  get fsPath(): string {
    return this.path;
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

// Config is read in a couple of pure-ish helpers; return defaults.
// `workspace.fs` delegates to the real node fs so scan pipelines (scanForImages)
// can run end-to-end against deterministic temp-dir fixtures.
export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
  fs: {
    stat: async (uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> => {
      const s = await nodeFs.promises.stat(uri.path);
      return {
        type: s.isDirectory() ? FileType.Directory : FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    },
    readDirectory: async (uri: Uri): Promise<Array<[string, FileType]>> => {
      const entries = await nodeFs.promises.readdir(uri.path, { withFileTypes: true });
      return entries.map((e): [string, FileType] => [
        e.name,
        e.isDirectory() ? FileType.Directory : FileType.File,
      ]);
    },
  },
};

export const window = {
  showWarningMessage: (..._args: unknown[]) => undefined,
  showErrorMessage: (..._args: unknown[]) => undefined,
  showInformationMessage: (..._args: unknown[]) => undefined,
};
