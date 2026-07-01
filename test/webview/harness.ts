/**
 * Builds the out-of-process webview harness.
 *
 * The harness loads the REAL `dist/webview.js` bundle in a normal browser,
 * with a stubbed `acquireVsCodeApi` (captures outbound messages) and the same
 * styles+body the production panel uses (from src/webviewShell.ts), so it never
 * drifts from the real shell. Tests inject inbound messages via `window.__ic_send`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WEBVIEW_STYLES, WEBVIEW_BODY } from '../../src/webviewShell';

const ROOT = path.resolve(__dirname, '..', '..');
export const BUNDLE_PATH = path.join(ROOT, 'dist', 'webview.js');
export const HARNESS_DIR = path.join(ROOT, 'test', 'webview', 'harness');
export const HARNESS_HTML_PATH = path.join(HARNESS_DIR, 'index.html');
export const HARNESS_URL = 'file://' + HARNESS_HTML_PATH;

function harnessHtml(): string {
  const bundleUrl = 'file://' + BUNDLE_PATH;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${WEBVIEW_STYLES}
</style>
<script>
  // Enable the read-only test hook inside the webview bundle.
  window.__ic_test_enabled = true;
  // Capture everything the webview tries to post back to the extension.
  window.__ic_outbound = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { window.__ic_outbound.push(m); },
      getState: function () { return window.__ic_state; },
      setState: function (s) { window.__ic_state = s; }
    };
  };
  // Inject an inbound extension->webview message.
  window.__ic_send = function (msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  };
  // Convenience: latest outbound message of a given type.
  window.__ic_lastOutbound = function (type) {
    for (var i = window.__ic_outbound.length - 1; i >= 0; i--) {
      if (window.__ic_outbound[i] && window.__ic_outbound[i].type === type) return window.__ic_outbound[i];
    }
    return null;
  };
</script>
</head>
<body>
${WEBVIEW_BODY}
<script src="${bundleUrl}"></script>
</body>
</html>`;
}

/** Write the harness HTML to disk. Throws if the bundle is missing. */
export function buildHarness(): void {
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(
      `Webview bundle not found at ${BUNDLE_PATH}. Run "npm run compile" before the webview tests.`,
    );
  }
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  fs.writeFileSync(HARNESS_HTML_PATH, harnessHtml());
}
