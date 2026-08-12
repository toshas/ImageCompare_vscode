import { test, expect } from '@playwright/test';
import { loadInited, getState, lastOutbound, focusViewer } from './helpers';

async function viewerCenter(page: import('@playwright/test').Page) {
  const box = await page.locator('#viewer').boundingBox();
  if (!box) throw new Error('no viewer box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe('zoom & pan', () => {
  test('wheel zooms in; Escape resets', async ({ page }) => {
    await loadInited(page);
    const { x, y } = await viewerCenter(page);

    await page.mouse.move(x, y);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -240); // scroll up = zoom in
    await expect.poll(async () => (await getState(page)).zoom).toBeGreaterThan(1.2);

    await page.keyboard.press('Escape');
    await expect.poll(async () => (await getState(page)).zoom).toBe(1);
  });
});

test.describe('crop mode', () => {
  test('C enters crop mode; drawing sets a crop rect; Enter posts cropImages', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press('c');
    await expect.poll(async () => (await getState(page)).cropMode).toBe(true);

    // Draw a rectangle across the central region of the viewer.
    const { box } = await viewerCenter(page);
    const x1 = box.x + box.width * 0.4;
    const y1 = box.y + box.height * 0.4;
    const x2 = box.x + box.width * 0.6;
    const y2 = box.y + box.height * 0.6;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();

    const rect = (await getState(page)).cropRect;
    expect(rect).not.toBeNull();
    expect(rect!.w).toBeGreaterThan(0);
    expect(rect!.h).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    const msg = await lastOutbound(page, 'cropImages');
    expect(msg).not.toBeNull();
    expect(msg.cropRect.w).toBeGreaterThan(0);
    expect(msg.srcWidth).toBe(320);
    expect(msg.srcHeight).toBe(200);
  });

  test('Escape cancels crop mode', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);
    await page.keyboard.press('c');
    await expect.poll(async () => (await getState(page)).cropMode).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await getState(page)).cropMode).toBe(false);
  });
});

test.describe('winner voting', () => {
  test('Enter toggles a winner and posts setWinner', async ({ page }) => {
    await loadInited(page);
    await focusViewer(page);

    await page.keyboard.press('Enter');
    const msg = await lastOutbound(page, 'setWinner');
    expect(msg).not.toBeNull();
    expect(msg.tupleIndex).toBe(0);
    expect(msg.modalityIndex).toBe(0);

    const winners = (await getState(page)).winners;
    expect(winners).toContainEqual([0, 0]);
  });
});
