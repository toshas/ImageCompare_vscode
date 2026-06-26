import { test, expect } from '@playwright/test';
import { loadInited, getState } from './helpers';

test.describe('webview init / shell', () => {
  test('renders the viewer and ingests fixtures', async ({ page }) => {
    await loadInited(page);

    await expect(page.locator('#loading')).toHaveClass(/hidden/);
    await expect(page.locator('#viewer')).toHaveClass(/active/);
    await expect(page.locator('#info')).not.toHaveClass(/hidden/);

    const state = await getState(page);
    expect(state.tupleCount).toBe(3);
    expect(state.modalityCount).toBe(2);
    expect(state.currentTupleIndex).toBe(0);
    expect(state.currentModalityIndex).toBe(0);
    expect(state.zoom).toBe(1);
  });

  test('renders a modality pill per modality', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#modality-selector .modality-btn')).toHaveCount(2);
  });

  test('shows the floating panel tools', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#crop-btn')).toBeVisible();
    await expect(page.locator('#pptx-btn')).toBeVisible();
    await expect(page.locator('#delete-btn')).toBeVisible();
  });
});
