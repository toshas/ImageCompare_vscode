import { defineConfig, devices } from '@playwright/test';

/**
 * Layer 3 — webview UX testbed.
 *
 * Drives the real dist/webview.js bundle in a headless Chromium, out of process
 * (no Electron/VSCode). All assertions are deterministic logic checks via the
 * window.__ic_test state hook, so the suite is OS-agnostic and runs unchanged in
 * CI on Linux/Windows/macOS. Software GL (swiftshader) keeps canvas rendering
 * headless-safe on every runner.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // HTML report lands under the repo-root test-results/ (gitignored); CI uploads
  // it as an artifact only when the suite fails.
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../test-results/webview-html-report', open: 'never' }],
  ],
  use: {
    viewport: { width: 1100, height: 720 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--disable-gpu-compositing',
        '--force-color-profile=srgb',
        '--allow-file-access-from-files',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
