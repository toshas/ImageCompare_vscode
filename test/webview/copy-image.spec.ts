import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';
import { makeSolidPng } from '../fixtures/synthetic';

// Real async-clipboard round-trip: grant read/write so navigator.clipboard works headless.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// Two tuples, one modality; tuple 1's image is re-sent with distinct dimensions
// below, so "which image is in the clipboard" is a deterministic width×height
// check — no pixel comparison.
const SPEC = {
  tupleNames: ['scene_000', 'scene_001'],
  modalities: ['GT'],
  width: 320,
  height: 200,
  votingEnabled: false,
};

const TUPLE1_DIMS = { width: 200, height: 120 };

async function sendImage(page: Page, tupleIndex: number, width: number, height: number): Promise<void> {
  const dataUrl = 'data:image/png;base64,' + makeSolidPng(width, height, [10, 200, 60]).toString('base64');
  await page.evaluate(
    (m) => (window as unknown as { __ic_send: (m: unknown) => void }).__ic_send(m),
    { type: 'image', tupleIndex, modalityIndex: 0, dataUrl, width, height },
  );
}

/** Decode the clipboard's PNG in-page and return its dimensions. */
async function readClipboardDims(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('image/png')) {
        const blob = await item.getType('image/png');
        const bmp = await createImageBitmap(blob);
        return { width: bmp.width, height: bmp.height };
      }
    }
    return { width: -1, height: -1 };
  });
}

async function resetToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('copy-toast')!.textContent = '';
  });
}

/** Wait for the copy path's completion toast and return its text. */
async function waitToast(page: Page): Promise<string> {
  await page.waitForFunction(() => document.getElementById('copy-toast')!.textContent !== '');
  return (await page.locator('#copy-toast').textContent()) ?? '';
}

/** Trigger 'copyImage' with the document focused and wait until the write settled. */
async function copyFocused(page: Page): Promise<string> {
  await resetToast(page);
  await page.evaluate(
    (m) => (window as unknown as { __ic_send: (m: unknown) => void }).__ic_send(m),
    { type: 'copyImage' },
  );
  return waitToast(page);
}

// Playwright keeps every page permanently "focused", so the real failure
// condition — the context-menu 'copyImage' message arriving while the webview
// document is unfocused (the workbench menu holds focus) — is emulated in-page:
// document.hasFocus() reports false and clipboard.write rejects with
// NotAllowedError, which is exactly Chromium's behavior for an unfocused
// document. The wrapper delegates to the REAL clipboard.write whenever
// "focused", so every readClipboardDims round-trip stays genuine.
async function installFocusEmulation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fakeUnfocused: boolean; __toBlobDone: number };
    w.__fakeUnfocused = false;
    document.hasFocus = () => !w.__fakeUnfocused;
    const realWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = (items: ClipboardItem[]) =>
      w.__fakeUnfocused
        ? Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'))
        : realWrite(items);
    // Counts completed toBlob callbacks so the test can await the copy pipeline deterministically.
    const realToBlob = HTMLCanvasElement.prototype.toBlob;
    w.__toBlobDone = 0;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string, quality?: number) {
      return realToBlob.call(
        this,
        (b) => {
          try {
            cb(b);
          } finally {
            w.__toBlobDone++;
          }
        },
        type,
        quality,
      );
    };
  });
}

/** Trigger 'copyImage' while "unfocused", then let focus return — the VS Code context-menu sequence. */
async function copyUnfocusedThenRefocus(page: Page): Promise<string> {
  await resetToast(page);
  await page.evaluate((m) => {
    const w = window as unknown as { __fakeUnfocused: boolean; __toBlobDone: number; __ic_send: (m: unknown) => void };
    w.__fakeUnfocused = true;
    w.__toBlobDone = 0;
    w.__ic_send(m);
  }, { type: 'copyImage' });
  // The copy pipeline has reached its clipboard write (or deferral) once toBlob's callback finished.
  await page.waitForFunction(() => (window as unknown as { __toBlobDone: number }).__toBlobDone > 0);
  // The menu closes and the webview document regains focus.
  await page.evaluate(() => {
    (window as unknown as { __fakeUnfocused: boolean }).__fakeUnfocused = false;
    window.dispatchEvent(new Event('focus'));
  });
  return waitToast(page);
}

test.describe('copy image', () => {
  test('copy writes the displayed image to the clipboard', async ({ page }) => {
    await loadInited(page, SPEC);
    await sendImage(page, 1, TUPLE1_DIMS.width, TUPLE1_DIMS.height);
    await focusViewer(page);

    const toast = await copyFocused(page);
    expect(toast).toBe('Image copied');
    expect(await readClipboardDims(page)).toEqual({ width: SPEC.width, height: SPEC.height });
  });

  test('copy after navigation writes the currently displayed image, not the first-copied one', async ({ page }) => {
    await loadInited(page, SPEC);
    await sendImage(page, 1, TUPLE1_DIMS.width, TUPLE1_DIMS.height);
    await focusViewer(page);
    await installFocusEmulation(page);

    const first = await copyFocused(page);
    expect(first).toBe('Image copied');
    expect(await readClipboardDims(page)).toEqual({ width: SPEC.width, height: SPEC.height });

    await page.keyboard.press('ArrowDown');
    expect((await getState(page)).currentTupleIndex).toBe(1);

    // Context-menu copy: the message lands while the workbench menu still holds focus.
    const second = await copyUnfocusedThenRefocus(page);
    expect(await readClipboardDims(page)).toEqual(TUPLE1_DIMS);
    expect(second).toBe('Image copied');
  });
});
