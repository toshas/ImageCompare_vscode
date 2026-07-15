import * as path from 'path';
import * as vscode from 'vscode';
import { ImageCompareProvider } from './imageCompareProvider';
import { parseSessionFile, suggestSessionFileName } from './sessionFile';

let provider: ImageCompareProvider | undefined;

const SESSION_VIEW_TYPE = 'imageCompare.sessionFile';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sessionsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'sessions');
}

/**
 * Persist the explorer selection as a session file in globalStorage and open
 * it with the custom editor. All comparisons go through session files, so
 * they survive window reloads and can be reopened from Open Recent.
 */
async function openSelectionAsSession(context: vscode.ExtensionContext, uris: vscode.Uri[]): Promise<void> {
  const dir = sessionsDir(context);
  await vscode.workspace.fs.createDirectory(dir);

  const names = uris.map(u =>
    path.basename(u.fsPath).replace(/\.(png|jpe?g|gif|bmp|webp|tiff?|ppmx)$/i, ''));
  const base = suggestSessionFileName(names);
  const body = Buffer.from(JSON.stringify({ paths: uris.map(u => u.fsPath) }, null, 2) + '\n');

  // Reuse the file when it holds the same selection (focuses the existing
  // tab); otherwise uniquify with a numeric suffix.
  for (let i = 1; ; i++) {
    const fileUri = vscode.Uri.joinPath(dir, `${base}${i === 1 ? '' : `_${i}`}.imagecompare`);
    let existing: Uint8Array | undefined;
    try {
      existing = await vscode.workspace.fs.readFile(fileUri);
    } catch {
      await vscode.workspace.fs.writeFile(fileUri, body);
    }
    if (existing !== undefined && Buffer.compare(Buffer.from(existing), body) !== 0) {
      continue;
    }
    await vscode.commands.executeCommand('vscode.openWith', fileUri, SESSION_VIEW_TYPE);
    return;
  }
}

/**
 * Best-effort cleanup of generated session files: delete files older than
 * 30 days unless they are open in some tab.
 */
async function pruneOldSessions(context: vscode.ExtensionContext): Promise<void> {
  const dir = sessionsDir(context);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  const openUris = new Set(
    vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .map(tab => tab.input instanceof vscode.TabInputCustom ? tab.input.uri.toString() : '')
  );
  const now = Date.now();
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.imagecompare')) {
      continue;
    }
    const fileUri = vscode.Uri.joinPath(dir, name);
    if (openUris.has(fileUri.toString())) {
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      if (now - stat.mtime > SESSION_MAX_AGE_MS) {
        await vscode.workspace.fs.delete(fileUri);
      }
    } catch {
      // Best-effort: ignore files that vanish or cannot be stat'd
    }
  }
}

/**
 * Custom editor for .imagecompare session files (see sessionFile.ts for the
 * format). Opening such a file from the CLI (`code session.imagecompare`) or
 * the explorer starts a comparison, enabling scripted/automated invocation.
 */
class SessionFileEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    // Configure the webview up front so we can always render into it — a
    // missing or malformed session file (common, since generated ones live in
    // a cache and get pruned/deleted) must show a message here rather than
    // throwing, which would leave VSCode with an unresolved custom editor.
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    try {
      const raw = await vscode.workspace.fs.readFile(document.uri);
      const spec = parseSessionFile(Buffer.from(raw).toString('utf8'), path.dirname(document.uri.fsPath));
      const uris = spec.paths.map(p => vscode.Uri.file(p));
      const labels = spec.labels
        ? new Map(spec.labels.map((label, i) => [uris[i].toString(), label]))
        : undefined;
      const colors = spec.colors
        ? new Map(spec.colors.map((color, i) => [uris[i].toString(), color]))
        : undefined;
      await provider!.openCompare(uris, webviewPanel, labels, document.uri, colors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webviewPanel.webview.html = sessionErrorHtml(document.uri.fsPath, message);
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function sessionErrorHtml(filePath: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: var(--vscode-font-family); padding: 2rem; color: var(--vscode-foreground);">
<h2>ImageCompare could not open this session</h2>
<p><code>${escapeHtml(filePath)}</code></p>
<p style="color: var(--vscode-errorForeground);">${escapeHtml(message)}</p>
<p>Expected JSON: <code>{"paths": ["/abs/dir_or_image", ...], "labels"?: ["name", ...]}</code>.
Close this tab, or fix the file and reopen it.</p>
</body></html>`;
}

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

      await openSelectionAsSession(context, selectedUris);
    }
  );

  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      SESSION_VIEW_TYPE,
      new SessionFileEditorProvider(context.extensionUri),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );

  void pruneOldSessions(context);

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
