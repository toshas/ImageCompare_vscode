import { test, expect } from '@playwright/test';
import { loadInited, getState, openMenuOn, pickMenuAction } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The menu used to be VS Code's, contributed in package.json and dispatched through extension
// commands — so a browser showed its own menu instead and Hide Modality, whose only trigger was
// that menu, was unreachable in the standalone (docs/standalone.md: affordances-rendered-by-the-webview).
// These drive the real bundle: whatever they assert here holds in both products.
//
// NO MUTATION COVERS THIS FILE. The rules here live in DOM code (`webview/main.ts`,
// `webview/contextMenu.ts`) and the mutation harness runs Vitest suites only, so Layer 3 is the
// only layer that can reach them at all (docs/testing.md, "What nothing covers"). What stands in
// for a mutation: each of the three rules added after review — keys not acting behind an open
// menu, the menu closing when the host re-indexes slots, and the faded action toast releasing
// clicks — was verified by reverting its fix and watching this suite go red. The model half of
// the same behaviour IS mutation-covered, in test/unit/contextMenuModel.test.ts.

const NO_REVEAL = {
  ...DEFAULT_SPEC,
  capabilities: { revealInExplorer: false, copyTextToClipboard: true, saveSessionAs: false },
};

test.describe('context menu', () => {
  test('right-clicking the image offers the image items and suppresses the browser menu', async ({ page }) => {
    await loadInited(page);
    const defaultPrevented = await page.evaluate(() => {
      let prevented: boolean | null = null;
      window.addEventListener('contextmenu', (e) => { prevented = e.defaultPrevented; }, false);
      document.getElementById('canvas')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      return prevented;
    });
    expect(defaultPrevented).toBe(true);
    expect(await page.locator('#context-menu .context-menu-item').allTextContents())
      .toEqual(['Copy Image', 'Copy Path', 'Reveal in Explorer']);
  });

  test('right-clicking a pill offers the pill items, and Hide Modality hides it', async ({ page }) => {
    await loadInited(page);
    expect(await openMenuOn(page, '.modality-btn')).toEqual(['Copy Path', 'Reveal in Explorer', 'Hide Modality']);
    await pickMenuAction(page, 'toggleHidden');

    expect((await getState(page)).hiddenModalities).toEqual([0]);
    await expect(page.locator('.modality-btn').first()).toHaveClass(/hidden-modality/);

    // The label follows the state, and the toggle is reversible from the same menu.
    expect(await openMenuOn(page, '.modality-btn')).toContain('Show Modality');
    await pickMenuAction(page, 'toggleHidden');
    expect((await getState(page)).hiddenModalities).toEqual([]);
  });

  test('a host action the webview cannot perform goes to the host, and a local one never does', async ({ page }) => {
    await loadInited(page);
    await openMenuOn(page, '.modality-btn');
    await pickMenuAction(page, 'copyPath');
    const sent = await page.evaluate(() => (window as any).__ic_lastOutbound('menuAction'));
    expect(sent).toMatchObject({ action: 'copyPath', ctx: { section: 'pill', modalityIndex: 0 } });

    // Copy Image is local: picking it must leave the wire untouched.
    await openMenuOn(page, '#canvas');
    await expect(page.locator('#context-menu [data-action-id="toggleHidden"]')).toHaveCount(0);
    await pickMenuAction(page, 'copyImage');
    const all = await page.evaluate(() => (window as any).__ic_outbound.filter((m: any) => m?.type === 'menuAction'));
    expect(all.map((m: any) => m.action)).toEqual(['copyPath']);
  });

  test('a host that cannot reveal is never offered the item', async ({ page }) => {
    await loadInited(page, NO_REVEAL);
    expect(await openMenuOn(page, '#canvas')).toEqual(['Copy Image', 'Copy Path']);
    expect(await openMenuOn(page, '.modality-btn')).toEqual(['Copy Path', 'Hide Modality']);
  });

  test('Escape dismisses the menu without also resetting the view', async ({ page }) => {
    await loadInited(page);
    await page.evaluate(() => (window as any).__ic_test.getState());
    await page.mouse.move(300, 200);
    await page.mouse.wheel(0, -200); // zoom in, so a stray Escape would be visible as zoom === 1
    await page.waitForFunction(() => (window as any).__ic_test.getState().zoom !== 1);
    const zoomed = (await getState(page)).zoom;

    await openMenuOn(page, '.modality-btn');
    await page.keyboard.press('Escape');
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);
    expect((await getState(page)).zoom).toBe(zoomed);
  });

  test('a click elsewhere dismisses the menu', async ({ page }) => {
    await loadInited(page);
    await openMenuOn(page, '.modality-btn');
    await page.locator('#status').click();
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);
  });

  // The host menu this replaced was modal; ours is a plain div, so nothing swallowed keys until it
  // was made to. Del behind an open menu is a permanent file delete.
  test('keys do not act behind an open menu', async ({ page }) => {
    await loadInited(page);
    await openMenuOn(page, '.modality-btn');
    const before = await page.evaluate(() => (window as any).__ic_outbound.length);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (window as any).__ic_outbound.length)).toBe(before);
    expect((await getState(page)).currentTupleIndex).toBe(0);
    await expect(page.locator('#context-menu')).toHaveClass(/visible/);
  });

  // The target is frozen when the menu opens. A click or a key cannot move under it (mousedown
  // dismisses, keys are swallowed) but the WATCHER can: a delete re-indexes every later slot while
  // currentTupleIndex stays 0, so the frozen target would name a different file than it did.
  test('the menu closes when the host re-indexes the tuples under it', async ({ page }) => {
    await loadInited(page);
    expect((await getState(page)).currentTupleName).toBe('scene_000');
    await openMenuOn(page, '#canvas');

    await page.evaluate(() => (window as any).__ic_send({ type: 'tupleDeleted', tupleIndex: 0 }));
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);
    // Same index, different file — which is exactly why the frozen target had to go.
    const state = await getState(page);
    expect(state.currentTupleIndex).toBe(0);
    expect(state.currentTupleName).toBe('scene_001');
  });

  test('the help modal names only the items this host offers', async ({ page }) => {
    await loadInited(page, NO_REVEAL);
    await page.locator('#help-btn').click();
    await expect(page.locator('#help-contextmenu-items'))
      .toHaveText('Copy Image / Copy Path / Hide/Show Modality');
    // Save Session As has no meaning here, so the row is gone rather than lying.
    await expect(page.locator('#help-row-savesession')).toBeHidden();
  });
});
