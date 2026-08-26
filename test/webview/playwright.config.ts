import * as os from 'node:os';
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
  // Sized from availableParallelism(), never the reported core count: on a cgroup-limited,
  // SLURM-allocated or container host cpus() reports every core on the machine (256 on this box,
  // 4 usable), and Playwright's default 50%-of-cpus() then starts dozens of Chromiums on a
  // handful of cores until specs time out for reasons that have nothing to do with the change
  // under test. Same trap, same call, as the extension's own pool width
  // (docs/loading-architecture.md: pool-width-hides-latency). The 50% shape is Playwright's own
  // default, so on every host where the two counts agree — every CI runner — the sizing is
  // unchanged; only the constrained hosts move. A `--workers=N` flag still overrides this.
  workers: Math.max(1, Math.floor(os.availableParallelism() / 2)),
  // Traces go beside the specs, the HTML report to the repo root: Playwright refuses a report
  // folder nested inside the test output folder ("output folder clashes"), and leaving outputDir
  // at its default put it at <cwd>/test-results, the report's own parent. Both paths are covered
  // by the `test-results/` .gitignore rule, which matches that directory name at any depth.
  outputDir: './test-results',
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
