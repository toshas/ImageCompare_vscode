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
/**
 * Puts every pill's width and position off the whole-pixel grid whatever the runner's fonts. A short
 * label takes a fractional min-width (exact in 1/64 px layout units), chosen so whole-pixel offsets
 * draw the 4-pill row's lifted first pill ~1.3 px past the far end: the first pill's width rounds
 * down, the fourth's rounds up and so does its left. A long label gains a fractional letter spacing.
 * The lift-clamp, midpoint and glide specs apply it themselves; `IC_FRACTIONAL_PILLS=1` bakes it into the harness for a run.
 */
export const FRACTIONAL_PILLS_CSS = `.modality-btn { box-sizing: border-box; min-width: 64.0625px; letter-spacing: 0.37px; }
.modality-btn:nth-child(1) { min-width: 64.4375px; }
.modality-btn:nth-child(4) { min-width: 64.5625px; }`;

function harnessHtml(): string {
  const bundleUrl = 'file://' + BUNDLE_PATH;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${WEBVIEW_STYLES}
${process.env.IC_FRACTIONAL_PILLS ? FRACTIONAL_PILLS_CSS : ''}
</style>
<script>
  // Enable the read-only test hook inside the webview bundle.
  window.__ic_test_enabled = true;
  // Capture everything the webview tries to post back to the extension.
  window.__ic_outbound = [];
  window.__ic_stateCalls = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { window.__ic_outbound.push(m); },
      // Counted so a spec can prove a host that keeps no view is never asked to (docs/standalone.md: view-kept-only-where-stated).
      getState: function () { window.__ic_stateCalls.push('get'); return window.__ic_state; },
      setState: function (s) { window.__ic_stateCalls.push('set'); window.__ic_state = s; }
    };
  };
  // Inject an inbound extension->webview message. Image and thumbnail payloads
  // may be given as a data: URL for convenience; they are converted here to the
  // binary bytes+mime wire shape (see ExtensionMessage in src/types.ts) BEFORE
  // dispatch, so the bundle sees exactly what the extension host sends.
  window.__ic_send = function (msg) {
    if (msg && (msg.type === 'image' || msg.type === 'thumbnail') && typeof msg.dataUrl === 'string' && !msg.bytes) {
      var m = /^data:([^;,]+);base64,(.*)$/.exec(msg.dataUrl);
      if (!m) throw new Error('__ic_send: ' + msg.type + ' dataUrl must be base64');
      var bin = atob(m[2]);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      msg = Object.assign({}, msg, { bytes: bytes, mime: m[1] });
      delete msg.dataUrl;
    }
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
