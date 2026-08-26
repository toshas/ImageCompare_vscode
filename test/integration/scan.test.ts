import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { scanForImages } from '../../src/fileService';
import { makeModalityTree, rmrf } from './fixtures';

suite('scanForImages (real vscode.workspace.fs)', () => {
  test('mode 1: single dir with modality subdirs builds tuples', async () => {
    const root = makeModalityTree(['GT', 'PRED'], ['scene000', 'scene001', 'scene002']);
    try {
      const result = await scanForImages([vscode.Uri.file(root)]);
      assert.strictEqual(result.modalities.length, 2, 'two modalities');
      assert.strictEqual(result.tuples.length, 3, 'three tuples');
      for (const t of result.tuples) {
        assert.strictEqual(t.images.length, 2, `tuple ${t.name} has both modalities`);
      }
    } finally {
      rmrf(root);
    }
  });

  test('partial tuple when a modality is missing a file', async () => {
    const root = makeModalityTree(['GT', 'PRED'], ['a', 'b']);
    // Remove one PRED file so its tuple is partial.
    rmrf(`${root}/PRED/b_PRED.png`);
    try {
      const result = await scanForImages([vscode.Uri.file(root)]);
      const partial = result.tuples.find((t) => t.name.includes('b'));
      assert.ok(partial, 'partial tuple exists');
      assert.ok(partial!.images.length < 2, 'partial tuple is missing a modality');
    } finally {
      rmrf(root);
    }
  });

  test('PPMX files are scanned as images', async () => {
    const root = makeModalityTree(['RGB', 'DEPTH'], ['x', 'y'], { ppmx: true });
    try {
      const result = await scanForImages([vscode.Uri.file(root)]);
      assert.strictEqual(result.tuples.length, 2);
      const hasPpmx = result.tuples.some((t) => t.images.some((i) => i.name.endsWith('.ppmx')));
      assert.ok(hasPpmx, 'a .ppmx image was matched into a tuple');
    } finally {
      rmrf(root);
    }
  });
});

// The premise broken-link handling rests on, checked against the REAL provider rather than this
// repo's fs-backed mock: a link whose target is gone must carry the SymbolicLink bit and NOT the
// File bit, or every `type & FileType.File` gate in the scan and the poll silently accepts it as an
// image and the tile is permanently blank. Layer 1 can only ask the mock what the mock believes.
//
// NO MUTATION COVERS THIS CASE: it is pinned only by the integration layer, which the mutation
// harness cannot run (it is Vitest-only), so the premise was confirmed by hand against the shipped
// VS Code source instead. What stands in for a mutation on the code side: the rule this premise
// protects — the `type & FileType.File` gate in `listImagesIn` — stays covered by the
// `symlink: broken link accepted` mutation in `scripts/mutation-check.mjs`.
// (docs/tuple-matching.md: entry-type-is-a-bitmask)
suite('vscode.workspace.fs entry types (real API, not the mock)', () => {
  test('a dangling symlink types as SymbolicLink and never as File', async function () {
    const root = makeModalityTree(['GT', 'PRED'], ['a', 'b']);
    try {
      const dir = path.join(root, 'GT');
      try {
        fs.symlinkSync(path.join(dir, 'no_such_target.png'), path.join(dir, 'dangling_GT.png'), 'file');
      } catch {
        // Windows without SeCreateSymbolicLinkPrivilege / Developer Mode: nothing to assert here.
        this.skip();
      }

      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      const entry = entries.find(([name]) => name === 'dangling_GT.png');
      assert.ok(entry, 'the dangling link is listed at all');
      const type = entry![1];
      assert.strictEqual(
        type & vscode.FileType.SymbolicLink,
        vscode.FileType.SymbolicLink,
        'the SymbolicLink bit is set',
      );
      assert.strictEqual(type & vscode.FileType.File, 0, 'the File bit is NOT set for a missing target');
      assert.strictEqual(type, vscode.FileType.Unknown | vscode.FileType.SymbolicLink);

      // And the consequence the gate exists for: no tuple is built out of a link to nothing.
      const result = await scanForImages([vscode.Uri.file(root)]);
      const names = result.tuples.flatMap((t) => t.images.map((i) => i.name));
      assert.ok(!names.includes('dangling_GT.png'), 'a dangling link never becomes an image');
    } finally {
      rmrf(root);
    }
  });
});
