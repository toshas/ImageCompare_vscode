import * as assert from 'assert';
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
