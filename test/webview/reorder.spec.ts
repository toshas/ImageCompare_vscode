import { test, expect } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';

/**
 * Regression: reordering modalities must move the pill TOOLTIP (original path)
 * together with the pill NAME. Previously the name reordered but the title
 * stayed stuck to the startup order (modalityPaths was not swapped).
 *
 * Fixture modalityPaths: GT -> /fixtures/GT, PRED -> /fixtures/PRED.
 */
test.describe('modality reorder keeps name and tooltip in sync', () => {
  test('reorder-right swaps both the pill name and its path tooltip', async ({ page }) => {
    await loadInited(page);
    const pills = page.locator('#modality-selector .modality-btn');

    // Startup order: [GT, PRED]
    await expect(pills.nth(0)).toHaveText(/GT/);
    await expect(pills.nth(0)).toHaveAttribute('title', '/fixtures/GT');
    await expect(pills.nth(1)).toHaveAttribute('title', '/fixtures/PRED');

    // Move current modality (GT, index 0) to the right via the reorder button.
    await page.locator('#reorder-right').click();

    // Now display order is [PRED, GT]; tooltips must follow.
    await expect(pills.nth(0)).toHaveText(/PRED/);
    await expect(pills.nth(0)).toHaveAttribute('title', '/fixtures/PRED');
    await expect(pills.nth(1)).toHaveText(/GT/);
    await expect(pills.nth(1)).toHaveAttribute('title', '/fixtures/GT');
  });

  test('] key reorder also keeps tooltips correct', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    const pills = page.locator('#modality-selector .modality-btn');

    await page.keyboard.press(']'); // BracketRight -> move current modality right
    expect((await getState(page)).modalityOrder).toEqual([1, 0]);
    await expect(pills.nth(0)).toHaveAttribute('title', '/fixtures/PRED');
    await expect(pills.nth(1)).toHaveAttribute('title', '/fixtures/GT');
  });
});
