import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, hideModalityViaMenu } from './helpers';
import { DEFAULT_SPEC, FixtureSpec } from '../fixtures/messages';
import { TouchDriver, centreOf } from './touchDriver';
import { WEBVIEW_STYLES } from '../../src/webviewShell';

/**
 * The touch layout (docs/pointer-input.md, "The touch layout"), on the real bundle. A `hasTouch`
 * context makes `(pointer: coarse)` match in Chromium, which is the one thing the layout is gated on;
 * the default context is the fine-pointer negative. All of it is DOM and pointer wiring in
 * webview/touchInput.ts, webview/main.ts and webviewShell.ts, outside the Vitest-only mutation
 * harness — see docs/testing.md, "What nothing covers".
 */

const THREE: FixtureSpec = { ...DEFAULT_SPEC, modalities: ['GT', 'PRED', 'X'] };
const STRIP: FixtureSpec = {
  ...DEFAULT_SPEC,
  modalities: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
  tupleNames: Array.from({ length: 40 }, (_, i) => `scene_${String(i).padStart(3, '0')}`),
};

/** The middle of the image area, clear of the bar and of the (closed) strip. */
async function imageCentre(page: Page) {
  const box = (await page.locator('#viewer').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('touch layout gate', () => {
  test('a fine primary pointer keeps the desktop layout: no touch-ui, no ▦, the strip beside the image', async ({ page }) => {
    await loadInited(page);
    expect(await page.evaluate(() => document.body.classList.contains('touch-ui'))).toBe(false);
    await expect(page.locator('#strip-btn')).toBeHidden();
    await expect(page.locator('#carousel')).toBeVisible();
    await expect(page.locator('#viewer')).not.toHaveClass(/strip-closed/);
    const { offset, width } = await page.evaluate(() => ({
      offset: document.getElementById('viewer')!.style.getPropertyValue('--carousel-offset'),
      width: document.getElementById('carousel')!.getBoundingClientRect().width,
    }));
    expect(parseFloat(offset)).toBeGreaterThan(0);
    expect(parseFloat(offset)).toBeCloseTo(width, 0);
    // Tiles are centre-cropped in both layouts.
    expect(await page.locator('.carousel-thumb').first().evaluate((el) => getComputedStyle(el).objectFit)).toBe('cover');
    // Desktop help never shows the touch rows, and does list the drag.
    await page.click('#help-btn');
    const help = await page.locator('#help-modal').innerText();
    expect(help).not.toContain('Touch and hold');
    expect(help).toContain('Drag a pill');
    expect(help).toContain('Keyboard Shortcuts');
  });
});

test.describe('touch layout (coarse pointer)', () => {
  test.use({ hasTouch: true });

  test('a coarse primary pointer gets touch-ui, the ▦ button and a closed strip that covers no image width', async ({ page }) => {
    await loadInited(page);
    expect(await page.evaluate(() => document.body.classList.contains('touch-ui'))).toBe(true);
    await expect(page.locator('#strip-btn')).toBeVisible();
    await expect(page.locator('#viewer')).toHaveClass(/strip-closed/);
    await expect(page.locator('#carousel')).toBeHidden();
    const offset = await page.evaluate(() => document.getElementById('viewer')!.style.getPropertyValue('--carousel-offset'));
    expect(offset).toBe('0px');
    expect(await page.locator('.carousel-thumb').first().evaluate((el) => getComputedStyle(el).objectFit)).toBe('cover');
  });

  test('▦ follows the strip class main.ts sets, and the shell CSS uses no :has()', async ({ page }) => {
    // :has() is missing on Safari < 15.4 and Firefox < 121, where a rule using it is dropped whole.
    expect(WEBVIEW_STYLES).not.toContain(':has(');
    await loadInited(page);
    await expect(page.locator('#viewer')).toHaveClass(/has-carousel/);
    await expect(page.locator('#strip-btn')).toBeVisible();
    // The class alone decides: take it away and ▦ goes, with the strip itself still active.
    await page.evaluate(() => document.getElementById('viewer')!.classList.remove('has-carousel'));
    await expect(page.locator('#carousel')).toHaveClass(/active/);
    await expect(page.locator('#strip-btn')).toBeHidden();
  });

  test('the ▦ icon is an SVG centred in its 40 px button, in the button text colour', async ({ page }) => {
    await loadInited(page);
    await expect(page.locator('#strip-btn')).toBeVisible();
    const m = await page.evaluate(() => {
      const btn = document.getElementById('strip-btn')!;
      // Painted shapes only: an unpainted one (fill and stroke none) could pad the union back to centre around an offset glyph.
      const shapes = (Array.from(btn.querySelectorAll('svg *')).filter((el) => el instanceof SVGGeometryElement) as SVGGeometryElement[])
        .filter((el) => getComputedStyle(el).fill !== 'none' || getComputedStyle(el).stroke !== 'none');
      const b = btn.getBoundingClientRect();
      // The painted box: the union of the shapes' own boxes, so an offset inside the viewBox counts too.
      const rs = shapes.map((s) => s.getBoundingClientRect());
      const left = Math.min(...rs.map((r) => r.left)), right = Math.max(...rs.map((r) => r.right));
      const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom));
      const fillBefore = shapes.map((s) => getComputedStyle(s).fill);
      const colorBefore = getComputedStyle(btn).color;
      btn.style.color = 'rgb(1, 2, 3)';
      const fillAfter = shapes.map((s) => getComputedStyle(s).fill);
      btn.style.color = '';
      return {
        shapes: shapes.length, text: (btn.textContent ?? '').trim(),
        btn: { w: b.width, h: b.height }, icon: { w: right - left, h: bottom - top },
        dx: (left + right) / 2 - (b.left + b.right) / 2, dy: (top + bottom) / 2 - (b.top + b.bottom) / 2,
        fillBefore, colorBefore, fillAfter,
      };
    });
    // Drawn, not typed: no text glyph whose ink sits where the font puts it.
    expect(m.text).toBe('');
    expect(m.shapes).toBeGreaterThan(0);
    expect(m.btn).toEqual({ w: 40, h: 40 });
    // Roughly the 18 px glyph's ink (about 15 px square in Chromium's default font).
    expect(m.icon.w).toBeGreaterThanOrEqual(12);
    expect(m.icon.w).toBeLessThanOrEqual(20);
    expect(m.icon.h).toBeGreaterThanOrEqual(12);
    expect(m.icon.h).toBeLessThanOrEqual(20);
    expect(Math.abs(m.dx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.dy)).toBeLessThanOrEqual(0.5);
    // currentColor: the theme's button foreground, and whatever replaces it.
    for (const f of m.fillBefore) expect(f).toBe(m.colorBefore);
    for (const f of m.fillAfter) expect(f).toBe('rgb(1, 2, 3)');
  });

  test('a sideways swipe on the image steps modality and skips a hidden one', async ({ page }) => {
    // The touch layout opens no menu, so the only hide path is unreachable here. This wraps the
    // bundle's window contextmenu blocker so the test can hide a pill through the real menu, then
    // puts the blocker back.
    await page.addInitScript(() => {
      const add = window.addEventListener;
      window.addEventListener = function (this: Window, type: string, fn: any, opts?: any) {
        return add.call(this, type, type === 'contextmenu' ? (e: Event) => (window as any).__allowMenu || fn(e) : fn, opts);
      } as typeof window.addEventListener;
    });
    await loadInited(page, THREE);
    await page.evaluate(() => { (window as any).__allowMenu = true; });
    await hideModalityViaMenu(page, 1);
    await page.evaluate(() => { (window as any).__allowMenu = false; });
    expect((await getState(page)).hiddenModalities).toEqual([1]);

    const touch = await TouchDriver.attach(page);
    const c = await imageCentre(page);
    await touch.drag(c, { x: c.x - 120, y: c.y });
    expect((await getState(page)).currentModalityIndex).toBe(2);
    await touch.drag(c, { x: c.x + 120, y: c.y });
    expect((await getState(page)).currentModalityIndex).toBe(0);
  });

  test('an up swipe on the image steps to the next tuple, a down swipe back', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    const c = await imageCentre(page);
    await touch.drag(c, { x: c.x, y: c.y - 120 });
    expect((await getState(page)).currentTupleIndex).toBe(1);
    await touch.drag(c, { x: c.x, y: c.y + 120 });
    expect((await getState(page)).currentTupleIndex).toBe(0);
    // Clamped at the first tuple.
    await touch.drag(c, { x: c.x, y: c.y + 120 });
    expect((await getState(page)).currentTupleIndex).toBe(0);
    // A swipe is one step however far it goes.
    expect((await getState(page)).currentModalityIndex).toBe(0);
  });

  test('touch and hold on the image flips to the previous modality until release', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    await touch.tap(await centreOf(page, '#modality-selector .modality-btn >> nth=1'));
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);
    const c = await imageCentre(page);
    await touch.start(c);
    await page.waitForTimeout(500);
    expect((await getState(page)).currentModalityIndex).toBe(0);
    await touch.end();
    expect((await getState(page)).currentModalityIndex).toBe(1);
  });

  test('a finger on the image never reaches the mouse handlers', async ({ page }) => {
    await loadInited(page);
    await page.evaluate(() => {
      (window as any).__mousedowns = 0;
      document.getElementById('viewer')!.addEventListener('mousedown', () => { (window as any).__mousedowns++; });
    });
    const touch = await TouchDriver.attach(page);
    await touch.tap(await imageCentre(page));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__mousedowns)).toBe(0);
  });

  test('a two-finger pinch zooms, and lifting one finger never swipes', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    const c = await imageCentre(page);
    await touch.start({ x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y });
    for (let i = 1; i <= 8; i++) {
      await touch.move({ x: c.x - 30 - 12 * i, y: c.y }, { x: c.x + 30 + 12 * i, y: c.y });
      await page.waitForTimeout(16);
    }
    await expect.poll(async () => (await getState(page)).zoom).toBeGreaterThan(2);
    // Lift the second finger, then drag the first well past the swipe threshold.
    await touch.lift(1, { x: c.x + 126, y: c.y });
    for (let i = 1; i <= 6; i++) { await touch.move({ x: c.x - 126 - 30 * i, y: c.y }); await page.waitForTimeout(16); }
    await touch.end();
    const s = await getState(page);
    expect(s.currentModalityIndex).toBe(0);
    expect(s.currentTupleIndex).toBe(0);
  });

  test('two fingers dragged together pan the image', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    const c = await imageCentre(page);
    await touch.start({ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y });
    for (let i = 1; i <= 8; i++) {
      await touch.move({ x: c.x - 40 + 10 * i, y: c.y + 5 * i }, { x: c.x + 40 + 10 * i, y: c.y + 5 * i });
      await page.waitForTimeout(16);
    }
    await touch.end();
    // The finger spread never changed, so the zoom did not; the midpoint moved +80, +40.
    const s = await getState(page);
    expect(s.zoom).toBeCloseTo(1, 5);
    expect(s.panX).toBeCloseTo(80, 0);
    expect(s.panY).toBeCloseTo(40, 0);
    expect(s.currentModalityIndex).toBe(0);
    expect(s.currentTupleIndex).toBe(0);
  });

  test('a tap on the zoom readout resets zoom and pan', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    const c = await imageCentre(page);
    await touch.start({ x: c.x - 30, y: c.y - 20 }, { x: c.x + 30, y: c.y - 20 });
    for (let i = 1; i <= 6; i++) {
      await touch.move({ x: c.x - 30 - 15 * i, y: c.y }, { x: c.x + 30 + 15 * i, y: c.y });
      await page.waitForTimeout(16);
    }
    await touch.end();
    await expect.poll(async () => (await getState(page)).zoom).toBeGreaterThan(1.5);
    await touch.tap(await centreOf(page, '#status-info'));
    await expect.poll(async () => (await getState(page)).zoom).toBe(1);
    const s = await getState(page);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  test('▦ opens a full-width strip; a tile tap navigates and closes it; a finger drag scrolls its rows and taps nothing', async ({ page }) => {
    // Eight columns, so a full-width row's tiles are small enough for three rows to be on screen.
    await loadInited(page, STRIP);
    const touch = await TouchDriver.attach(page);
    // The open strip rebinds its tiles to the new width on the next frame, and re-centres.
    const open = async () => {
      await touch.tap(await centreOf(page, '#strip-btn'));
      await expect(page.locator('#viewer')).not.toHaveClass(/strip-closed/);
      await expect(page.locator('#carousel')).toBeVisible();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    };
    await open();
    const { strip, viewer } = await page.evaluate(() => ({
      strip: document.getElementById('carousel')!.getBoundingClientRect().width,
      viewer: document.getElementById('viewer')!.getBoundingClientRect().width,
    }));
    expect(strip).toBeCloseTo(viewer, 0);
    const tile = page.locator('.carousel-row[data-tuple-index="2"] .carousel-thumb[data-display-index="5"]');
    await expect(tile).toBeVisible();
    const box = (await tile.boundingBox())!;
    await touch.tap({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await expect.poll(async () => (await getState(page)).currentTupleIndex).toBe(2);
    expect((await getState(page)).currentModalityIndex).toBe(5);
    await expect(page.locator('#viewer')).toHaveClass(/strip-closed/);

    await open();
    const wallY = () => page.evaluate(() => {
      const m = /translateY\((-?[\d.]+)px\)/.exec(document.getElementById('carousel-wall')!.style.transform);
      return m ? 0 - parseFloat(m[1]) : 0;
    });
    const before = await wallY();
    const c = await centreOf(page, '#carousel');
    await touch.drag(c, { x: c.x, y: c.y - 200 });
    // A finger dragged up 200 px scrolls the rows down by about that much (the slop eats the first few).
    await expect.poll(wallY).toBeGreaterThan(before + 150);
    expect((await getState(page)).currentTupleIndex).toBe(2);
    await expect(page.locator('#viewer')).not.toHaveClass(/strip-closed/);
  });

  test('no context menu, path tooltip, Tools panel or vote circle', async ({ page }) => {
    await loadInited(page);
    await page.locator('#modality-selector .modality-btn').first().click({ button: 'right' });
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);
    const c = await imageCentre(page);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);
    const prevented = await page.evaluate(() => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('#modality-selector .modality-btn')!.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await expect(page.locator('#context-menu')).not.toHaveClass(/visible/);

    await page.locator('#modality-selector .modality-btn').first().hover();
    await expect(page.locator('#pill-tooltip')).toBeHidden();
    await expect(page.locator('#floating-panel')).toBeHidden();
    const touch = await TouchDriver.attach(page);
    await touch.tap(await centreOf(page, '#strip-btn'));
    await expect(page.locator('#carousel')).toBeVisible();
    expect(await page.locator('.winner-circle').count()).toBeGreaterThan(0);
    await expect(page.locator('.winner-circle').first()).toBeHidden();
  });

  test('help shows the touch rows and hides the keyboard rows', async ({ page }) => {
    await loadInited(page);
    const touch = await TouchDriver.attach(page);
    await touch.tap(await centreOf(page, '#help-btn'));
    await expect(page.locator('#help-modal')).toHaveClass(/active/);
    const help = await page.locator('#help-modal').innerText();
    for (const row of ['Touch', 'Swipe ← →', 'Swipe ↑ ↓', 'Touch and hold', 'Hold a pill, then drag', 'Pinch', 'Two-finger drag', '▦', 'Zoom readout']) {
      expect(help).toContain(row);
    }
    expect(help).not.toContain('Keyboard Shortcuts');
    expect(help).not.toContain('Ctrl/Cmd+C');
    expect(help).not.toContain('Drag a pill');
  });
});
