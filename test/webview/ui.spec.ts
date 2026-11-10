import { test, expect } from '@playwright/test';
import { loadInited, getState, lastOutbound, focusViewer } from './helpers';
import { centreOf } from './touchDriver';

test.describe('pointer interactions', () => {
  test('drag pans the image when zoomed in', async ({ page }) => {
    await loadInited(page);
    const { x: cx, y: cy } = await centreOf(page, '#viewer');

    // Pan only matters when zoomed in.
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -240);
    await expect.poll(async () => (await getState(page)).zoom).toBeGreaterThan(1.1);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 80, cy - 40, { steps: 8 });
    await page.mouse.up();

    const s = await getState(page);
    expect(Math.abs(s.panX) + Math.abs(s.panY)).toBeGreaterThan(0);
  });

  test('clicking a carousel thumbnail navigates to that tuple', async ({ page }) => {
    await loadInited(page);
    expect((await getState(page)).currentTupleIndex).toBe(0);
    // The carousel is a recycled pool of absolutely-positioned rows; DOM order
    // is pool order, so address rows by their bound tuple via data-tuple-index.
    await page.locator('.carousel-row[data-tuple-index="2"]').locator('.carousel-thumb').first().click();
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(2);
  });

  test('clicking a carousel winner circle posts setWinner', async ({ page }) => {
    await loadInited(page);
    await page.locator('.carousel-row[data-tuple-index="0"]').locator('.winner-circle').nth(1).click();
    const msg = await lastOutbound(page, 'setWinner');
    expect(msg).not.toBeNull();
    expect(msg.tupleIndex).toBe(0);
    expect(msg.modalityIndex).toBe(1);
    expect((await getState(page)).winners).toContainEqual([0, 1]);
  });
});

test.describe('keyboard actions', () => {
  test('Space (hold) flips to the previous modality, releases back', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    await page.keyboard.press('ArrowRight'); // modality 1, previous = 0
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);

    await page.keyboard.down('Space');
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(0);
    await page.keyboard.up('Space');
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);
  });
});

test.describe('tools window', () => {
  test('collapse button toggles the floating panel', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#floating-panel')).not.toHaveClass(/collapsed/);
    await page.locator('#fp-collapse-btn').click();
    await expect(page.locator('#floating-panel')).toHaveClass(/collapsed/);
    await page.locator('#fp-collapse-btn').click();
    await expect(page.locator('#floating-panel')).not.toHaveClass(/collapsed/);
  });
});

test.describe('help modal', () => {
  test('? opens the help modal and Esc closes it', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#help-modal')).not.toHaveClass(/active/);
    await page.locator('#help-btn').click();
    await expect(page.locator('#help-modal')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#help-modal')).not.toHaveClass(/active/);
  });
});
