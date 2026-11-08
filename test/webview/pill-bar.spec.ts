import { test, expect, Page } from '@playwright/test';
import { loadInited } from './helpers';
import { HARNESS_URL } from './harness';
import { DEFAULT_SPEC, FixtureSpec, initMessage, imageMessages, thumbnailMessages } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The pill bar's layout (#info): nothing takes space before the pill row, and an end pill's painted
 * extent — its :hover scale plus the current pill's 2px outer ring — stays inside the row's clip.
 * Pure CSS in webviewShell.ts, so outside the Vitest-only mutation harness (docs/testing.md, "What
 * nothing covers"); each test was watched failing against the pre-change shell or a deliberate break.
 */

const FOUR: FixtureSpec = { ...DEFAULT_SPEC, modalities: ['A', 'B', 'C', 'D'] };
const ONE_TUPLE: FixtureSpec = { ...DEFAULT_SPEC, tupleNames: ['scene_000'] };
// End pills well over 200 px wide, and enough between them that the row overflows and scrolls.
const LONG_ENDS: FixtureSpec = {
  ...DEFAULT_SPEC,
  modalities: [
    'FIRST_a_rather_long_modality_label_for_the_ring',
    ...Array.from({ length: 10 }, (_, i) => `M${i}`),
    'LAST_a_rather_long_modality_label_for_the_ring',
  ],
};
// One modality: its pill is both first and last, so no transform origin leaves its 5% growth any room.
const SOLE_LONG: FixtureSpec = { ...DEFAULT_SPEC, modalities: ['SOLE_a_rather_long_modality_label_for_the_ring'] };

/** loadInited, but with `labelsExplicit` so the long labels are not truncated to 20 characters. */
async function loadWithExplicitLabels(page: Page, spec: FixtureSpec): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'));
  await page.evaluate((msg) => (window as any).__ic_send(msg), { ...initMessage(spec), labelsExplicit: true } as any);
  for (const msg of [...thumbnailMessages(spec), ...imageMessages(spec)]) {
    await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
  }
  await expect(page.locator('#viewer')).toHaveClass(/active/);
}

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

/** Wait until the row's scrollLeft stops changing (navigation slides it). */
async function rowSettled(page: Page): Promise<void> {
  let last = -1;
  await expect.poll(async () => {
    const now = await page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft);
    const stable = now === last;
    last = now;
    return stable;
  }, { timeout: 4000 }).toBe(true);
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
    const r = row.getBoundingClientRect();
    const clip = { left: r.left + row.clientLeft, top: r.top + row.clientTop };
    return {
      active: pill.classList.contains('active'),
      width: pill.offsetWidth,
      scale,
      ring,
      left: p.left - ring - clip.left,
      top: p.top - ring - clip.top,
      right: clip.left + row.clientWidth - (p.right + ring),
      bottom: clip.top + row.clientHeight - (p.bottom + ring),
    };
  }, i);

async function expectEndPillInside(page: Page, i: number, scrollTo: number): Promise<void> {
  await page.evaluate((x) => { document.getElementById('modality-selector')!.scrollLeft = x; }, scrollTo);
  await rowSettled(page);
  // A real click makes it current and leaves the mouse over it, so it is hovered and current at once.
  await page.locator('#modality-selector .modality-btn').nth(i).click();
  await rowSettled(page);
  await expect.poll(async () => (await paintedVsClip(page, i)).scale).toBeGreaterThan(1.04);
  const g = await paintedVsClip(page, i);
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
    await loadWithExplicitLabels(page, LONG_ENDS);
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
    await loadWithExplicitLabels(page, SOLE_LONG);
    const sole = page.locator('#modality-selector .modality-btn');
    await expect(sole).toHaveCount(1);
    await sole.click();
    // Measure only once any hover transition has finished, so a growing pill is caught at its full size.
    await expect.poll(() => sole.evaluate((el) => el.matches(':hover') && el.getAnimations().length === 0)).toBe(true);
    const g = await paintedVsClip(page, 0);
    expect(g.active).toBe(true);
    expect(g.width).toBeGreaterThanOrEqual(200);
    expect(g.ring).toBeGreaterThan(0);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.right).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeGreaterThanOrEqual(0);
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

  test('with a strip, ▦ is shown before the pill row', async ({ page }) => {
    await loadInited(page, FOUR);
    await expect(page.locator('#strip-btn')).toBeVisible();
    const g = await barLead(page);
    expect(g.buttonsWidth).toBeGreaterThan(0);
    expect(g.rowLead).toBeGreaterThan(g.buttonsWidth);
  });
});
