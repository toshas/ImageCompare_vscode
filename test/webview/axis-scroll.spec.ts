import { test, expect, Page } from '@playwright/test';
import { loadInited, getState } from './helpers';
import { DEFAULT_SPEC } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Three axes, one rule (docs/loading-architecture.md: selection-centres-on-navigation): navigation
// centres the selection, a wheel never does. Before this, `<-`/`->` moved the carousel's row axis
// and left its column axis alone, so at high modality counts the selected column sat off-screen;
// the pill row wrapped into a wall instead of scrolling at all.
//
// NO MUTATION COVERS THIS FILE — the wiring lives in webview/main.ts (DOM) and the harness runs
// Vitest suites only (docs/testing.md, "What nothing covers"). The rule itself IS mutation-covered,
// in test/unit/axisScroll.test.ts; what stands in for the wiring is that each assertion here was
// watched to fail against the pre-change bundle.

// Enough modalities that neither strip can fit: the pill row and the tile row both overflow.
const WIDE = {
  ...DEFAULT_SPEC,
  modalities: Array.from({ length: 24 }, (_, i) => `MODALITY_NUMBER_${i}`),
};

// Enough tuples that the row axis has somewhere to travel; two modalities keep the tiles tall.
const TALL = {
  ...DEFAULT_SPEC,
  tupleNames: Array.from({ length: 80 }, (_, i) => `scene_${String(i).padStart(3, '0')}`),
};

/** The wall's applied scroll offset, read from the DOM so the production test hook stays read-only. */
const wallOffset = (page: Page) =>
  page.evaluate(() => {
    const w = document.getElementById('carousel-wall') as HTMLElement | null;
    if (!w) return 0;
    const m = /translateY\((-?[\d.]+)px\)/.exec(w.style.transform);
    return m ? -Number(m[1]) : 0;
  });

const pillScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('modality-selector')!;
    return { left: el.scrollLeft, overflow: el.scrollWidth - el.clientWidth };
  });

const hScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('carousel-hscroll') as HTMLElement | null;
    return el ? { left: el.scrollLeft, overflow: el.scrollWidth - el.clientWidth } : null;
  });

/** The pill strip's visible window, and where the active pill sits inside the strip. */
const activePillGeometry = (page: Page) =>
  page.evaluate(() => {
    const strip = document.getElementById('modality-selector')!;
    const pill = strip.querySelector('.modality-btn.active') as HTMLElement;
    return {
      pillStart: pill.offsetLeft,
      pillEnd: pill.offsetLeft + pill.offsetWidth,
      viewStart: strip.scrollLeft,
      viewEnd: strip.scrollLeft + strip.clientWidth,
    };
  });

test.describe('axis scrolling', () => {
  test('the pill row is one scrollable strip, not a wrapped wall', async ({ page }) => {
    await loadInited(page, WIDE);
    const rows = await page.evaluate(() => {
      const tops = new Set<number>();
      document.querySelectorAll('.modality-btn').forEach((b) => tops.add((b as HTMLElement).offsetTop));
      return tops.size;
    });
    expect(rows).toBe(1);
    expect((await pillScroll(page)).overflow).toBeGreaterThan(0);

    // And the bar it lives in stays one line tall, which is what the wrap used to cost the viewer.
    const infoHeight = await page.evaluate(() => document.getElementById('info')!.getBoundingClientRect().height);
    expect(infoHeight).toBeLessThan(60);
  });

  test('a wheel over the pill row scrolls it and moves no selection', async ({ page }) => {
    await loadInited(page, WIDE);
    const before = await getState(page);
    await page.locator('.modality-btn').first().hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(async () => (await pillScroll(page)).left).toBeGreaterThan(0);
    // A wheel is not navigation: it must not re-centre, and must not change the modality.
    expect((await getState(page)).currentModalityIndex).toBe(before.currentModalityIndex);
  });

  test('an arrow key teleports the pill row to the selection', async ({ page }) => {
    await loadInited(page, WIDE);
    // Scroll far away from the selection first, the way a user browsing the strip would.
    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 99999; });
    expect((await pillScroll(page)).left).toBeGreaterThan(0);

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(1);

    const g = await activePillGeometry(page);
    expect(g.pillStart).toBeGreaterThanOrEqual(g.viewStart);
    expect(g.pillEnd).toBeLessThanOrEqual(g.viewEnd);
  });

  // The reported bug: the row axis tracked the selection and the column axis did not.
  test('an arrow key moves the carousel horizontally, not just vertically', async ({ page }) => {
    await loadInited(page, WIDE);
    expect((await hScroll(page))!.overflow).toBeGreaterThan(0);
    expect((await hScroll(page))!.left).toBe(0);

    // Walk to a column deep enough that centring must scroll the tile row.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(12);
    await expect.poll(async () => (await hScroll(page))!.left).toBeGreaterThan(0);

    // Walking back returns it, so the axis tracks rather than drifting one way.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(0);
    await expect.poll(async () => (await hScroll(page))!.left).toBe(0);
  });

  // Containment alone is vacuous on a strip that cannot scroll — a wrapped row satisfies it with
  // scrollLeft pinned at 0 forever. Each half therefore also asserts the strip MOVED, away from an
  // extreme the selection is not at, which is the part a non-scrolling row cannot fake.
  test('a digit jump and a pill click centre the same way an arrow does', async ({ page }) => {
    await loadInited(page, WIDE);
    expect((await pillScroll(page)).overflow).toBeGreaterThan(0);

    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 99999; });
    const parkedRight = (await pillScroll(page)).left;
    expect(parkedRight).toBeGreaterThan(0);
    await page.keyboard.press('Digit5');
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(4);
    await expect.poll(async () => (await pillScroll(page)).left).toBeLessThan(parkedRight);
    let g = await activePillGeometry(page);
    expect(g.pillStart).toBeGreaterThanOrEqual(g.viewStart);
    expect(g.pillEnd).toBeLessThanOrEqual(g.viewEnd);

    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 0; });
    await page.locator('.modality-btn').nth(9).click();
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(9);
    await expect.poll(async () => (await pillScroll(page)).left).toBeGreaterThan(0);
    g = await activePillGeometry(page);
    expect(g.pillStart).toBeGreaterThanOrEqual(g.viewStart);
    expect(g.pillEnd).toBeLessThanOrEqual(g.viewEnd);
  });

  test('Alt makes a carousel wheel notch travel further, in the same direction', async ({ page }) => {
    await loadInited(page, TALL);
    await page.locator('#carousel').hover();

    // The axis is linear and far from either clamp here, so one plain notch measures the unit.
    await page.mouse.wheel(0, 40);
    await expect.poll(() => wallOffset(page)).toBeGreaterThan(0);
    const afterPlain = await wallOffset(page);

    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, 40);
    await page.keyboard.up('Alt');
    await expect.poll(() => wallOffset(page)).toBeGreaterThan(afterPlain);

    // The Alt notch travelled ALT_SPEED times the plain one, same direction.
    const altTravel = (await wallOffset(page)) - afterPlain;
    expect(altTravel).toBeCloseTo(afterPlain * 5, 0);
  });

  test('Alt makes a zoom notch travel further, and the help modal says so', async ({ page }) => {
    await loadInited(page);
    const zoomOf = () => getState(page).then((s) => s.zoom);

    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -1);
    await expect.poll(zoomOf).toBeGreaterThan(1);
    const plain = await zoomOf();

    await page.keyboard.press('Escape'); // back to zoom 1
    await expect.poll(zoomOf).toBe(1);
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -1);
    await page.keyboard.up('Alt');
    // Compounded, not scaled: 1.03^5, which is meaningfully more than 1 + 0.03*5.
    await expect.poll(zoomOf).toBeCloseTo(plain ** 5, 6);

    await page.locator('#help-btn').click();
    await expect(page.locator('#help-modal')).toContainText('Alt+Scroll');
  });
});
