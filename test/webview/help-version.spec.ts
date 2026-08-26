import { test, expect } from '@playwright/test';
import { loadInited } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

test.describe('help modal version footer', () => {
  test('help modal shows the ImageCompare version carried by init', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, version: '9.9.9-test' });
    await page.click('#help-btn');
    await expect(page.locator('#help-modal')).toHaveClass(/active/);
    // Version literal comes from the fixture spec, not from any product manifest.
    await expect(page.locator('#help-version')).toBeVisible();
    await expect(page.locator('#help-version')).toHaveText('ImageCompare v9.9.9-test');
  });

  test('no version in init renders no footer (never "undefined")', async ({ page }) => {
    // DEFAULT_SPEC carries no version, matching every pre-existing harness spec.
    await loadInited(page);
    await page.click('#help-btn');
    await expect(page.locator('#help-modal')).toHaveClass(/active/);
    const modalText = await page.locator('#help-modal').innerText();
    expect(modalText).not.toContain('undefined');
    expect(modalText).not.toContain('ImageCompare v');
    await expect(page.locator('#help-version')).toBeHidden();
  });
});
