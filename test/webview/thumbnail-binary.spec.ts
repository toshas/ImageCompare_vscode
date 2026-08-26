import { test, expect, Page, Locator } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';
import { initMessage, colorFor } from '../fixtures/messages';
import { makeSolidPng } from '../fixtures/synthetic';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The harness converts a dataUrl-shaped thumbnail into the real {bytes, mime} wire payload before
// dispatch, exactly like the extension host posts it — the spec never hand-builds a Uint8Array.
const pngUrl = (w: number, h: number): string =>
  'data:image/png;base64,' + makeSolidPng(w, h, colorFor(1, 0)).toString('base64');

const TILE = '.carousel-row[data-tuple-index="1"] .carousel-thumb[data-modality="0"]';

async function send(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
}

/** Decoded pixel width of the tile — 0 while a src is undecodable, unset or revoked before decode. */
async function paintedWidth(tile: Locator): Promise<number> {
  return tile.evaluate((el) => (el as HTMLImageElement).naturalWidth);
}

async function liveUrls(page: Page): Promise<number> {
  return (await getState(page)).thumbUrlsLive;
}

test.describe('carousel thumbnails on the binary wire', () => {
  test('a thumbnail payload paints from an object url, not a data url', async ({ page }) => {
    await loadInited(page);

    const tile = page.locator(TILE);
    // Fixture thumbnails are 64x40 solid pngs delivered as bytes+mime.
    await expect.poll(() => paintedWidth(tile)).toBe(64);
    const src = await tile.getAttribute('src');
    expect(src?.startsWith('blob:')).toBe(true);
    await expect(tile).not.toHaveClass(/placeholder/);
    await expect(tile).not.toHaveClass(/missing/);

    // One live url per delivered thumbnail: 3 tuples x 2 modalities.
    expect(await liveUrls(page)).toBe(6);
  });

  test('a superseded delivery releases exactly one url and the replacement still decodes', async ({
    page,
  }) => {
    await loadInited(page);
    const tile = page.locator(TILE);
    await expect.poll(() => paintedWidth(tile)).toBe(64);
    const first = await tile.getAttribute('src');

    // A different size distinguishes the replacement's decode from the superseded one's.
    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: pngUrl(32, 20) });

    // Revoking the incoming url instead of the superseded one leaves this at 0 forever.
    await expect.poll(() => paintedWidth(tile)).toBe(32);
    expect(await tile.getAttribute('src')).not.toBe(first);
    // Replaced, not accumulated: a second url for the same slot would push this to 7.
    expect(await liveUrls(page)).toBe(6);
  });

  test('pooled-row rebinds repaint from the cache without revoking a live url', async ({ page }) => {
    await loadInited(page);
    const tile = page.locator(TILE);
    await expect.poll(() => paintedWidth(tile)).toBe(64);
    const src = await tile.getAttribute('src');

    // Navigation rebinds every bound pool row — the repaint path the virtualized carousel recycles
    // rows through. A row that revoked the url it was showing would blank every other row's tile.
    await focusViewer(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(1);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(0);

    expect(await tile.getAttribute('src')).toBe(src);
    expect(await liveUrls(page)).toBe(6);
    // Still decoded after four rebinds: nothing revoked the url the cache still hands out.
    expect(await paintedWidth(tile)).toBe(64);
    const widths = await page.$$eval('.carousel-row .carousel-thumb', (imgs) =>
      imgs
        .filter((i) => (i.parentElement?.parentElement as HTMLElement)?.style.display !== 'none')
        .map((i) => (i as HTMLImageElement).naturalWidth),
    );
    expect(widths.every((w) => w === 64)).toBe(true);
  });

  test('the error placeholder releases the slot url and a re-init releases all of them', async ({
    page,
  }) => {
    await loadInited(page);
    await expect.poll(() => liveUrls(page)).toBe(6);

    // A placeholder overwrite is an eviction like any other: the blob it replaces must go.
    await send(page, { type: 'thumbnailError', tupleIndex: 1, modalityIndex: 0, error: 'gone' });
    await expect(page.locator(TILE)).toHaveClass(/missing/);
    expect(await liveUrls(page)).toBe(5);

    // A deleted tuple drops its row's urls (2 modalities) and re-keys the rest.
    await send(page, { type: 'tupleDeleted', tupleIndex: 0 });
    expect(await liveUrls(page)).toBe(3);

    await send(page, initMessage());
    expect(await liveUrls(page)).toBe(0);
  });
});
