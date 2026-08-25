/** Browser shim of the `vscode` surface the bundled src/ modules touch, kept complete by scripts/check-sidedness.mjs gate (d); IO is delegated to a registered StandaloneFs backend (docs/standalone.md: shim-covers-bundled-calls). */

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly path: string,
  ) {}

  static file(p: string): Uri {
    return new Uri('standalone', p);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    let path = base.path;
    for (const part of parts) {
      // Only `..` needs real semantics: the crop path derives each modality dir as joinPath(imageUri, '..').
      if (part === '..') {
        path = path.replace(/\/$/, '');
        path = path.substring(0, path.lastIndexOf('/')) || '/';
      } else {
        path = `${path.replace(/\/$/, '')}/${part}`;
      }
    }
    return new Uri(base.scheme, path);
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

/** The adapter-side IO backend (FSA directory handle or webkitdirectory FileList) behind workspace.fs. */
export interface StandaloneFs {
  writable: boolean;
  stat(path: string): Promise<FileType>;
  readDirectory(path: string): Promise<Array<[string, FileType]>>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  /** Optional per-entry change fingerprint for the poll; absence only disables 'changed' detection (docs/file-watching.md: poll-diff-names-first). */
  fingerprint?(path: string): Promise<{ mtime?: number; size?: number }>;
}

let activeFs: StandaloneFs | undefined;

export function setStandaloneFs(backend: StandaloneFs): void {
  activeFs = backend;
}

function fsOrThrow(): StandaloneFs {
  if (!activeFs) throw new Error('No standalone filesystem backend registered');
  return activeFs;
}

export const workspace = {
  // Defaults only, like test/mocks/vscode.ts: the standalone has no settings UI.
  // Debug logging is not read from here: the adapter configures the shared sink from `?debug` (docs/standalone.md).
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
  fs: {
    stat: async (uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> => {
      return { type: await fsOrThrow().stat(uri.path), ctime: 0, mtime: 0, size: 0 };
    },
    readDirectory: (uri: Uri): Promise<Array<[string, FileType]>> => fsOrThrow().readDirectory(uri.path),
    readFile: (uri: Uri): Promise<Uint8Array> => fsOrThrow().readFile(uri.path),
    writeFile: (uri: Uri, content: Uint8Array): Promise<void> => fsOrThrow().writeFile(uri.path, content),
    delete: (uri: Uri): Promise<void> => fsOrThrow().delete(uri.path),
  },
};

export const window = {
  showWarningMessage: (..._args: unknown[]) => undefined,
  showErrorMessage: (..._args: unknown[]) => undefined,
  showInformationMessage: (..._args: unknown[]) => undefined,
};
