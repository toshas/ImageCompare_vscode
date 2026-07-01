import { test, expect } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';

test.describe('keyboard navigation', () => {
  test('Down/Up move between tuples', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press('ArrowDown');
    expect((await getState(page)).currentTupleIndex).toBe(1);

    await page.keyboard.press('ArrowDown');
    expect((await getState(page)).currentTupleIndex).toBe(2);

    await page.keyboard.press('ArrowUp');
    expect((await getState(page)).currentTupleIndex).toBe(1);
  });

  test('Right/Left switch modality', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press('ArrowRight');
    expect((await getState(page)).currentModalityIndex).toBe(1);

    await page.keyboard.press('ArrowLeft');
    expect((await getState(page)).currentModalityIndex).toBe(0);
  });

  test('number keys jump to a modality', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press('2');
    expect((await getState(page)).currentModalityIndex).toBe(1);

    await page.keyboard.press('1');
    expect((await getState(page)).currentModalityIndex).toBe(0);
  });

  test('active modality pill reflects current modality', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    await page.keyboard.press('ArrowRight');
    const pills = page.locator('#modality-selector .modality-btn');
    await expect(pills.nth(1)).toHaveClass(/active/);
  });
});
