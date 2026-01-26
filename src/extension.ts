import * as vscode from 'vscode';
import { ImageCompareProvider } from './imageCompareProvider';

let provider: ImageCompareProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  provider = new ImageCompareProvider(context);
  await provider.initialize();

  const disposable = vscode.commands.registerCommand(
    'imageCompare.openInCompare',
    async (uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined) => {
      let selectedUris: vscode.Uri[] = [];

      if (uris && uris.length > 0) {
        selectedUris = uris;
      } else if (uri) {
        selectedUris = [uri];
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          selectedUris = [activeEditor.document.uri];
        }
      }

      if (selectedUris.length === 0) {
        vscode.window.showErrorMessage('ImageCompare: No files or folders selected');
        return;
      }

      await provider!.openCompare(selectedUris);
    }
  );

  context.subscriptions.push(disposable);

  context.subscriptions.push({
    dispose: () => {
      if (provider) {
        provider.dispose();
      }
    }
  });
}

export function deactivate() {
  if (provider) {
    provider.dispose();
    provider = undefined;
  }
}
