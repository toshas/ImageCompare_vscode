import { defineConfig, devices } from '@playwright/test';

/**
 * Feature demo recorder (separate from the test suite).
 *
 * Records a short video of each feature being exercised on the deterministic
 * synthetic fixtures, then build-gallery.mjs converts each to a tiny animated
 * WebP. Flat fixture colors compress to a few KB. Run via `npm run test:demos`.
 */
export default defineConfig({
  testDir: './test/demos',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/webview/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test/demos/raw',
  use: {
    viewport: { width: 960, height: 600 },
    video: { mode: 'on', size: { width: 960, height: 600 } },
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
