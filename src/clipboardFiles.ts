/**
 * Copy image FILES (not bitmaps) to the OS clipboard — the "multi-select →
 * copy like Explorer" feature. The OS clipboard can't hold many bitmaps, so we
 * put file references on it instead, which paste as files in Finder/Explorer.
 *
 * macOS / Windows have native ways to do this. Linux has no portable one, so we
 * fall back to copying the paths as text and warn the user.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/**
 * Build the platform-specific command that puts `paths` (absolute file paths)
 * on the clipboard as file references. Returns null on platforms with no
 * native support (e.g. Linux) so the caller can fall back to text.
 *
 * Pure (no side effects) so it can be unit-tested across all platforms.
 */
export function buildClipboardFilesCommand(
  platform: NodeJS.Platform,
  paths: string[],
): ClipboardCommand | null {
  if (paths.length === 0) return null;

  if (platform === 'darwin') {
    // JXA: write one NSURL per file via NSPasteboard.writeObjects — the canonical
    // multi-file API. macOS populates BOTH the modern `public.file-url` pasteboard
    // items (what Finder/Slack actually read on paste) AND the legacy
    // NSFilenamesPboardType for old apps. Paths arrive as run() argv.
    //
    // CRITICAL: the pasteboard server (pboard) ingests items asynchronously. If
    // osascript exits the instant writeObjects returns, the tail items are
    // truncated — the writing process dies mid-flush — so N files paste as N-1 or
    // fewer (worse with more files). The same-process pasteboard read shows the
    // full count, which is why this hid behind a legacy-type read in tests. We
    // keep the process alive briefly (sleepForTimeInterval) to let the flush
    // finish. 0.2s is imperceptible for a copy and verified to fully settle
    // 1..10 files across repeated runs.
    const script =
      "ObjC.import('AppKit');" +
      "ObjC.import('Foundation');" +
      'function run(argv){' +
      'var pb=$.NSPasteboard.generalPasteboard;' +
      'pb.clearContents;' +
      'var urls=[];' +
      'for(var i=0;i<argv.length;i++){urls.push($.NSURL.fileURLWithPath(argv[i]));}' +
      'pb.writeObjects($(urls));' +
      '$.NSThread.sleepForTimeInterval(0.2);' +
      '}';
    return { command: 'osascript', args: ['-l', 'JavaScript', '-e', script, ...paths] };
  }

  if (platform === 'win32') {
    // PowerShell Set-Clipboard -LiteralPath supports multiple paths.
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath @(${list})`],
    };
  }

  return null; // Linux / unknown — caller falls back to text + warning.
}

/**
 * Diagnostic: how many file entries are ACTUALLY pasteable from the clipboard.
 * Counts the modern `public.file-url` pasteboard items — the representation
 * Finder/Slack read on paste — NOT the legacy NSFilenamesPboardType array, which
 * can report a full count even when the modern items were truncated. Returns -1
 * off macOS.
 */
export function clipboardFileCount(): Promise<number> {
  if (process.platform !== 'darwin') return Promise.resolve(-1);
  return new Promise((resolve) => {
    execFile(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit"); var pb=$.NSPasteboard.generalPasteboard; var it=pb.pasteboardItems; var n=it.count; var c=0; for(var i=0;i<n;i++){ if(!it.objectAtIndex(i).stringForType("public.file-url").isNil()) c++; } ""+c;',
      ],
      (err, stdout) => resolve(err ? -1 : parseInt(String(stdout).trim(), 10) || 0),
    );
  });
}

export interface FileToCopy {
  /** Absolute source path. */
  path: string;
  /** A label (e.g. modality/folder name) used to disambiguate same-named files. */
  label: string;
}

/**
 * Return paths to copy. If any selected files share a basename — which is common
 * in a comparison (the matched image in each modality often has the SAME name) —
 * pasting them into one folder makes Finder/Explorer collapse the collisions and
 * drop files. To avoid that, stage copies into a temp folder with disambiguated
 * names (`stem__label.ext`). When there are no name collisions, the originals
 * are copied by reference (no staging).
 */
export function stageForUniqueNames(files: FileToCopy[]): string[] {
  const baseCount = new Map<string, number>();
  for (const f of files) {
    const b = path.basename(f.path);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  const hasCollision = [...baseCount.values()].some((c) => c > 1);
  if (!hasCollision) return files.map((f) => f.path);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagecompare-copy-'));
  const used = new Set<string>();
  return files.map((f) => {
    const base = path.basename(f.path);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    // Only rename the ones that actually collide; keep unique names as-is.
    let dest = (baseCount.get(base) ?? 0) > 1
      ? `${stem}__${(f.label || 'x').replace(/[^A-Za-z0-9._-]+/g, '_')}${ext}`
      : base;
    let n = 2;
    while (used.has(dest)) dest = `${stem}__${(f.label || 'x').replace(/[^A-Za-z0-9._-]+/g, '_')}_${n++}${ext}`;
    used.add(dest);
    const destPath = path.join(dir, dest);
    fs.copyFileSync(f.path, destPath);
    return destPath;
  });
}

function run(cmd: ClipboardCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd.command, cmd.args, (err) => (err ? reject(err) : resolve()));
  });
}

export interface CopyFilesResult {
  method: 'files' | 'paths';
  count: number;
}

/**
 * Copy `paths` to the clipboard as files where supported; otherwise (Linux, or
 * if the native command fails) copy the paths as newline-separated text and
 * surface a warning so the user knows the platform is special for this feature.
 */
export async function copyFilesToClipboard(paths: string[]): Promise<CopyFilesResult> {
  const cmd = buildClipboardFilesCommand(process.platform, paths);
  if (cmd) {
    try {
      await run(cmd);
      return { method: 'files', count: paths.length };
    } catch {
      // fall through to the text fallback below
    }
  }

  await vscode.env.clipboard.writeText(paths.join('\n'));
  if (process.platform === 'linux') {
    vscode.window.showWarningMessage(
      `Copying files to the clipboard isn't natively supported on Linux — ` +
        `copied ${paths.length} file path(s) as text instead.`,
    );
  } else {
    vscode.window.showWarningMessage(
      `Couldn't copy the files to the clipboard — copied ${paths.length} path(s) as text instead.`,
    );
  }
  return { method: 'paths', count: paths.length };
}
