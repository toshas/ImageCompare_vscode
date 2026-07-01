import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readResultsFile, writeResultsFile } from '../../src/fileService';
import { ImageTuple } from '../../src/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imagecompare-results-'));
}

suite('results.txt cross-platform IO', () => {
  test('parses a CRLF-encoded results file (Windows / Notepad)', async () => {
    const dir = tmpDir();
    try {
      // Simulate a file saved with Windows line endings.
      const content =
        '# ImageCompare Results\r\n# comment\r\nscene_000 = GT\r\nscene_001 = PRED\r\n';
      fs.writeFileSync(path.join(dir, 'results.txt'), content);

      const winners = await readResultsFile(vscode.Uri.file(dir));
      assert.strictEqual(winners.get('scene_000'), 'GT', 'no stray \\r on value');
      assert.strictEqual(winners.get('scene_001'), 'PRED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('write then read round-trips on the host OS', async () => {
    const dir = tmpDir();
    try {
      const base = vscode.Uri.file(dir);
      const tuples: ImageTuple[] = [
        { name: 'scene_000', images: [] } as unknown as ImageTuple,
        { name: 'scene_001', images: [] } as unknown as ImageTuple,
      ];
      const winnersByIndex = new Map<number, string>([
        [0, 'PRED'],
        [1, 'GT'],
      ]);
      await writeResultsFile(base, tuples, winnersByIndex, ['GT', 'PRED']);

      const read = await readResultsFile(base);
      assert.strictEqual(read.get('scene_000'), 'PRED');
      assert.strictEqual(read.get('scene_001'), 'GT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
