import { test, expect } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';

/**
 * Regression: reordering modalities must move the pill TOOLTIP (original path)
 * together with the pill NAME. Previously the name reordered but the tooltip
 * stayed stuck to the startup order (modalityPaths was not swapped).
 *
 * Pills no longer use the native `title` attribute: the webview shows a custom
 * #pill-tooltip element on hover (a rewritten pill dismisses a native tooltip).
 * So we assert (a) the display-ordered modalityPaths via the state hook, and
 * (b) the tooltip text actually shown when hovering each pill.
 *
 * Fixture modalityPaths: GT -> /fixtures/GT, PRED -> /fixtures/PRED.
 */

async function hoverTooltip(page: import('@playwright/test').Page, pillIndex: number): Promise<string> {
  const pills = page.locator('#modality-selector .modality-btn');
  await pills.nth(pillIndex).hover();
  await expect(page.locator('#pill-tooltip')).toHaveClass(/visible/);
  const text = (await page.locator('#pill-tooltip').textContent()) ?? '';
  await page.mouse.move(0, 0); // leave the pill so the next hover re-aims the tooltip
  return text;
}

test.describe('modality reorder keeps name and tooltip in sync', () => {
  test('a pill drag moves both the pill name and its path tooltip', async ({ page }) => {
    await loadInited(page);
    const pills = page.locator('#modality-selector .modality-btn');

    // Startup order: [GT, PRED]
    await expect(pills.nth(0)).toHaveText(/GT/);
    expect(await hoverTooltip(page, 0)).toBe('/fixtures/GT');
    expect(await hoverTooltip(page, 1)).toBe('/fixtures/PRED');

    // Drag GT (index 0) past PRED's midpoint; the ← / → buttons this used to click are gone.
    const a = (await pills.nth(0).boundingBox())!;
    const b = (await pills.nth(1).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 3, a.y + a.height / 2, { steps: 8 });
    await page.mouse.up();

    // Now display order is [PRED, GT]; tooltips must follow.
    await expect(pills.nth(0)).toHaveText(/PRED/);
    await expect(pills.nth(1)).toHaveText(/GT/);
    expect((await getState(page)).modalityPaths).toEqual(['/fixtures/PRED', '/fixtures/GT']);
    expect(await hoverTooltip(page, 0)).toBe('/fixtures/PRED');
    expect(await hoverTooltip(page, 1)).toBe('/fixtures/GT');
  });

  test('] key reorder also keeps tooltips correct', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press(']'); // BracketRight -> move current modality right
    expect((await getState(page)).modalityOrder).toEqual([1, 0]);
    expect((await getState(page)).modalityPaths).toEqual(['/fixtures/PRED', '/fixtures/GT']);
    expect(await hoverTooltip(page, 0)).toBe('/fixtures/PRED');
    expect(await hoverTooltip(page, 1)).toBe('/fixtures/GT');
  });
});
