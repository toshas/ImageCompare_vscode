import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension activation', () => {
  test('extension is present and activates', async () => {
    const ext = vscode.extensions.getExtension('obukhovai.image-compare');
    assert.ok(ext, 'extension found by id');
    await ext!.activate();
    assert.ok(ext!.isActive, 'extension activated');
  });

  test('openInCompare command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('imageCompare.openInCompare'),
      'imageCompare.openInCompare command registered',
    );
  });
});
