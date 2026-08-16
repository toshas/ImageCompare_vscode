import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, outbound, lastOutbound } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

// Pins the PPTX button contract (docs/crop-and-pptx.md, "No votes exports the whole view"):
// a no-votes click exports every tuple with a null winner instead of silently doing nothing,
// the button goes busy until the provider answers, and a busy button never posts a second
// exportPptx. Completion/error are injected via __ic_send — the harness IS the provider seam.

async function countExportMessages(page: Page): Promise<number> {
  return (await outbound(page)).filter((m) => m && m.type === 'exportPptx').length;
}

async function send(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => (window as unknown as { __ic_send: (m: unknown) => void }).__ic_send(m), msg);
}

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
  expect(await countExportMessages(page)).toBe(1);
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
  expect(await countExportMessages(page)).toBe(2);
});
