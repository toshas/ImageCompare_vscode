import { test, expect, Page } from '@playwright/test';
import { HARNESS_URL } from './harness';
import { initMessage, DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Rows were pooled; columns were not, so every bound row materialized EVERY modality. On the field
// grid (265 x 136) that put 7752 tiles and 76 719 DOM nodes in the wall, and a DevTools trace of it
// being scrolled spent its main thread in Layerize, Paint and Commit rather than in script
// (docs/loading-architecture.md: columns-virtualize-like-rows).
//
// NO MUTATION COVERS THIS FILE — it asserts DOM counts and layout, which the Vitest-only harness
// cannot reach (docs/testing.md, "What nothing covers"). The window and pool arithmetic IS
// mutation-covered, in test/unit/columnWindow.test.ts. What stands in for the rest: each assertion
// here was watched failing against the pre-change bundle, where tiles-per-row equalled the modality
// count exactly.

const wide = (mods: number) => ({
  ...DEFAULT_SPEC,
  tupleNames: Array.from({ length: 60 }, (_, i) => `s_${i}`),
  modalities: Array.from({ length: mods }, (_, i) => `M${i}`),
});

async function load(page: Page, mods: number): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).__ic_outbound.some((m: any) => m?.type === 'ready'));
  await page.evaluate((m) => (window as any).__ic_send(m), initMessage(wide(mods)) as any);
  await page.waitForFunction(() => (window as any).__ic_test.getState().tupleCount === 60);
  await expect(page.locator('#viewer')).toHaveClass(/active/);
}

/** What the wall actually holds, and how wide the strip it is being fitted into is. */
const shape = (page: Page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('.carousel-row').length;
    const tiles = document.querySelectorAll('.carousel-thumb').length;
    const scroller = document.getElementById('carousel-hscroll') as HTMLElement | null;
    return { rows, tiles, perRow: rows ? tiles / rows : 0, viewport: scroller?.clientWidth ?? 0 };
  });

test.describe('column virtualization', () => {
  // The acceptance criterion, stated without reference to the implementation: doubling the columns
  // must not put a single extra tile in the DOM. Pre-change this failed by construction — tiles per
  // row WAS the modality count, so 68 -> 136 doubled the wall.
  test('doubling the modalities does not grow the DOM', async ({ page }) => {
    await load(page, 68);
    const small = await shape(page);
    await load(page, 136);
    const big = await shape(page);

    expect(small.perRow).toBe(big.perRow);
    expect(big.perRow).toBeLessThan(136);
    // Bounded by the strip it is drawn into: at the narrowest a tile may be (12px + 2px gap), plus
    // the overscan either side and a spare. Derived from the geometry, not from the module.
    const bound = Math.ceil(big.viewport / 14) + 2 * 2 + 2;
    expect(big.perRow).toBeLessThanOrEqual(bound);
  });

  test('the materialized columns are the ones on screen, in the right places', async ({ page }) => {
    await load(page, 136);
    const shown = await page.evaluate(() => {
      const row = document.querySelector('.carousel-row') as HTMLElement;
      return Array.from(row.querySelectorAll('.carousel-thumb-container'))
        .filter((c) => (c as HTMLElement).style.display !== 'none')
        .map((c) => ({
          idx: Number((c.querySelector('.carousel-thumb') as HTMLElement).dataset.displayIndex),
          left: parseFloat((c as HTMLElement).style.left),
        }))
        .sort((a, b) => a.idx - b.idx);
    });
    expect(shown.length).toBeGreaterThan(0);
    // A contiguous run starting at the left edge, each one pitch further along than the last.
    expect(shown[0].idx).toBe(0);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i].idx).toBe(shown[i - 1].idx + 1);
      expect(shown[i].left).toBeGreaterThan(shown[i - 1].left);
    }
    const pitch = shown[1].left - shown[0].left;
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i].left - shown[i - 1].left).toBeCloseTo(pitch, 3);
    }
  });

  test('scrolling the strip materializes later columns and releases earlier ones', async ({ page }) => {
    await load(page, 136);
    const idsNow = () =>
      page.evaluate(() => {
        const row = document.querySelector('.carousel-row') as HTMLElement;
        return Array.from(row.querySelectorAll('.carousel-thumb-container'))
          .filter((c) => (c as HTMLElement).style.display !== 'none')
          .map((c) => Number((c.querySelector('.carousel-thumb') as HTMLElement).dataset.displayIndex))
          .sort((a, b) => a - b);
      });
    const before = await idsNow();
    expect(before).toContain(0);

    await page.evaluate(() => { document.getElementById('carousel-hscroll')!.scrollLeft = 99999; });
    await expect.poll(async () => (await idsNow()).includes(135)).toBe(true);

    const after = await idsNow();
    // The far end is bound and the near end has been given up — the count never grew.
    expect(after).toContain(135);
    expect(after).not.toContain(0);
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  // Widening the strip needs more slots than the ring was built with. Growing it discards the row
  // pool, so growth ordered after the pool's own fill left `pool === 0` and the ring divided by it:
  // page errors on a multi-frame drag, and a frame where the carousel emptied. Widening to see more
  // columns is the obvious reaction to a 136-column grid, so this is the path that broke.
  //
  // The fix is two calls — one at the top of ensureVisibleCarouselRows, one before the resize path
  // rebinds — and EITHER ONE alone hides the crash, because whichever runs first leaves the other a
  // no-op. So this test only goes red with both reverted (8 page errors); reverting one and watching
  // it stay green proves nothing. It guards the pair, not either call.
  test('widening the carousel grows the ring without dropping the rows', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await load(page, 136);
    const before = await shape(page);
    expect(before.rows).toBeGreaterThan(0);

    // Drag the resize handle right in steps, as a real drag delivers it.
    const handle = page.locator('#carousel-resize');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let x = 40; x <= 240; x += 40) {
      await page.mouse.move(box.x + 2 + x, box.y + box.height / 2);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(120);

    expect(errors).toEqual([]);
    const after = await shape(page);
    expect(after.rows).toBeGreaterThan(0);
    expect(after.viewport).toBeGreaterThan(before.viewport);
    // The ring grew with the strip, and still binds a contiguous run with no column on two slots.
    const ids = await page.evaluate(() => {
      const row = document.querySelector('.carousel-row') as HTMLElement;
      return Array.from(row.querySelectorAll('.carousel-thumb-container'))
        .filter((c) => (c as HTMLElement).style.display !== 'none')
        .map((c) => Number((c.querySelector('.carousel-thumb') as HTMLElement).dataset.displayIndex));
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(after.perRow).toBeGreaterThanOrEqual(before.perRow);
  });

  // A regression guard, not a new-behaviour assertion: this passes pre-change too, because click
  // targeting already worked. It is here because virtualization moves displayIndex from creation
  // time to bind time, which is exactly how a recycled tile starts reporting the wrong column.
  test('a tile still knows which slot it shows, so clicks land on the right column', async ({ page }) => {
    await load(page, 136);
    await page.evaluate(() => { document.getElementById('carousel-hscroll')!.scrollLeft = 99999; });
    await expect.poll(() =>
      page.evaluate(() => {
        const row = document.querySelector('.carousel-row') as HTMLElement;
        return Array.from(row.querySelectorAll('.carousel-thumb-container'))
          .some((c) => (c.querySelector('.carousel-thumb') as HTMLElement).dataset.displayIndex === '135');
      })).toBe(true);

    await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll('.carousel-row .carousel-thumb'))
        .find((i) => (i as HTMLElement).dataset.displayIndex === '135') as HTMLElement;
      img.click();
    });
    await expect.poll(() => page.evaluate(() => (window as any).__ic_test.getState().currentModalityIndex)).toBe(135);
  });
});
