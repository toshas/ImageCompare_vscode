import { test, expect } from '@playwright/test';
import { loadInited, getState, outbound, lastOutbound, send, focusViewer } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

// Pins the PPTX button contract (docs/crop-and-pptx.md, "No votes exports the whole view"):
// a no-votes click exports every tuple with a null winner instead of silently doing nothing,
// the button goes busy until the provider answers, and a busy button never posts a second
// exportPptx. Completion/error are injected via __ic_send — the harness IS the provider seam.

test('PPTX export with no votes sends the whole view with null winners', async ({ page }) => {
  await loadInited(page);
  await page.locator('#pptx-btn').click();
  const msg = await lastOutbound(page, 'exportPptx');
  expect(msg).toBeTruthy();
  expect(msg.tupleIndices).toEqual(DEFAULT_SPEC.tupleNames.map((_, i) => i));
  expect(msg.winnerModalityIndices).toEqual(DEFAULT_SPEC.tupleNames.map(() => null));
  expect(msg.modalityOrder).toEqual(DEFAULT_SPEC.modalities.map((_, i) => i));
});

test('PPTX button goes busy on click and ignores re-clicks until completion', async ({ page }) => {
  await loadInited(page);
  await page.locator('#pptx-btn').click();
  expect((await getState(page)).pptxBusy).toBe(true);
  await page.locator('#pptx-btn').click({ force: true });
  expect((await outbound(page, 'exportPptx')).length).toBe(1);
  await send(page, { type: 'pptxComplete', path: '/tmp/comparison_01.pptx' });
  expect((await getState(page)).pptxBusy).toBe(false);
});

test('pptxError clears the busy state and allows a new export', async ({ page }) => {
  await loadInited(page);
  await page.locator('#pptx-btn').click();
  expect((await getState(page)).pptxBusy).toBe(true);
  await send(page, { type: 'pptxError', error: 'disk full' });
  expect((await getState(page)).pptxBusy).toBe(false);
  await page.locator('#pptx-btn').click();
  expect((await outbound(page, 'exportPptx')).length).toBe(2);
});

// The standalone adapter holds the posted message by reference and reads modalityOrder across
// awaits, as the harness's outbound log does; a move after the click must not reach the export.
test('a pill move after the click leaves the posted export order unchanged', async ({ page }) => {
  await loadInited(page, { ...DEFAULT_SPEC, modalities: ['A', 'B', 'C', 'D'] });
  await page.locator('#pptx-btn').click();
  await focusViewer(page);
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  expect((await getState(page)).modalityOrder).toEqual([1, 2, 0, 3]);
  const held = await page.evaluate(() =>
    (window as any).__ic_outbound.find((m: any) => m?.type === 'exportPptx').modalityOrder.slice());
  expect(held).toEqual([0, 1, 2, 3]);
});
