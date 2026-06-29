import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { scanForImages } from '../../src/fileService';
import { copyFilesToClipboard, clipboardFileCount, stageForUniqueNames } from '../../src/clipboardFiles';

const ROOT = path.resolve(__dirname, '..', '..', '..'); // out-integration/test/integration -> repo root
const TF = path.join(ROOT, 'out', 'test_folder');
const T2 = path.join(ROOT, 'out', 'test2');

suite('real-folder copy (test_folder + test2)', () => {
  test('every selected tile resolves to a distinct file and all land on the clipboard', async function () {
    if (!fs.existsSync(TF) || !fs.existsSync(T2)) {
      console.log(`SKIP: folders not found at ${TF} / ${T2}`);
      this.skip();
      return;
    }

    const scan = await scanForImages([vscode.Uri.file(TF), vscode.Uri.file(T2)]);
    console.log('modalities:', scan.modalities, 'tuples:', scan.tuples.length);

    // Resolve EVERY real tile exactly like handleCopyFiles.
    const resolved: { path: string; label: string }[] = [];
    scan.tuples.forEach((tuple, ti) => {
      scan.modalities.forEach((mod) => {
        const img = tuple.images.find((i) => i.modality === mod);
        if (img && img.uri.scheme === 'file') {
          resolved.push({ path: img.uri.fsPath, label: mod });
          console.log(`  t${ti}/${mod}: ${path.basename(img.uri.fsPath)}`);
        }
      });
    });

    const paths = resolved.map((r) => r.path);
    const uniquePaths = new Set(paths).size;
    const uniqueNames = new Set(paths.map((p) => path.basename(p))).size;
    console.log(`resolved=${resolved.length} uniquePaths=${uniquePaths} uniqueNames=${uniqueNames}`);

    // The pipeline used by the extension: dedupe by path, stage same-named files.
    const seen = new Set<string>();
    const deduped = resolved.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
    const finalPaths = stageForUniqueNames(deduped);
    console.log('finalPaths names:', finalPaths.map((p) => path.basename(p)));

    const res = await copyFilesToClipboard(finalPaths);
    const onClip = await clipboardFileCount();
    console.log(`copied=${res.count} method=${res.method} onClipboard=${onClip}`);

    if (process.platform === 'darwin') {
      // Read the MODERN public.file-url items — the representation Finder/Slack
      // paste from. (Reading the legacy NSFilenamesPboardType array here is what
      // previously hid the bug: it stayed full while the modern items truncated.)
      const back = execFileSync('osascript', [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit"); var pb=$.NSPasteboard.generalPasteboard; var it=pb.pasteboardItems; var n=it.count; var a=[]; for(var i=0;i<n;i++){var u=it.objectAtIndex(i).stringForType("public.file-url"); if(!u.isNil())a.push(decodeURIComponent(""+u.js)); } a.join("\\n");',
      ])
        .toString()
        .trim();
      const onClipNames = back ? back.split('\n').map((p) => path.basename(p)) : [];
      console.log('clipboard files (modern public.file-url):', onClipNames);
      // The clipboard must hold exactly the distinct files we staged, all unique.
      assert.strictEqual(onClipNames.length, finalPaths.length, 'clipboard count != staged count');
      assert.strictEqual(new Set(onClipNames).size, finalPaths.length, 'clipboard has duplicate names');
      const expected = finalPaths.map((p) => path.basename(p)).sort();
      assert.deepStrictEqual(onClipNames.sort(), expected, 'clipboard files != staged files');
    }
  });
});
