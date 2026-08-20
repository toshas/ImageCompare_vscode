import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';
import { colorFor } from '../fixtures/messages';
import { makeSolidPng } from '../fixtures/synthetic';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Bytes that no image decoder accepts — models a thumbnail generated from a truncated mid-write read.
// The harness turns each dataUrl into the real {bytes, mime} payload the extension posts.
const CORRUPT_DATA_URL =
  'data:image/png;base64,' + Buffer.from('truncated-mid-write-not-a-png').toString('base64');

const VALID_DATA_URL =
  'data:image/png;base64,' + makeSolidPng(64, 40, colorFor(1, 0)).toString('base64');

const TILE = '.carousel-row[data-tuple-index="1"] .carousel-thumb[data-modality="0"]';

async function send(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
}

async function requestCountFor(page: Page, tupleIndex: number): Promise<number> {
  return page.evaluate(
    (t) =>
      (window as any).__ic_outbound.filter(
        (m: any) =>
          m &&
          m.type === 'requestThumbnails' &&
          Array.isArray(m.tupleIndices) &&
          m.tupleIndices.includes(t),
      ).length,
    tupleIndex,
  );
}

// The designed placeholder presentation is whatever the thumbnailError path renders; capture it
// from a reference slot so the corrupt-decode path is pinned to the same class + src, not pixels.
async function errorPlaceholderSrc(page: Page): Promise<string> {
  await send(page, { type: 'thumbnailError', tupleIndex: 2, modalityIndex: 1, error: 'ref' });
  const ref = page.locator('.carousel-row[data-tuple-index="2"] .carousel-thumb[data-modality="1"]');
  await expect(ref).toHaveClass(/missing/);
  const src = await ref.getAttribute('src');
  expect(src).toBeTruthy();
  return src!;
}

test.describe('carousel thumbnail decode failure', () => {
  test('corrupt thumbnail payload falls back to the error placeholder and re-requests once', async ({
    page,
  }) => {
    await loadInited(page);
    const placeholderSrc = await errorPlaceholderSrc(page);

    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: CORRUPT_DATA_URL });

    // (1) Never the naked browser glyph: the tile must settle on the designed ✕ presentation.
    const tile = page.locator(TILE);
    await expect(tile).toHaveClass(/missing/);
    await expect(tile).not.toHaveClass(/placeholder/);
    expect(await tile.getAttribute('src')).toBe(placeholderSrc);

    // (2) Exactly one recovery re-request for the affected tuple went out.
    await expect.poll(() => requestCountFor(page, 1)).toBe(1);

    // (4) A second corrupt delivery (the retry's response) must not re-request endlessly.
    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: CORRUPT_DATA_URL });
    await expect(tile).toHaveClass(/missing/);
    expect(await tile.getAttribute('src')).toBe(placeholderSrc);
    expect(await requestCountFor(page, 1)).toBe(1);
  });

  test('valid thumbnail after a decode failure restores the tile and re-arms the retry', async ({
    page,
  }) => {
    await loadInited(page);
    const placeholderSrc = await errorPlaceholderSrc(page);

    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: CORRUPT_DATA_URL });
    const tile = page.locator(TILE);
    await expect(tile).toHaveClass(/missing/);
    await expect.poll(() => requestCountFor(page, 1)).toBe(1);

    // (3) A later valid delivery fully restores the tile: a real decoded image, no placeholder/missing state.
    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: VALID_DATA_URL });
    await expect(tile).not.toHaveClass(/missing/);
    await expect(tile).not.toHaveClass(/placeholder/);
    expect((await tile.getAttribute('src'))?.startsWith('blob:')).toBe(true);
    await expect.poll(() => tile.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(64);

    // A fresh failure after recovery gets its own single retry (the guard re-arms, no sticky lockout).
    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: CORRUPT_DATA_URL });
    await expect(tile).toHaveClass(/missing/);
    expect(await tile.getAttribute('src')).toBe(placeholderSrc);
    await expect.poll(() => requestCountFor(page, 1)).toBe(2);
  });

  // Pins the placeholder-cache write in handleThumbDecodeFailure: pooled-row rebinds must repaint
  // the cached placeholder, not the corrupt url. Without the cache write, every rebind re-fires
  // onerror and the consume/re-arm of thumbRetried posts a fresh requestThumbnails every second
  // rebind — an unbounded request stream over a scroll session.
  test('pool rebinds after a decode failure keep the placeholder and never re-request', async ({
    page,
  }) => {
    await loadInited(page);
    const placeholderSrc = await errorPlaceholderSrc(page);

    await send(page, { type: 'thumbnail', tupleIndex: 1, modalityIndex: 0, dataUrl: CORRUPT_DATA_URL });
    const tile = page.locator(TILE);
    await expect(tile).toHaveClass(/missing/);
    await expect.poll(() => requestCountFor(page, 1)).toBe(1);

    // Keyboard navigation runs loadTuple -> updateCarouselSelection -> bindCarouselRow on every
    // bound pool slot — the same repaint path the virtualized carousel's scroll recycling uses.
    // Four rebinds cover a full consume/re-arm cycle of the retry guard. Waiting for `missing`
    // between presses lets any (buggy) async onerror settle before the next rebind.
    await focusViewer(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(1);
    await expect(tile).toHaveClass(/missing/);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(0);
    await expect(tile).toHaveClass(/missing/);
    await page.keyboard.press('ArrowDown');
    await expect(tile).toHaveClass(/missing/);
    await page.keyboard.press('ArrowUp');
    await expect(tile).toHaveClass(/missing/);

    // The tile still shows the designed placeholder and no extra request ever went out.
    expect(await tile.getAttribute('src')).toBe(placeholderSrc);
    await expect(tile).not.toHaveClass(/placeholder/);
    expect(await requestCountFor(page, 1)).toBe(1);
  });
});
