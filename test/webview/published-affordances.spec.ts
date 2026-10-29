import { test, expect, Page } from '@playwright/test';
import { loadInited, getState } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// What a host states and the webview renders, for the affordances a published comparison changes
// (docs/standalone.md, "Publishing a comparison"): the PPTX button only where the host can hand
// over a file (`exportPptx`), the results.txt button only where the host copies votes out
// (`copyResults`) and voting is on, and Delete greyed — Del ignored — while its target holds a file
// the host flagged `readOnly` (docs/standalone.md: published-originals-never-written). The webview
// never asks which product it is in; these specs drive it purely through the init payload.
//
// NO MUTATION COVERS THIS FILE — Layer 3 is outside the harness, which runs Vitest suites only
// (docs/testing.md, "What nothing covers"). The data feeding it IS mutation-covered: the flags in
// test/unit/publishedComparison.test.ts and test/unit/contextMenuModel.test.ts, the readOnly flag in
// test/unit/initPayload.test.ts. What stands in for the rest: every test here was watched failing
// against a break of its own site in src/webview/main.ts (the button visibility, the PPTX and
// results click guards, the read-only predicate for each delete unit, its refresh in render() and
// the Del guard). The structural-change test survives removing either one refresh site, since
// render() and loadTuple() both re-decide; it dies when the predicate does.

const outbound = (page: Page, type: string) =>
  page.evaluate((t) => (window as any).__ic_outbound.filter((m: any) => m?.type === t), type);

const send = (page: Page, msg: unknown) =>
  page.evaluate((m) => (window as any).__ic_send(m), msg as any);

const BASE_CAPS = { revealInExplorer: false, copyTextToClipboard: true, saveSessionAs: false };

test.describe('the PPTX and results.txt buttons follow the host\'s flags', () => {
  test('a host that cannot hand over a file shows no PPTX button and is never sent an export', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, capabilities: { ...BASE_CAPS, exportPptx: false, copyResults: true } });
    await expect(page.locator('#pptx-btn')).toBeHidden();
    await page.evaluate(() => (document.getElementById('pptx-btn') as HTMLButtonElement).click());
    expect(await outbound(page, 'exportPptx')).toEqual([]);
  });

  test('a host that can shows the PPTX button, and no results.txt button unless it copies votes', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, capabilities: { ...BASE_CAPS, exportPptx: true, copyResults: false } });
    await expect(page.locator('#pptx-btn')).toBeVisible();
    await expect(page.locator('#results-btn')).toBeHidden();
  });

  test('an init stating no flags offers neither', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, capabilities: BASE_CAPS });
    await expect(page.locator('#pptx-btn')).toBeHidden();
    await expect(page.locator('#results-btn')).toBeHidden();
  });

  test('the results.txt button shows with copyResults and voting, and posts copyResults', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, capabilities: { ...BASE_CAPS, exportPptx: false, copyResults: true } });
    const btn = page.locator('#results-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('results.txt');
    await expect(btn).toHaveAttribute('title', 'Copy results.txt to the clipboard');
    await btn.click();
    expect(await outbound(page, 'copyResults')).toEqual([{ type: 'copyResults' }]);
  });

  test('the results.txt button stays hidden where voting is off', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, votingEnabled: false, capabilities: { ...BASE_CAPS, exportPptx: false, copyResults: true } });
    await expect(page.locator('#results-btn')).toBeHidden();
    await page.evaluate(() => (document.getElementById('results-btn') as HTMLButtonElement).click());
    expect(await outbound(page, 'copyResults')).toEqual([]);
  });
});

test.describe('Delete is greyed while its target is read-only', () => {
  test('a row holding a read-only file greys Delete and Del does nothing; a writable row deletes', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'tuple', readOnly: [[0, 1]] });
    const del = page.locator('#delete-btn');
    await expect(del).toBeDisabled();
    await expect(del).toHaveAttribute('title', /read-only/i);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    expect(await outbound(page, 'deleteTuple')).toEqual([]);

    await page.keyboard.press('ArrowDown');
    expect((await getState(page)).currentTupleIndex).toBe(1);
    await expect(del).toBeEnabled();
    await expect(del).toHaveAttribute('title', 'Delete current tuple files (Del)');
    await page.keyboard.press('Delete');
    const sent = await outbound(page, 'deleteTuple');
    expect(sent).toHaveLength(1);
    expect(sent[0].tupleIndex).toBe(1);
  });

  test('with an image unit only the read-only image greys Delete', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'image', readOnly: [[0, 0]] });
    const del = page.locator('#delete-btn');
    await expect(del).toBeDisabled();
    await page.keyboard.press('Delete');
    expect(await outbound(page, 'deleteImage')).toEqual([]);

    await page.keyboard.press('ArrowRight');
    await expect(del).toBeEnabled();
    await page.keyboard.press('Delete');
    const sent = await outbound(page, 'deleteImage');
    expect(sent).toHaveLength(1);
    expect([sent[0].tupleIndex, sent[0].modalityIndex]).toEqual([0, 1]);
  });

  test('a structural change re-decides it: removing the read-only row frees Delete without navigating', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'tuple', readOnly: [[0, 0], [0, 1]] });
    const del = page.locator('#delete-btn');
    await expect(del).toBeDisabled();
    await send(page, { type: 'tupleDeleted', tupleIndex: 0 });
    expect((await getState(page)).currentTupleName).toBe('scene_001');
    await expect(del).toBeEnabled();
  });

  test('an arrival carries no flag: a viewer-made row is deletable', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'tuple', readOnly: [[0, 0], [1, 0], [2, 0]] });
    const del = page.locator('#delete-btn');
    await expect(del).toBeDisabled();
    await send(page, {
      type: 'tupleAdded',
      tupleIndex: 3,
      tuple: {
        name: 'scene_002_crop01',
        images: DEFAULT_SPEC.modalities.map((modality, modalityIndex) => ({ name: `scene_002_crop01_${modality}.png`, modality, tupleIndex: 3, modalityIndex })),
      },
    });
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(3);
    await expect(del).toBeEnabled();
  });
});
