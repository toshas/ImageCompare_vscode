import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { copyFilesToClipboard } from '../../src/clipboardFiles';

// Read the LEGACY NSFilenamesPboardType array. NOTE: this representation can show
// a full count even when the modern items were truncated — it was the blind spot
// that hid the "N pastes as N-1" bug. Kept for completeness; the real guard below
// reads the modern representation.
function readClipboardFilesDarwin(): string[] {
  const out = execFileSync('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); var pl=$.NSPasteboard.generalPasteboard.propertyListForType("NSFilenamesPboardType"); pl.isNil()?"":pl.js.map(function(x){return x.js;}).join("\\n");',
  ])
    .toString()
    .trim();
  return out ? out.split('\n') : [];
}

// Read the MODERN `public.file-url` pasteboard items — the representation Finder
// and Slack actually paste from. THIS is what truncates if the writing process
// exits before the pasteboard server finishes ingesting items.
function readClipboardModernDarwin(): string[] {
  const out = execFileSync('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); var pb=$.NSPasteboard.generalPasteboard; var it=pb.pasteboardItems; var n=it.count; var a=[]; for(var i=0;i<n;i++){var u=it.objectAtIndex(i).stringForType("public.file-url"); if(!u.isNil())a.push(decodeURIComponent(""+u.js).replace("file://","")); } a.join("\\n");',
  ])
    .toString()
    .trim();
  return out ? out.split('\n') : [];
}

suite('copyFilesToClipboard (cross-platform)', () => {
  // Cover 2/3/4 files: the user reported 3+ selections dropping a file, so the
  // guard asserts EVERY file lands for each count.
  for (const n of [2, 3, 4]) {
    test(`copies all ${n} files (no drops)`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagecompare-clip-'));
      try {
        const files = Array.from({ length: n }, (_, i) => path.join(dir, `f${i}.png`));
        files.forEach((f, i) => fs.writeFileSync(f, String(i)));

        const res = await copyFilesToClipboard(files);
        assert.strictEqual(res.count, n);
        assert.ok(res.method === 'files' || res.method === 'paths');

        if (process.platform === 'linux') {
          assert.strictEqual(res.method, 'paths');
          assert.strictEqual(await vscode.env.clipboard.readText(), files.join('\n'));
        }
        if (process.platform === 'darwin' && res.method === 'files') {
          // Legacy view (always was full) — sanity only.
          assert.deepStrictEqual(readClipboardFilesDarwin(), files, `expected all ${n} files (legacy)`);
          // Modern view — the one that actually pastes. This is the real guard
          // for the "N pastes as N-1" regression.
          const modern = readClipboardModernDarwin().map((p) => path.basename(p)).sort();
          const expected = files.map((f) => path.basename(f)).sort();
          assert.deepStrictEqual(modern, expected, `expected all ${n} files in modern public.file-url items`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
