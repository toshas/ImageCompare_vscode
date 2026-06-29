import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, lastOutbound, outbound, focusViewer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Replace navigator.clipboard.write with a spy that records the item types. */
async function stubClipboard(page: Page) {
  await page.evaluate(() => {
    (window as any).__clipWrites = [];
    (navigator as any).clipboard = (navigator as any).clipboard || {};
    (navigator as any).clipboard.write = (items: any[]) => {
      (window as any).__clipWrites.push(items.map((i) => i.types));
      return Promise.resolve();
    };
  });
}

async function dragMarquee(page: Page) {
  const a = await page.locator('.carousel-thumb-container').first().boundingBox();
  const b = await page.locator('.carousel-thumb-container').last().boundingBox();
  if (!a || !b) throw new Error('missing tiles');
  await page.mouse.move(a.x + 3, a.y + 3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 3, b.y + b.height - 3, { steps: 20 });
  await page.mouse.up();
}

test.describe('single-image copy (bitmap)', () => {
  test('Ctrl/Cmd+C with no selection writes an image/png to the clipboard', async ({ page }) => {
    await loadInited(page);
    await stubClipboard(page);
    await focusViewer(page);

    await page.keyboard.press('Control+c');

    await expect.poll(async () => (await getState(page)).selectionCount).toBe(0);
    await expect.poll(async () => await lastOutbound(page, 'copyImageResult')).not.toBeNull();
    const msg = await lastOutbound(page, 'copyImageResult');
    expect(msg.ok).toBe(true);
    const writes = await page.evaluate(() => (window as any).__clipWrites);
    expect(writes).toEqual([[['image/png']]]);
  });
});

test.describe('marquee multi-selection', () => {
  test('dragging selects multiple tiles without changing the current image', async ({ page }) => {
    await loadInited(page);
    const before = await getState(page);

    await dragMarquee(page);

    const s = await getState(page);
    expect(s.selectionCount).toBe(6); // 3 tuples x 2 modalities
    // The current tuple/modality (the "previously selected" image) is untouched.
    expect(s.currentTupleIndex).toBe(before.currentTupleIndex);
    expect(s.currentModalityIndex).toBe(before.currentModalityIndex);
  });

  test('Ctrl/Cmd+C with a selection posts copyFiles (not an image copy)', async ({ page }) => {
    await loadInited(page);
    await stubClipboard(page);
    await dragMarquee(page);
    await expect.poll(async () => (await getState(page)).selectionCount).toBe(6);

    await page.keyboard.press('Control+c');

    const msg = await lastOutbound(page, 'copyFiles');
    expect(msg).not.toBeNull();
    expect(msg.items.length).toBe(6);
    // It took the files path, not the bitmap path.
    const all = await outbound(page);
    expect(all.some((m: any) => m.type === 'copyImageResult')).toBe(false);
    // The bitmap clipboard path was NOT taken, so no image was written.
    expect(await page.evaluate(() => (window as any).__clipWrites)).toEqual([]);
  });

  test('dragging to the bottom edge auto-scrolls and extends the selection (Explorer-style)', async ({
    page,
  }) => {
    const many = {
      tupleNames: Array.from({ length: 14 }, (_, i) => `scene_${String(i).padStart(3, '0')}`),
      modalities: ['GT', 'PRED'],
      width: 320,
      height: 200,
      votingEnabled: true,
    };
    await loadInited(page, many);

    // The carousel must overflow for auto-scroll to be meaningful.
    const overflows = await page.evaluate(() => {
      const c = document.getElementById('carousel')!;
      return c.scrollHeight > c.clientHeight;
    });
    expect(overflows).toBe(true);

    const first = await page.locator('.carousel-thumb-container').first().boundingBox();
    const cbox = await page.locator('#carousel').boundingBox();
    if (!first || !cbox) throw new Error('layout missing');

    await page.mouse.move(first.x + 3, first.y + 3);
    await page.mouse.down();
    // Drag to the bottom-right edge zone (covers both columns) and hold.
    await page.mouse.move(cbox.x + cbox.width - 6, cbox.y + cbox.height - 6, { steps: 12 });
    await page.waitForTimeout(3000); // let it auto-scroll to the bottom
    await page.mouse.up();

    const scrolled = await page.evaluate(() => document.getElementById('carousel')!.scrollTop);
    expect(scrolled).toBeGreaterThan(0); // it auto-scrolled
    // Extended far beyond the ~12 initially-visible tiles — all 14x2 selected.
    expect((await getState(page)).selectionCount).toBe(28);
  });

  test('marquee skips empty (missing-modality) tiles — count matches files copied', async ({
    page,
  }) => {
    // 4 tuples x 2 modalities = 8 tiles, with 2 missing-modality (empty) slots,
    // mirroring the user's test_folder + test2 comparison.
    const spec = {
      tupleNames: ['s0', 's1', 's2', 's3'],
      modalities: ['GT', 'PRED'],
      width: 160,
      height: 120,
      votingEnabled: true,
      emptySlots: [
        [3, 0],
        [3, 1],
      ] as [number, number][],
    };
    await loadInited(page, spec);
    await stubClipboard(page);

    await dragMarquee(page); // drag across the whole carousel

    // 8 tiles, 2 empty → only 6 real images selected (not 8).
    const s = await getState(page);
    expect(s.selectionCount).toBe(6);
    expect(s.selection.some((i) => i.tupleIndex === 3)).toBe(false); // empty tuple excluded

    await page.keyboard.press('Control+c');
    const msg = await lastOutbound(page, 'copyFiles');
    expect(msg.items.length).toBe(6); // every selected tile resolves to a real file
  });

  test('clicking empty carousel space clears the selection', async ({ page }) => {
    await loadInited(page);
    await dragMarquee(page);
    await expect.poll(async () => (await getState(page)).selectionCount).toBe(6);

    // Click below the last row (empty carousel area).
    const box = await page.locator('#carousel').boundingBox();
    if (!box) throw new Error('no carousel');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
    await expect.poll(async () => (await getState(page)).selectionCount).toBe(0);
  });
});
