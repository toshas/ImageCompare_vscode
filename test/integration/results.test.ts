import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readResultsFile } from '../../src/fileService';

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
});
