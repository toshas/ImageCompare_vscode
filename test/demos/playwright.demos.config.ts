import { defineConfig, devices } from '@playwright/test';

/**
 * Feature demo recorder (separate from the test suite).
 *
 * Records a short video of each feature being exercised on real photo
 * fixtures (test/demos/photoFixtures.ts), then build-gallery.mjs converts
 * each to a small H.264 MP4. Run via `npm run test:demos`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: '../webview/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './raw',
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
