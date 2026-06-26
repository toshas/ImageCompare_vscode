import { test, expect } from '@playwright/test';
import { loadInited, focusViewer } from './helpers';

/**
 * Visual-regression guard. Baselines are LOCAL-ONLY (darwin-arm64) — regenerate
 * with `npm run test:webview:update` on the canonical machine. The canvas paints
 * synthetic solid colors, so under swiftshader the bytes are stable.
 */
test.describe('visual regression', () => {
  test('canvas renders modality 0 (GT)', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#canvas')).toHaveScreenshot('canvas-tuple0-gt.png');
  });

  test('canvas renders modality 1 (PRED) after ArrowRight', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#canvas')).toHaveScreenshot('canvas-tuple0-pred.png');
  });

  test('status bar + modality pills layout', async ({ page }) => {
    await loadInited(page);
    // Mask the zoom readout which can vary; assert the chrome layout otherwise.
    await expect(page.locator('#info')).toHaveScreenshot('info-bar.png', {
      mask: [page.locator('#status-info')],
    });
  });
});
