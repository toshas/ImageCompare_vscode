import { defineConfig } from '@vscode/test-cli';

// Layer 2 — integration tests run inside a real (headless) VSCode instance.
// Compile first with `tsc -p test/integration/tsconfig.integration.json` (wired
// into the test:integration npm script). On first run this downloads a VSCode
// build. When IC_JSON_OUT is set (by the dashboard generator) emit a Mocha JSON
// report to that file instead of the console reporter.
//
// This file stays at the repo root: @vscode/test-cli infers the extension under
// test from the config's own directory (it reads the adjacent package.json).
const jsonOut = process.env.IC_JSON_OUT;

export default defineConfig({
  files: 'out-integration/test/integration/**/*.test.js',
  // CI's engines-floor job pins this to the oldest supported VS Code; forks (Cursor/VSCodium) trail stable, so the floor is what they actually run.
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    ...(jsonOut ? { reporter: 'json', reporterOptions: { output: jsonOut } } : {}),
  },
});
