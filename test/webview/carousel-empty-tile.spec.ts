import { test, expect, Page } from '@playwright/test';
import { getState, focusViewer } from './helpers';
import { HARNESS_URL } from './harness';
import { initMessage, colorFor, FixtureSpec } from '../fixtures/messages';
import { makeSolidPng } from '../fixtures/synthetic';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Enough rows that the pool (~one screen + overscan) must recycle: rows that carried a thumbnail
// are rebound onto tuples whose thumbnails have not arrived yet, which is what the open-time sweep
// does under any scrolling at all.
const N = 120;
const LOADED = 20;
const SPEC: FixtureSpec = {
  tupleNames: Array.from({ length: N }, (_, i) => `scene_${String(i).padStart(3, '0')}`),
  modalities: ['GT', 'PRED'],
  width: 64,
  height: 40,
  votingEnabled: true,
};

const thumbUrl = (t: number): string =>
  'data:image/png;base64,' + makeSolidPng(64, 40, colorFor(t % 3, 0)).toString('base64');

async function send(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
}

/** Init with N tuples and no thumbnails at all — every tile starts on an empty slot. */
async function initEmpty(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() =>
    (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'),
  );
  await send(page, initMessage(SPEC));
  await expect(page.locator('#viewer')).toHaveClass(/active/);
}

/** Deliver the first LOADED tuples' thumbnails, as the sweep does, and wait for them to paint. */
async function deliverHead(page: Page): Promise<void> {
  const msgs: any[] = [];
  for (let t = 0; t < LOADED; t++)
    for (let m = 0; m < 2; m++)
      msgs.push({ type: 'thumbnail', tupleIndex: t, modalityIndex: m, dataUrl: thumbUrl(t) });
  await page.evaluate((list) => {
    for (const m of list) (window as any).__ic_send(m);
  }, msgs);
  await expect
    .poll(() =>
      page.$$eval('.carousel-row[data-tuple-index="5"] .carousel-thumb', (imgs) =>
        imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
}

/** Scroll past the delivered head so pooled rows are rebound onto not-yet-delivered tuples. */
async function scrollPastDelivered(page: Page): Promise<void> {
  await focusViewer(page);
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(60);
  // Give any (buggy) async image state a turn to settle before the tiles are read.
  await page.waitForTimeout(300);
}

const tileOf = (tuple: number) =>
  `.carousel-row[data-tuple-index="${tuple}"] .carousel-thumb[data-modality="0"]`;

test.describe('carousel tiles for slots with no thumbnail', () => {
  // The reported regression: recycled rows paint the browser's broken-image glyph where a blank
  // tile belongs, interspersed with the correctly blank ones. `img.removeAttribute('src')` on an
  // element that already loaded one leaves Chromium's *broken* image state — it paints the glyph
  // and fires no error event, so the ✕ fallback never runs and nothing in the DOM distinguishes it
  // from a fresh tile. Comparing the two paints in the same run is what catches it; the reference
  // is another tile of this same page, not a golden file, so it is OS- and theme-independent.
  test('a recycled empty tile paints exactly like a never-filled one', async ({ page }) => {
    await initEmpty(page);
    // Reference: a plain, never-filled tile (not the current row, so no active/selected border).
    const fresh = await page.locator(tileOf(5)).screenshot();

    await deliverHead(page);
    await scrollPastDelivered(page);

    // Tuple 65's row is a pool slot recycled off a delivered row onto a slot with no thumbnail.
    const recycled = await page.locator(tileOf(65)).screenshot();
    expect(recycled.equals(fresh)).toBe(true);
  });

  // The blank must not swallow the ✕: "not delivered yet" and "this file is gone" are different
  // states and a missing modality must not look like a slow one (docs/loading-architecture.md:
  // empty-tile-never-broken, decode-retry-once).
  test('a genuinely missing slot still shows the ✕, not the blank', async ({ page }) => {
    await initEmpty(page);
    const fresh = await page.locator(tileOf(5)).screenshot();

    await deliverHead(page);
    // Tuple 65 is in the not-yet-swept region: one slot is reported gone, its neighbour row is
    // simply pending. Both rows bind during the scroll below.
    await send(page, { type: 'thumbnailError', tupleIndex: 65, modalityIndex: 0, error: 'gone' });
    await scrollPastDelivered(page);

    const missing = page.locator(tileOf(65));
    const pending = page.locator(tileOf(66));
    await expect(missing).toHaveClass(/missing/);
    await expect(pending).not.toHaveClass(/missing/);
    await expect(pending).toHaveClass(/placeholder/);

    // Not the same picture: the ✕ is the missing slot's src, the pending one holds the 1x1 blank
    // (transparent — pinned byte-wise in test/unit/thumbUrlCache.test.ts).
    const crossSrc = await missing.getAttribute('src');
    const blankSrc = await pending.getAttribute('src');
    expect(crossSrc).toBeTruthy();
    expect(blankSrc).toBeTruthy();
    expect(blankSrc).not.toBe(crossSrc);
    expect(await pending.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);

    const missingShot = await missing.screenshot();
    const pendingShot = await pending.screenshot();
    expect(pendingShot.equals(fresh)).toBe(true);
    expect(missingShot.equals(pendingShot)).toBe(false);
  });

  // The rule that keeps it that way: an empty slot's tile carries a src that decodes, never a
  // removed one (docs/loading-architecture.md: empty-tile-never-broken).
  test('every visible tile carries a decodable src, before and after recycling', async ({
    page,
  }) => {
    await initEmpty(page);

    const undecodable = () =>
      page.$$eval('.carousel-row', (rows) =>
        rows
          .filter((r) => (r as HTMLElement).style.display !== 'none')
          .flatMap((r) => Array.from(r.querySelectorAll('img')))
          .filter((i) => !((i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))
          .map((i) => `${(i as HTMLElement).dataset.tuple}-${(i as HTMLElement).dataset.modality}`),
      );

    await expect.poll(undecodable).toEqual([]);

    await deliverHead(page);
    await scrollPastDelivered(page);

    expect(await undecodable()).toEqual([]);
  });
});
