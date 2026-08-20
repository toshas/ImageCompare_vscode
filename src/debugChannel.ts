/**
 * The extension's half of the debug sink: an "ImageCompare" output channel, and the cached
 * `imageCompare.debug*` flags refreshed on configuration change. Kept out of `debugLog.ts` so that
 * module stays browser-safe for the standalone. See docs/testing.md ("Debug logging").
 */
import * as vscode from 'vscode';
import { configureDebugLog, resetDebugClock } from './debugLog';

const CHANNEL_NAME = 'ImageCompare';

let channel: vscode.OutputChannel | undefined;

function applySettings(): void {
  const config = vscode.workspace.getConfiguration('imageCompare');
  const enabled = config.get<boolean>('debug', false) === true;
  const verbose = config.get<boolean>('debugVerbose', false) === true;
  // Off by default: VS Code replays extension-host console output into the renderer (docs/testing.md).
  const mirror = config.get<boolean>('debugConsole', false) === true;
  configureDebugLog({
    enabled,
    verbose,
    sink: line => {
      if (!channel) channel = vscode.window.createOutputChannel(CHANNEL_NAME);
      channel.appendLine(line);
      if (mirror) console.log(line);
    }
  });
}

/**
 * Start the clock every debug line is stamped against and track `imageCompare.debug`.
 * Call once from `activate`; disposing the result also closes the output channel.
 */
export function initDebugLog(): vscode.Disposable {
  resetDebugClock();
  applySettings();
  const sub = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('imageCompare')) applySettings();
  });
  return {
    dispose: () => {
      sub.dispose();
      disposeDebugLog();
    }
  };
}

/** Drop the channel and silence the sink — the dispose path, and the per-test reset. */
export function disposeDebugLog(): void {
  channel?.dispose();
  channel = undefined;
  configureDebugLog({ enabled: false });
}
