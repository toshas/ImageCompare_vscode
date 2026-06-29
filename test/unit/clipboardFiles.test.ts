import { describe, it, expect } from 'vitest';
import { buildClipboardFilesCommand } from '../../src/clipboardFiles';

describe('buildClipboardFilesCommand (cross-platform)', () => {
  const paths = ['/a/img1.png', '/a/img2.png'];

  it('macOS uses JXA writeObjects(NSURLs) with a settle delay and passes every path', () => {
    const cmd = buildClipboardFilesCommand('darwin', paths)!;
    expect(cmd.command).toBe('osascript');
    expect(cmd.args).toContain('-l');
    expect(cmd.args).toContain('JavaScript');
    const script = cmd.args[cmd.args.indexOf('-e') + 1];
    // Canonical multi-file API: one NSURL per file via writeObjects, which
    // populates the modern public.file-url items that Finder/Slack paste from.
    expect(script).toContain('writeObjects');
    expect(script).toContain('fileURLWithPath');
    // MUST keep the process alive after the write — otherwise the async flush to
    // the pasteboard server is truncated and N files paste as N-1 (the bug).
    expect(script).toContain('sleepForTimeInterval');
    for (const p of paths) expect(cmd.args).toContain(p);
  });

  it('Windows uses PowerShell Set-Clipboard -LiteralPath with all paths', () => {
    const cmd = buildClipboardFilesCommand('win32', ['C:\\x\\a.png', 'C:\\x\\b.png'])!;
    expect(cmd.command).toBe('powershell');
    const script = cmd.args[cmd.args.length - 1];
    expect(script).toContain('Set-Clipboard -LiteralPath');
    expect(script).toContain("'C:\\x\\a.png'");
    expect(script).toContain("'C:\\x\\b.png'");
  });

  it("Windows escapes single quotes in paths (PowerShell '' )", () => {
    const cmd = buildClipboardFilesCommand('win32', ["C:\\o'brien\\a.png"])!;
    expect(cmd.args[cmd.args.length - 1]).toContain("'C:\\o''brien\\a.png'");
  });

  it('Linux has no native command (caller falls back to text)', () => {
    expect(buildClipboardFilesCommand('linux', paths)).toBeNull();
  });

  it('empty path list returns null', () => {
    expect(buildClipboardFilesCommand('darwin', [])).toBeNull();
  });
});
