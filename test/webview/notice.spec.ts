import { test, expect } from '@playwright/test';
import { loadInited } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// These used to be vscode.window.showInformationMessage/showErrorMessage calls, so the standalone
// said nothing at all when an export or a copy finished. Now the host reports the event and the
// webview words it, for both (docs/standalone.md: affordances-rendered-by-the-webview).

const NO_REVEAL = {
  ...DEFAULT_SPEC,
  capabilities: { revealInExplorer: false, copyTextToClipboard: true, saveSessionAs: false },
};

const send = (page: import('@playwright/test').Page, msg: unknown) =>
  page.evaluate((m) => (window as any).__ic_send(m), msg as any);

test.describe('notices', () => {
  test('a host event is worded by the webview and offers reveal where the host can', async ({ page }) => {
    await loadInited(page);
    await send(page, { type: 'notice', event: { kind: 'sessionSaved', path: '/out/x.imagecompare' } });

    await expect(page.locator('#copy-toast')).toHaveClass(/visible/);
    await expect(page.locator('#copy-toast')).toContainText('Session saved: /out/x.imagecompare');
    await expect(page.locator('#notice-action')).toHaveText('Reveal in Explorer');

    await page.locator('#notice-action').click();
    expect(await page.evaluate(() => (window as any).__ic_lastOutbound('revealPath')))
      .toEqual({ type: 'revealPath', path: '/out/x.imagecompare' });
  });

  test('a host that cannot reveal gets the same words and no action', async ({ page }) => {
    await loadInited(page, NO_REVEAL);
    await send(page, { type: 'notice', event: { kind: 'sessionSaved', path: '/out/x.imagecompare' } });

    await expect(page.locator('#copy-toast')).toContainText('Session saved: /out/x.imagecompare');
    await expect(page.locator('#notice-action')).toHaveCount(0);
  });

  test('an error notice is toned as one and never offers an action', async ({ page }) => {
    await loadInited(page);
    await send(page, { type: 'notice', event: { kind: 'copyPathFailed', error: 'denied' } });

    await expect(page.locator('#copy-toast')).toHaveClass(/error/);
    await expect(page.locator('#copy-toast')).toHaveText('Could not copy the path: denied');
    await expect(page.locator('#notice-action')).toHaveCount(0);
  });

  // A faded action toast kept `has-action` (pointer-events: auto) and its Reveal button, leaving a
  // transparent ~400x32 strip over the viewer that ate clicks and could still reveal a file.
  test('a faded action notice stops taking clicks', async ({ page }) => {
    await loadInited(page);
    await send(page, { type: 'notice', event: { kind: 'sessionSaved', path: '/out/x.imagecompare' } });
    await expect(page.locator('#copy-toast')).toHaveClass(/has-action/);

    // Don't wait out the real 8s: the same hide path runs on the action's own click.
    await page.locator('#notice-action').click();
    await expect(page.locator('#copy-toast')).not.toHaveClass(/visible/);
    await expect(page.locator('#copy-toast')).not.toHaveClass(/has-action/);
    const overToast = await page.evaluate(() => {
      const r = document.getElementById('copy-toast')!.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id ?? '';
    });
    expect(overToast).not.toBe('copy-toast');
  });

  test('a failed export is toned as a failure, from the same channel', async ({ page }) => {
    await loadInited(page);
    await send(page, { type: 'pptxError', error: 'disk full' });
    await expect(page.locator('#copy-toast')).toHaveClass(/error/);
    await expect(page.locator('#copy-toast')).toHaveText('PPTX export failed: disk full');
    await expect(page.locator('#notice-action')).toHaveCount(0);
  });

  // pptxComplete already carried the path, in both products; the export's answer needed no new
  // wire message, only a webview that says it instead of a host-side notification.
  test('a finished export announces itself from the message both hosts already send', async ({ page }) => {
    await loadInited(page);
    await send(page, { type: 'pptxComplete', path: '/out/comparison_01.pptx' });

    await expect(page.locator('#copy-toast')).toContainText('PPTX exported: /out/comparison_01.pptx');
    await expect(page.locator('#notice-action')).toHaveText('Reveal in Explorer');
  });
});
