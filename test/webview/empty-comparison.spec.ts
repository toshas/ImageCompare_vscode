import { test, expect, Page } from '@playwright/test';
import { loadInited, getState } from './helpers';
import { colorFor } from '../fixtures/messages';
import { makeSolidPng } from '../fixtures/synthetic';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The reported symptom: deleting the comparison's folder leaves a spinner over a preview of the
// last image the panel happened to have. Two detectors race to produce it and they land the webview
// in two DIFFERENT shapes — zero tuples (the per-file sweep commits each removal, and the last one
// takes the row and then its columns) and zero modalities (the modality-dir watcher strips every
// column but leaves the emptied rows behind). Both must reach the same terminal notice, which is why
// each case below drives the wire messages the extension really sends rather than a shared helper.

async function send(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
}

/** DEFAULT_SPEC is 3 rows x 2 columns; delete every row, as committing each file's removal does. */
async function deleteEveryTuple(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await send(page, { type: 'tupleDeleted', tupleIndex: 0 });
  // The last row leaving empties both columns, and the provider posts that too.
  await send(page, { type: 'modalityRemoved', modalityIndex: 1 });
  await send(page, { type: 'modalityRemoved', modalityIndex: 0 });
}

/** The modality-dir path: every column stripped, the emptied rows left in place. */
async function removeEveryModality(page: Page): Promise<void> {
  await send(page, { type: 'modalityRemoved', modalityIndex: 1 });
  await send(page, { type: 'modalityRemoved', modalityIndex: 0 });
}

/** Opaque (alpha != 0) pixel count of a canvas — a drawn frame is not a class, so neither is the check. */
async function opaquePixels(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return 0;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
    return n;
  }, selector);
}

/**
 * The graceful end state: no spinner, and no stale frame on EITHER surface that can hold one — the
 * canvas, and the floating panel's minimap, which is the "preview of the very last image it saw".
 */
async function expectTerminalNotice(page: Page, detail: RegExp): Promise<void> {
  await expect(page.locator('#empty-notice')).toBeVisible();
  await expect(page.locator('#empty-notice-detail')).toHaveText(detail);
  await expect(page.locator('#canvas')).toBeHidden();
  await expect(page.locator('#image-loader')).not.toHaveClass(/active/);
  await expect.poll(() => opaquePixels(page, '#thumb-canvas')).toBe(0);
  await expect(page.locator('#thumb-viewport')).toBeHidden();
}

/** The minimap really was carrying the frame first, so the assertion above cannot pass vacuously. */
async function expectMinimapPainted(page: Page): Promise<void> {
  await expect.poll(() => opaquePixels(page, '#thumb-canvas')).toBeGreaterThan(0);
}

test.describe('empty comparison', () => {
  test('every row deleted leaves a notice, not a spinner over the last frame', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#canvas')).toBeVisible();
    await expectMinimapPainted(page);

    await deleteEveryTuple(page);

    expect((await getState(page)).tupleCount).toBe(0);
    await expectTerminalNotice(page, /deleted/i);
  });

  test('the last frame does not survive the last row, before the emptied columns are posted', async ({ page }) => {
    await loadInited(page);
    await expectMinimapPainted(page);
    // The wire state between the last row's removal and its emptied columns': zero rows, columns still registered.
    for (let i = 0; i < 3; i++) await send(page, { type: 'tupleDeleted', tupleIndex: 0 });

    const state = await getState(page);
    expect(state.tupleCount).toBe(0);
    expect(state.modalityCount).toBe(2);
    await expectTerminalNotice(page, /deleted/i);
  });

  test('every modality removed leaves the same notice, though the emptied rows survive', async ({ page }) => {
    await loadInited(page);
    await expectMinimapPainted(page);

    await removeEveryModality(page);

    const state = await getState(page);
    expect(state.modalityCount).toBe(0);
    expect(state.tupleCount).toBe(3); // the rows the column-removal step leaves behind
    await expectTerminalNotice(page, /deleted/i);
  });

  test('a comparison whose folder is gone names the folder instead', async ({ page }) => {
    await loadInited(page);
    await expectMinimapPainted(page);

    // The extension establishes the root is gone before the per-file deletions commit.
    await send(page, { type: 'rootMissing', path: '/data/exp1' });
    await deleteEveryTuple(page);

    await expectTerminalNotice(page, /\/data\/exp1/);
    await expect(page.locator('#empty-notice-title')).toHaveText(/no longer exists/i);
  });

  test('a folder that comes back clears the notice and shows its images', async ({ page }) => {
    await loadInited(page);
    await expectMinimapPainted(page);
    await send(page, { type: 'rootMissing', path: '/data/exp1' });
    await deleteEveryTuple(page);
    await expectTerminalNotice(page, /\/data\/exp1/);

    // Re-adoption, in the order the provider re-detects it: the dir lists again, then its column, then its rows.
    await send(page, { type: 'rootMissing', path: null });
    await expect(page.locator('#empty-notice-detail')).toHaveText(/deleted/i);

    await send(page, {
      type: 'modalityAdded',
      modality: 'GT',
      modalityPath: '/data/exp1/GT',
      modalityColors: ['#0f0'],
      modalityIndex: 0,
    });
    await send(page, {
      type: 'tupleAdded',
      tupleIndex: 0,
      tuple: {
        name: 'scene_000',
        images: [{ name: 'scene_000_GT.png', modality: 'GT', tupleIndex: 0, modalityIndex: 0 }],
      },
    });
    await send(page, {
      type: 'image',
      tupleIndex: 0,
      modalityIndex: 0,
      dataUrl: 'data:image/png;base64,' + makeSolidPng(320, 200, colorFor(0, 0)).toString('base64'),
      width: 320,
      height: 200,
    });

    await expect(page.locator('#empty-notice')).toBeHidden();
    await expect(page.locator('#canvas')).toBeVisible();
    await expect(page.locator('#image-loader')).not.toHaveClass(/active/);
    // Cleared, not disabled: the returning image repaints the minimap like any other.
    await expectMinimapPainted(page);
    const state = await getState(page);
    expect(state.tupleCount).toBe(1);
    expect(state.currentTupleIndex).toBe(0);
    await expect(page.locator('#status-name')).toHaveText(/scene_000_GT\.png/);
  });
});
