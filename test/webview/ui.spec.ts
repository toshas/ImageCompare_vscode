import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, lastOutbound, focusViewer } from './helpers';

async function viewerBox(page: Page) {
  const box = await page.locator('#viewer').boundingBox();
  if (!box) throw new Error('no viewer box');
  return box;
}

test.describe('pointer interactions', () => {
  test('drag pans the image when zoomed in', async ({ page }) => {
    await loadInited(page);
    const box = await viewerBox(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

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

  test('clicking a modality pill switches modality', async ({ page }) => {
    await loadInited(page);
    expect((await getState(page)).currentModalityIndex).toBe(0);
    await page.locator('.modality-btn').nth(1).click();
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);
  });

  test('clicking a carousel thumbnail navigates to that tuple', async ({ page }) => {
    await loadInited(page);
    expect((await getState(page)).currentTupleIndex).toBe(0);
    // Row 2 = scene_002; click its first thumbnail.
    await page.locator('.carousel-row').nth(2).locator('.carousel-thumb').first().click();
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(2);
  });

  test('clicking a carousel winner circle posts setWinner', async ({ page }) => {
    await loadInited(page);
    await page.locator('.carousel-row').nth(0).locator('.winner-circle').nth(1).click();
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

  test('[ reorders the current modality left', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    expect((await getState(page)).modalityOrder).toEqual([0, 1]);
    await page.keyboard.press('ArrowRight'); // move focus to modality at display pos 1
    await page.keyboard.press('['); // move it left to pos 0
    await expect.poll(async () => (await getState(page)).modalityOrder).toEqual([1, 0]);
  });
});

test.describe('tools window', () => {
  test('PPMX colormap select posts setPpmxColormap', async ({ page }) => {
    await loadInited(page);
    await page.locator('#ppmx-colormap-select').selectOption('jet');
    const msg = await lastOutbound(page, 'setPpmxColormap');
    expect(msg).not.toBeNull();
    expect(msg.colormap).toBe('jet');
    await expect.poll(async () => (await getState(page)).ppmxColormap).toBe('jet');
  });

  test('show-zoom toggle hides the zoom readout in the status bar', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#status-info')).toContainText('Zoom');
    await page.locator('#show-zoom-toggle').uncheck();
    await expect(page.locator('#status-info')).not.toContainText('Zoom');
  });

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
