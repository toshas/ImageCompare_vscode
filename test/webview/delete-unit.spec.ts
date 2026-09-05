import { test, expect, Page } from '@playwright/test';
import { loadInited, getState } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// What Del removes is stated by the host on init and rendered by the webview — the same
// host-states-data seam as HostCapabilities (docs/session-files.md: mode-behaviour-is-a-table).
// The webview never asks which mode it is in, so these specs drive it purely through `deleteUnit`.
//
// NO MUTATION COVERS THIS FILE — Layer 3 is outside the harness, which runs Vitest suites only
// (docs/testing.md, "What nothing covers"). The policy that produces the unit IS mutation-covered,
// in test/unit/modePolicy.test.ts. What stands in for the rest: SIX of the seven tests here were
// watched failing against the pre-change bundle, which posted `deleteTuple` unconditionally and
// whose Del help row was a static string in the shell. The seventh is labelled below.

const outbound = (page: Page, type: string) =>
  page.evaluate((t) => (window as any).__ic_outbound.filter((m: any) => m?.type === t), type);

test.describe('what Del removes is the host\'s to state', () => {
  // REGRESSION GUARD, not a new-behaviour assertion: this passes against the pre-change bundle too,
  // which posted `deleteTuple` for everything. It is here because the branch added beside it is
  // exactly how the unchanged path starts posting the wrong message.
  test('a tuple-unit host gets deleteTuple, naming the row and nothing else', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'tuple' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');

    expect(await outbound(page, 'deleteImage')).toEqual([]);
    const sent = await outbound(page, 'deleteTuple');
    expect(sent).toHaveLength(1);
    expect(sent[0].tupleIndex).toBe(1);
    expect(sent[0].modalityIndex).toBeUndefined();
  });

  test('an image-unit host gets deleteImage, naming the slot on screen', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'image' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');

    expect(await outbound(page, 'deleteTuple')).toEqual([]);
    const sent = await outbound(page, 'deleteImage');
    expect(sent).toHaveLength(1);
    expect(sent[0].tupleIndex).toBe(0);
    expect(sent[0].modalityIndex).toBe(1);
  });

  // The trap virtualization and reordering both set: the strip's position is a DISPLAY index and the
  // wire wants the ORIGINAL. With the two columns swapped, display 0 is original 1 — so a flow that
  // posted the raw cursor would delete the file the user is not looking at.
  test('a reordered strip still names the original column, not the screen position', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'image' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('[');
    expect((await getState(page)).modalityOrder).toEqual([1, 0]);
    expect((await getState(page)).currentModalityIndex).toBe(0);

    await page.keyboard.press('Delete');
    const sent = await outbound(page, 'deleteImage');
    expect(sent).toHaveLength(1);
    expect(sent[0].modalityIndex).toBe(1);
  });

  test('the Tools-panel button and the key agree on the unit', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'image' });
    await page.locator('#delete-btn').click();
    expect(await outbound(page, 'deleteImage')).toHaveLength(1);
    expect(await outbound(page, 'deleteTuple')).toEqual([]);
  });
});

test.describe('the affordances say which unit they mean', () => {
  test('the help row and the button hint follow the declared unit', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'image' });
    await page.click('#help-btn');
    await expect(page.locator('#help-modal')).toHaveClass(/active/);
    await expect(page.locator('#help-delete-text')).toHaveText('Delete current image file (permanent!)');
    await expect(page.locator('#delete-btn')).toHaveAttribute('title', 'Delete current image file (Del)');
  });

  test('a tuple-unit host keeps the row wording', async ({ page }) => {
    await loadInited(page, { ...DEFAULT_SPEC, deleteUnit: 'tuple' });
    await page.click('#help-btn');
    await expect(page.locator('#help-delete-text')).toHaveText('Delete current tuple files (permanent!)');
    await expect(page.locator('#delete-btn')).toHaveAttribute('title', 'Delete current tuple files (Del)');
  });

  // An init predating the field claims nothing, and an unstated unit is the row — the shape every
  // mode but the file list has, and the one every existing spec's fixture expects.
  test('an init naming no unit deletes the row', async ({ page }) => {
    await loadInited(page, DEFAULT_SPEC);
    expect((await getState(page)).deleteUnit).toBe('tuple');
    await page.keyboard.press('Delete');
    expect(await outbound(page, 'deleteTuple')).toHaveLength(1);
  });
});
