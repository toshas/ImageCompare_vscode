import { defineConfig, devices } from '@playwright/test';

/**
 * Layer 3 — webview UX testbed.
 *
 * Drives the real dist/webview.js bundle in a headless Chromium, out of process
 * (no Electron/VSCode). Visual-regression baselines are LOCAL-ONLY: generated
 * and committed from one canonical machine (darwin-arm64) — see TESTING.md.
 * GPU is disabled (swiftshader) so canvas output is reproducible on that machine.
 */
export default defineConfig({
  testDir: './test/webview',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/webview/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{platform}{ext}',
  expect: {
    // Tolerant pixel threshold — canvas AA/text rendering is never bit-exact.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2 },
  },
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
