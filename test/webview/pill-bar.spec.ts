import { test, expect, Page } from '@playwright/test';
import { loadInited, pillRowSettled } from './helpers';
import { DEFAULT_SPEC, FixtureSpec } from '../fixtures/messages';

/**
 * The pill bar's layout (#info): nothing takes space before the pill row, and an end pill's painted
 * extent — its :hover scale plus the current pill's 2px outer ring — stays inside the row's clip.
 * Pure CSS in webviewShell.ts, so outside the Vitest-only mutation harness (docs/testing.md, "What
 * nothing covers").
 */

const FOUR: FixtureSpec = { ...DEFAULT_SPEC, modalities: ['A', 'B', 'C', 'D'] };
const ONE_TUPLE: FixtureSpec = { ...DEFAULT_SPEC, tupleNames: ['scene_000'] };
// End pills well over 200 px wide (labels shown whole), and enough between them that the row overflows and scrolls.
const LONG_ENDS: FixtureSpec = {
  ...DEFAULT_SPEC,
  labelsExplicit: true,
  modalities: [
    'FIRST_a_rather_long_modality_label_for_the_ring',
    ...Array.from({ length: 10 }, (_, i) => `M${i}`),
    'LAST_a_rather_long_modality_label_for_the_ring',
  ],
};
// One modality: its pill is both first and last, so no transform origin leaves its 5% growth any room.
const SOLE_LONG: FixtureSpec = { ...DEFAULT_SPEC, labelsExplicit: true, modalities: ['SOLE_a_rather_long_modality_label_for_the_ring'] };

/** Where the bar's first things sit, relative to #info's left edge. */
const barLead = (page: Page) =>
  page.evaluate(() => {
    const info = document.getElementById('info')!;
    const infoLeft = info.getBoundingClientRect().left;
    const buttons = document.getElementById('reorder-buttons')!.getBoundingClientRect();
    return {
      padding: parseFloat(getComputedStyle(info).paddingLeft),
      buttonsWidth: buttons.width,
      rowLead: document.getElementById('modality-selector')!.getBoundingClientRect().left - infoLeft,
      pillLead: document.querySelector('#modality-selector .modality-btn')!.getBoundingClientRect().left - infoLeft,
    };
  });

async function expectNoLead(page: Page): Promise<void> {
  const g = await barLead(page);
  expect(g.buttonsWidth).toBe(0);
  // No flex gap either: the row starts right at #info's padding edge.
  expect(g.rowLead).toBeCloseTo(g.padding, 1);
  expect(g.pillLead).toBeLessThanOrEqual(16);
}

/** The pill's painted rect (transformed box grown by its scaled ring) against the row's clip rect. */
const paintedVsClip = (page: Page, i: number) =>
  page.evaluate((i) => {
    const row = document.getElementById('modality-selector')!;
    const pill = row.querySelectorAll<HTMLElement>('.modality-btn')[i];
    const cs = getComputedStyle(pill);
    const scale = cs.transform === 'none' ? 1 : new DOMMatrix(cs.transform).a;
    const ring = parseFloat(cs.boxShadow.match(/([\d.]+)px\s*$/)?.[1] ?? '0') * scale;
    const p = pill.getBoundingClientRect();
    // The row's border box is its clip (no border, no scrollbar); its client sizes would round it to whole px.
    const r = row.getBoundingClientRect();
    return {
      active: pill.classList.contains('active'),
      width: pill.offsetWidth,
      scale,
      ring,
      left: p.left - ring - r.left,
      top: p.top - ring - r.top,
      right: r.right - (p.right + ring),
      bottom: r.bottom - (p.bottom + ring),
    };
  }, i);

/** `grows`: an end pill keeps the hover scale; a sole pill, with no inner side to grow into, does not. */
async function expectEndPillInside(page: Page, i: number, scrollTo: number, grows = true): Promise<void> {
  await page.evaluate((x) => { document.getElementById('modality-selector')!.scrollLeft = x; }, scrollTo);
  await pillRowSettled(page);
  // A real click makes it current and leaves the mouse over it, so it is hovered and current at once.
  const pill = page.locator('#modality-selector .modality-btn').nth(i);
  await pill.click();
  await pillRowSettled(page);
  // Measured once the hover transition has finished, so a growing pill is caught at its full size.
  await expect.poll(() => pill.evaluate((el) => el.matches(':hover') && el.getAnimations().length === 0)).toBe(true);
  const g = await paintedVsClip(page, i);
  if (grows) expect(g.scale).toBeGreaterThan(1.04);
  expect(g.active).toBe(true);
  expect(g.width).toBeGreaterThanOrEqual(200);
  expect(g.ring).toBeGreaterThan(0);
  expect(g.left).toBeGreaterThanOrEqual(0);
  expect(g.top).toBeGreaterThanOrEqual(0);
  expect(g.right).toBeGreaterThanOrEqual(0);
  expect(g.bottom).toBeGreaterThanOrEqual(0);
}

test.describe('pill bar layout (desktop)', () => {
  test('nothing in the bar precedes the pill row: no empty ▦ box and no gap before the first pill', async ({ page }) => {
    await loadInited(page, FOUR);
    await expectNoLead(page);
  });

  test('a hovered, current end pill 200 px wide paints inside the row at either scroll end', async ({ page }) => {
    await loadInited(page, LONG_ENDS);
    const overflow = await page.evaluate(() => {
      const row = document.getElementById('modality-selector')!;
      return row.scrollWidth - row.clientWidth;
    });
    expect(overflow).toBeGreaterThan(50);
    const last = LONG_ENDS.modalities.length - 1;
    await expectEndPillInside(page, last, 999999);
    expect(await page.evaluate(() => {
      const row = document.getElementById('modality-selector')!;
      return row.scrollWidth - row.clientWidth - row.scrollLeft;
    })).toBeLessThanOrEqual(1);
    await expectEndPillInside(page, 0, 0);
    expect(await page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft)).toBe(0);
  });

  test('a hovered, current sole pill 200 px wide paints inside the row', async ({ page }) => {
    await loadInited(page, SOLE_LONG);
    await expect(page.locator('#modality-selector .modality-btn')).toHaveCount(1);
    await expectEndPillInside(page, 0, 0, false);
  });
});

test.describe('pill bar layout (coarse pointer)', () => {
  test.use({ hasTouch: true });

  test('a single-tuple comparison (no ▦) has nothing before the pill row either', async ({ page }) => {
    await loadInited(page, ONE_TUPLE);
    expect(await page.evaluate(() => document.body.classList.contains('touch-ui'))).toBe(true);
    await expect(page.locator('#strip-btn')).toBeHidden();
    await expectNoLead(page);
  });

  // A phone's tap leaves :hover on the pill until the next tap elsewhere; emulated taps set no :hover,
  // so a mouse hover stands in for it. Watched failing with the `@media (hover: hover)` wrapper removed.
  test('a hovered pill keeps its resting look where the primary pointer cannot hover', async ({ page }) => {
    for (const spec of [FOUR, SOLE_LONG]) {
      await loadInited(page, spec);
      expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
      const first = page.locator('#modality-selector .modality-btn').first();
      await first.hover();
      await page.waitForTimeout(300);
      const look = await first.evaluate((el) => ({
        hovered: el.matches(':hover'),
        transform: getComputedStyle(el).transform,
        underline: getComputedStyle(el).textDecorationLine,
        originX: parseFloat(getComputedStyle(el).transformOrigin),
        half: el.getBoundingClientRect().width / 2,
      }));
      expect(look.hovered).toBe(true);
      expect(look.transform).toBe('none');
      expect(look.underline).toBe('none');
      // No outer-edge origin either: the default centre.
      expect(look.originX).toBeCloseTo(look.half, 1);
    }
  });
});
