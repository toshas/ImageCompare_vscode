#!/usr/bin/env node
/**
 * Where the dashboard's intermediate JSON goes, and the commands that write it.
 *
 * Shared with scripts/check-generated-output.mjs so that checker probes the REAL
 * wiring instead of a copy of it — if these paths or env vars drift, both move.
 *
 * Playwright's three JSON-reporter env vars do NOT share an anchor:
 * PLAYWRIGHT_JSON_OUTPUT_FILE / _DIR resolve against process.cwd(), but
 * PLAYWRIGHT_JSON_OUTPUT_NAME resolves against the CONFIG directory. A
 * repo-root-relative value passed as _NAME therefore lands under
 * test/webview/<value> — the doubled path that leaked absolute paths once
 * already. See the Findings entry in docs/testing.md.
 */
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Throws unless `p` is absolute — a relative report path re-anchors silently (see above). */
export function assertAbsolute(name, p) {
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new Error(
      `${name} must be an absolute path, got ${JSON.stringify(p)}.\n` +
      'Reporter output paths are anchored differently by every runner (Playwright resolves\n' +
      '_OUTPUT_NAME against the config dir, _OUTPUT_FILE against the cwd); only an absolute\n' +
      'path means the same thing to all of them. See docs/testing.md.'
    );
  }
  return p;
}

export const ROOT = join(__dirname, '..', '..');
// NOT under test-results/: Playwright's default outputDir is test-results/ and it WIPES that dir
// at the start of its run, which would delete unit.json (written earlier by the generator).
export const RESULTS = assertAbsolute('RESULTS', join(ROOT, '.dashboard-data'));
export const UNIT_JSON = assertAbsolute('UNIT_JSON', join(RESULTS, 'unit.json'));
export const WEBVIEW_JSON = assertAbsolute('WEBVIEW_JSON', join(RESULTS, 'webview.json'));
export const INTEGRATION_JSON = assertAbsolute('INTEGRATION_JSON', join(RESULTS, 'integration.json'));

export const WEBVIEW_CMD = 'npx playwright test --config test/webview/playwright.config.ts --reporter=json';

/** Env for WEBVIEW_CMD: cwd-anchored (the generator runs every suite with cwd = ROOT). */
export const webviewEnv = (outFile = WEBVIEW_JSON) => ({
  PLAYWRIGHT_JSON_OUTPUT_FILE: assertAbsolute('PLAYWRIGHT_JSON_OUTPUT_FILE', outFile),
});
