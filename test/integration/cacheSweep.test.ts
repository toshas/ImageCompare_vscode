import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ThumbnailService } from '../../src/thumbnailService';
import { rmrf } from './fixtures';

/**
 * The thumbnail cache's age sweep, run against the REAL vscode.workspace.fs rather than this repo's
 * fs-backed mock: `cleanupOldCache` classifies its listing with `(type & FileType.File) !== 0`, and
 * a cache entry that is a symlink lists as File|SymbolicLink (65). Under `type === FileType.File`
 * such an entry is exempt from the age cap forever — the one direction of this bug that is invisible
 * to a user (nothing is missing; the cache just never shrinks) and therefore the one most likely to
 * be "simplified" back. Layer 1 pins the same site through the mock, which is what the mutation gate
 * can reach; what only this layer can say is that the REAL API produces that bit combination for a
 * live cache directory.
 *
 * NOT VERIFIED ON THE MACHINE THIS WAS WRITTEN ON: Layer 2 needs a real (headless) VS Code and there
 * is no X server there, so `npm run test:integration` never ran locally — this file was type-checked
 * (`tsc -p test/integration/tsconfig.integration.json`) and CI is its only proof, exactly as for the
 * dangling-symlink premise in scan.test.ts.
 *
 * NO MUTATION COVERS THIS FILE: the mutation harness runs Vitest suites only. The rule it protects —
 * the `type & FileType.File` gate in `cleanupOldCache` — is covered by the
 * `symlink: thumbnail cache-age sweep back to strict equality` mutation, which kills through
 * test/unit/thumbCacheExpiry.test.ts.
 * (docs/tuple-matching.md: entry-type-is-a-bitmask)
 */
suite('thumbnail cache sweep entry types (real vscode.workspace.fs)', () => {
  test('a symlinked cache entry lists as File|SymbolicLink and still expires by age', async function () {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'imagecompare-cachesweep-'));
    const cacheDir = path.join(storage, 'thumbnail-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      // Older than the configured cap under every value the setting allows (default 7, maximum 30).
      const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const maxAgeDays = vscode.workspace.getConfiguration('imageCompare').get<number>('cacheMaxAgeDays', 7);
      assert.ok(maxAgeDays < 45, `the fixture must be older than the cap (cap ${maxAgeDays} days)`);

      const target = path.join(storage, 'linked-target.jpg');
      fs.writeFileSync(target, Buffer.from('not-really-a-jpeg'));
      fs.utimesSync(target, aged, aged);
      try {
        fs.symlinkSync(target, path.join(cacheDir, 'linked.jpg'), 'file');
      } catch {
        // Windows without SeCreateSymbolicLinkPrivilege / Developer Mode: nothing to assert here.
        this.skip();
      }
      fs.lutimesSync(path.join(cacheDir, 'linked.jpg'), aged, aged);

      // Controls: a plain stale entry (dies either way) and a fresh one (survives either way).
      fs.writeFileSync(path.join(cacheDir, 'plain-stale.jpg'), Buffer.from('x'));
      fs.utimesSync(path.join(cacheDir, 'plain-stale.jpg'), aged, aged);
      fs.writeFileSync(path.join(cacheDir, 'fresh.jpg'), Buffer.from('x'));

      // The premise, from the real API: both bits set, so `=== FileType.File` skips the entry.
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(cacheDir));
      const linked = entries.find(([name]) => name === 'linked.jpg');
      assert.ok(linked, 'the link is listed at all');
      assert.strictEqual(linked![1] & vscode.FileType.File, vscode.FileType.File, 'the File bit is set');
      assert.strictEqual(
        linked![1] & vscode.FileType.SymbolicLink,
        vscode.FileType.SymbolicLink,
        'the SymbolicLink bit is set',
      );
      assert.notStrictEqual(linked![1], vscode.FileType.File, 'and the type is therefore not equal to File');

      // And the consequence the bit test exists for, from the real sweep.
      const service = new ThumbnailService(
        { globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext,
      );
      await service.cleanupOldCache();

      assert.deepStrictEqual(fs.readdirSync(cacheDir).sort(), ['fresh.jpg'], 'both stale entries were swept');
      assert.ok(fs.existsSync(target), 'the sweep unlinked the entry it listed, not the file behind it');
    } finally {
      rmrf(storage);
    }
  });
});
