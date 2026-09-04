import { test, expect, Page } from '@playwright/test';
import { HARNESS_URL } from './harness';
import { FixtureSpec, initMessage, imageMessages, thumbnailMessages } from '../fixtures/messages';
import { hideModalityViaMenu } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What a tuple arrival actually asks the extension for, driven through the real bundle.
 *
 * The field pathology: a panel of 746 tuples x 10 modalities requested every modality of every
 * tuple it passed and cancelled none of it, so 15 of 16 pool slots carried full-resolution images
 * nobody was waiting for while the carousel sweep delivered ~4 tiles/s for six minutes. The policy
 * these tests pin is the counter: arrival asks for the on-screen modality only, siblings wait for a
 * dwell that navigation cancels, and they are ordered by distance in the *display* order.
 * (docs/loading-architecture.md: siblings-dwell-gated, sibling-order-by-display-distance)
 */

const SPEC: FixtureSpec = {
  tupleNames: ['scene_000', 'scene_001', 'scene_002', 'scene_003', 'scene_004', 'scene_005'],
  modalities: ['A', 'B', 'C', 'D', 'E', 'F'],
  width: 160,
  height: 100,
  votingEnabled: true,
};

/** Longer than the 150ms dwell, short enough to keep the suite quick. */
const PAST_DWELL_MS = 450;

/**
 * Init + thumbnails + the images of tuple 0 only. Every other tuple is uncached, which is the state
 * a real session spends its life in — `loadInited` delivers everything and would leave nothing to ask for.
 */
async function loadPartial(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'));
  await page.evaluate((msg) => (window as any).__ic_send(msg), initMessage(SPEC) as any);
  for (const msg of thumbnailMessages(SPEC)) {
    await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
  }
  for (const msg of imageMessages(SPEC).filter((m) => m.tupleIndex === 0)) {
    await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
  }
  await expect(page.locator('#viewer')).toHaveClass(/active/);
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  });
  // The leading-edge navigation debounce keys off wall time; start every test outside its window.
  await page.waitForTimeout(PAST_DWELL_MS);
}

/** Dispatch keys and read what the bundle posted in the *same* turn — before any timer can fire. */
async function pressAndCapture(page: Page, codes: string[]): Promise<any[]> {
  return page.evaluate((keys) => {
    const start = (window as any).__ic_outbound.length;
    for (const code of keys) document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    return (window as any).__ic_outbound.slice(start).filter((m: any) => m && m.type === 'requestImage');
  }, codes);
}

async function requestsSince(page: Page, start: number): Promise<any[]> {
  return page.evaluate(
    (s) => (window as any).__ic_outbound.slice(s).filter((m: any) => m && m.type === 'requestImage'),
    start,
  );
}

const outboundLength = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__ic_outbound.length);

const getStateOf = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__ic_test.getState());

/** Every column report posted since `start`, in order — the sweep's aim moves once per one of these. */
const columnReports = (page: Page, start: number): Promise<any[]> =>
  page.evaluate(
    (s) => (window as any).__ic_outbound.slice(s).filter((m: any) => m && m.type === 'setCurrentModality'),
    start,
  );

test.describe('tuple arrival asks for one image, not the whole tuple', () => {
  test('a navigation requests only the modality on screen', async ({ page }) => {
    await loadPartial(page);
    const immediate = await pressAndCapture(page, ['ArrowDown']);
    expect(immediate).toHaveLength(1);
    expect(immediate[0].tupleIndex).toBe(1);
    expect(immediate[0].modalityIndex).toBe(0);
    expect(!!immediate[0].sibling).toBe(false);
  });

  test('the siblings follow after the dwell, nearest-first over the display order', async ({ page }) => {
    await loadPartial(page);
    // Sit on the middle pill so the order is two-sided and cannot be produced by a plain 0..N walk.
    await pressAndCapture(page, ['Digit3']);
    const start = await outboundLength(page);
    await pressAndCapture(page, ['ArrowDown']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const requests = await requestsSince(page, start);
    expect(requests.every((r) => r.tupleIndex === 1)).toBe(true);
    // Display index 2 is on screen: `->` reaches 3, `<-` reaches 1, then 4, 0, 5.
    expect(requests.map((r) => r.modalityIndex)).toEqual([2, 3, 1, 4, 0, 5]);
    // Only the nearest two are load-bearing; the rest is tail-ranked speculation.
    expect(requests.map((r) => (!r.sibling ? 'visible' : r.tail ? 'tail' : 'sibling')))
      .toEqual(['visible', 'sibling', 'sibling', 'tail', 'tail', 'tail']);
  });

  test('a burst of navigations never asks for the siblings of the tuples it passes', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    // Four steps inside one turn: strictly inside the dwell window.
    await pressAndCapture(page, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const requests = await requestsSince(page, start);
    const passed = requests.filter((r) => r.tupleIndex !== 4);
    // Pre-change, tuple 1 alone pulled all six modalities on the way past.
    expect(passed.every((r) => !r.sibling)).toBe(true);
    expect(passed.length).toBeLessThanOrEqual(1);
    // The tuple the user stopped on gets its visible image plus its five siblings, and nothing else does.
    expect(requests.filter((r) => r.tupleIndex === 4)).toHaveLength(SPEC.modalities.length);
  });

  test('hidden modalities are never speculated on', async ({ page }) => {
    await loadPartial(page);
    await hideModalityViaMenu(page, 1);
    const start = await outboundLength(page);
    await pressAndCapture(page, ['ArrowDown']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const requests = await requestsSince(page, start);
    expect(requests.some((r) => r.modalityIndex === 1)).toBe(false);
    // The hidden pill is skipped as a *step* too: `->` from 0 lands on 2, so 2 is the nearest sibling.
    expect(requests.map((r) => r.modalityIndex)).toEqual([0, 2, 3, 4, 5]);
  });

  test('a flip after the dwell re-asks a tail-ranked slot at VISIBLE', async ({ page }) => {
    await loadPartial(page);
    await pressAndCapture(page, ['ArrowDown']);
    // Let the dwell fire: display 0 is on screen, 1-2 rank as siblings, 3-5 as tail — all now marked.
    await page.waitForTimeout(PAST_DWELL_MS);

    // Digit5 lands on display 4, asked for at `tail` and never delivered. SIBLING_TAIL is admitted
    // only when nothing else has queue, so leaving the request at that rank is a spinner for the
    // whole sweep (docs/loading-architecture.md: request-rank-upgrades).
    const requests = await pressAndCapture(page, ['Digit5']);
    expect(requests).toHaveLength(1);
    expect(requests[0].tupleIndex).toBe(1);
    expect(requests[0].modalityIndex).toBe(4);
    expect(!!requests[0].sibling).toBe(false);
    expect(!!requests[0].tail).toBe(false);
  });

  // The extension knows nothing about the display order or the hidden set, so a wave can only be
  // scoped to the column on screen if `tupleFullyLoaded` carries the strip. A silent drop here
  // speculates on the wrong column and nothing on the host side can notice.
  // (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column)
  test('tupleFullyLoaded reports the strip as displayed, so prefetch can scope to it', async ({ page }) => {
    await loadPartial(page);
    const first = await page.evaluate(() =>
      (window as any).__ic_outbound.filter((m: any) => m && m.type === 'tupleFullyLoaded').at(-1));
    expect(first.tupleIndex).toBe(0);
    expect(first.modalityOrder).toEqual([0, 1, 2, 3, 4, 5]);
    expect(first.currentDisplayIndex).toBe(0);
    expect(first.hiddenModalities).toEqual([]);

    // Move the strip under the extension's feet: hide a pill, reorder, land on a different column.
    await hideModalityViaMenu(page, 4);
    await pressAndCapture(page, ['Digit3']);
    await pressAndCapture(page, ['BracketLeft']);
    // Leave and come back: tuple 0 is fully cached, so returning re-posts the report.
    await pressAndCapture(page, ['ArrowDown']);
    await page.waitForTimeout(PAST_DWELL_MS);
    await pressAndCapture(page, ['ArrowUp']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const report = await page.evaluate(() =>
      (window as any).__ic_outbound.filter((m: any) => m && m.type === 'tupleFullyLoaded').at(-1));
    const state = await page.evaluate(() => (window as any).__ic_test.getState());
    expect(report.tupleIndex).toBe(0);
    // Every field is the live strip, not a stale or default one.
    expect(report.modalityOrder).toEqual(state.modalityOrder);
    expect(report.currentDisplayIndex).toBe(state.currentModalityIndex);
    expect(report.hiddenModalities).toEqual(state.hiddenModalities);
    expect(report.hiddenModalities).toEqual([4]);
    expect(report.modalityOrder).not.toEqual([0, 1, 2, 3, 4, 5]);
  });

  // The same report carries the carousel's screenful, which is the radius the open-time sweep's
  // cross reaches to (docs/loading-architecture.md: sweep-cross-then-row-major). It is a DOM
  // measurement, so this layer is the only one that can see it — the mutation harness runs Vitest
  // suites only, and the host side of the same rule is pinned there instead
  // (test/unit/sweepProviderCentre.test.ts, "stops the cross at the screenful the webview
  // reported"). Without a live report the sweep silently falls back to a constant that is wrong by
  // an order of magnitude at either end of the tile-size range.
  test('tupleFullyLoaded reports the carousel screenful the sweep uses as its cross radius', async ({ page }) => {
    await loadPartial(page);
    const report = await page.evaluate(() =>
      (window as any).__ic_outbound.filter((m: any) => m && m.type === 'tupleFullyLoaded').at(-1));
    // Measured off the rendered carousel, not off the webview's own helper: how many rows of the
    // height the tiles actually have fit in the pane the user sees.
    const geometry = await page.evaluate(() => {
      const el = document.getElementById('carousel') as HTMLElement;
      const thumb = parseFloat(getComputedStyle(el).getPropertyValue('--thumb-size'));
      return { paneHeight: el.clientHeight, rowHeight: thumb + 2 };
    });
    const fit = geometry.paneHeight / geometry.rowHeight;
    expect(geometry.paneHeight).toBeGreaterThan(0);
    // Non-vacuous: the harness carousel really shows several rows, so a hard-coded 1 would fail.
    expect(fit).toBeGreaterThan(3);
    expect(report.visibleRows).toBeGreaterThanOrEqual(Math.floor(fit));
    expect(report.visibleRows).toBeLessThanOrEqual(Math.ceil(fit));
  });

  // The field case, at the layer that owns it: the column reaches the extension only in a report the
  // webview sends, and the one report that carried it waits for EVERY modality of the tuple to
  // arrive — on a 265x136 grid that report is a whole cold tuple away, so a tile clicked in another
  // column left the sweep aiming where it already was (column 0, the strip's first). Nothing on the
  // host side can notice a report that was never sent. The post is a webview measurement, so this
  // layer is the only one that can see it — the mutation harness runs Vitest suites only, and the
  // host half of the same rule is pinned there instead (test/unit/sweepHostEquivalence.test.ts,
  // "drives the same burst through the real provider and the real standalone adapter", whose clicked-
  // column phase has a mutation per host).
  // (docs/loading-architecture.md: picked-column-reports-itself)
  test('clicking a tile in another column reports that column at once, not when the tuple loads', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    // Tuple 4 is uncached and its column 3 is not the one on screen: the two halves of the repro.
    await page.locator('.carousel-row[data-tuple-index="4"] .carousel-thumb[data-modality="3"]').click();
    const since = await page.evaluate((s) => (window as any).__ic_outbound.slice(s), start);

    const report = since.find((m: any) => m && m.type === 'setCurrentModality');
    expect(report).toBeTruthy();
    const state = await getStateOf(page);
    expect(report.currentDisplayIndex).toBe(3);
    expect(report.currentDisplayIndex).toBe(state.currentModalityIndex);
    expect(report.modalityOrder).toEqual(state.modalityOrder);
    expect(report.hiddenModalities).toEqual(state.hiddenModalities);
    // Non-vacuous: the tuple it landed on is nowhere near loaded, so the report that used to carry
    // the column has not fired and cannot fire for a long time.
    expect(since.some((m: any) => m && m.type === 'tupleFullyLoaded')).toBe(false);
    expect(state.currentTupleIndex).toBe(4);
  });

  // Display position is not the modality index: the report has to say which position the user is on
  // in the order it also reports, or a rearranged strip aims the sweep at whatever column happens to
  // sit at that original position (docs/tuple-matching.md: wire-index-is-original).
  test('the reported column is the display position within the reported order, on a rearranged strip', async ({ page }) => {
    await loadPartial(page);
    // Move the on-screen column one place right: the strip becomes [1, 0, 2, ...].
    await pressAndCapture(page, ['BracketRight']);
    const order = (await getStateOf(page)).modalityOrder;
    expect(order.slice(0, 2)).toEqual([1, 0]);
    // The reorder reports the strip it rearranged, on the key dwell; let that land before measuring,
    // so the report read below is the click's (docs/loading-architecture.md: picked-column-reports-itself).
    await page.waitForTimeout(PAST_DWELL_MS);

    const start = await outboundLength(page);
    // Display position 0 now shows original modality 1 — the tile addressed by what it shows.
    await page.locator('.carousel-row[data-tuple-index="4"] .carousel-thumb[data-modality="1"]').click();
    const report = await page.evaluate((s) =>
      (window as any).__ic_outbound.slice(s).find((m: any) => m && m.type === 'setCurrentModality'), start);
    expect(report, 'the click posted no setCurrentModality').toBeTruthy();
    expect(report.currentDisplayIndex).toBe(0);
    expect(report.modalityOrder).toEqual(order);
  });

  // The maintainer's report: a carousel click re-aimed the sweep and the keyboard did not, so after
  // one click every later arrow, digit or reorder kept filling the column the click had named. The
  // fix is a report per *picked* column, and the reason it is dwelled rather than posted per
  // keystroke is that keys repeat: what a per-keystroke report would cost the sweep is measured at
  // the host layer (test/unit/sweepHostEquivalence.test.ts, "every report the hosts get re-aims"),
  // and what a burst produces is measured here, as a count. Key -> message is a DOM measurement, so
  // this layer is the only one that can see it — the mutation harness runs Vitest suites only, and
  // the pure gate this drives is pinned there instead (test/unit/tupleLoadPlan.test.ts).
  // (docs/loading-architecture.md: picked-column-reports-itself)
  test('an arrow-key column move reports its column once the burst settles', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    await pressAndCapture(page, ['ArrowRight']);
    // Nothing yet: a key that may be the first repeat of a held burst is not a destination.
    expect(await columnReports(page, start)).toHaveLength(0);
    await page.waitForTimeout(PAST_DWELL_MS);

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    const state = await getStateOf(page);
    expect(state.currentModalityIndex).toBe(1);
    expect(reports[0].currentDisplayIndex).toBe(state.currentModalityIndex);
    expect(reports[0].modalityOrder).toEqual(state.modalityOrder);
    expect(reports[0].hiddenModalities).toEqual(state.hiddenModalities);
    // Non-vacuous: the tuple never moved, so the report that used to carry the column never fired.
    const since = await page.evaluate((s) => (window as any).__ic_outbound.slice(s), start);
    expect(since.some((m: any) => m && m.type === 'tupleFullyLoaded')).toBe(false);
  });

  // The churn objection, answered by measurement: ten repeats are one report, not ten.
  // (docs/loading-architecture.md: picked-column-reports-itself)
  test('a held arrow key reports once, at the column the burst ended on', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    // Ten repeats in one turn — strictly inside the dwell, which is the shape a held key produces.
    await pressAndCapture(page, new Array(10).fill('ArrowRight'));
    expect(await columnReports(page, start)).toHaveLength(0);
    await page.waitForTimeout(PAST_DWELL_MS);

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    // Cycling does not wrap, so ten steps right over six pills end on the last one.
    expect(reports[0].currentDisplayIndex).toBe(SPEC.modalities.length - 1);
    expect((await getStateOf(page)).currentModalityIndex).toBe(SPEC.modalities.length - 1);
  });

  // (docs/loading-architecture.md: picked-column-reports-itself)
  test('a digit jump reports the column it landed on', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    await pressAndCapture(page, ['Digit5']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    expect(reports[0].currentDisplayIndex).toBe(4);
    expect(reports[0].modalityOrder).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // A reorder does not change which modality is on screen, it changes what the aim's stored
  // modalityOrder means — so the sweep ranks the neighbours of the column over a strip that no
  // longer exists (docs/loading-architecture.md: picked-column-reports-itself).
  test('a bracket reorder reports the strip it rearranged', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    await pressAndCapture(page, ['BracketRight']);
    await page.waitForTimeout(PAST_DWELL_MS);

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    const state = await getStateOf(page);
    expect(state.modalityOrder.slice(0, 2)).toEqual([1, 0]);
    expect(reports[0].modalityOrder).toEqual(state.modalityOrder);
    expect(reports[0].currentDisplayIndex).toBe(state.currentModalityIndex);
    // The same modality, in a new place: the aim's column is unchanged, its ordering is not.
    expect(reports[0].modalityOrder[reports[0].currentDisplayIndex]).toBe(0);
  });

  // Ordering trap: a dwell armed just before a click must not land after it and aim the sweep back
  // at the column the user left (docs/loading-architecture.md: picked-column-reports-itself).
  test('a click inside the dwell window cancels the pending key report', async ({ page }) => {
    await loadPartial(page);
    await page.locator('.carousel-row[data-tuple-index="4"] .carousel-thumb[data-modality="3"]').waitFor();
    const start = await outboundLength(page);
    // Both in one turn, so no timer can fire between them — a driver round-trip can outlast the dwell.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
      (document.querySelector('.carousel-row[data-tuple-index="4"] .carousel-thumb[data-modality="3"]') as HTMLElement).click();
    });
    // The click's own report is on the wire before any dwell could fire.
    expect(await columnReports(page, start)).toHaveLength(1);
    await page.waitForTimeout(PAST_DWELL_MS);

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    expect(reports[0].currentDisplayIndex).toBe(3);
  });

  // A pill is a click, so it is a settled destination and reports at once, like a tile
  // (docs/loading-architecture.md: picked-column-reports-itself).
  test('a pill click reports its column at once, with no dwell', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    await page.locator('.modality-btn[data-display-index="2"]').click();

    const reports = await columnReports(page, start);
    expect(reports).toHaveLength(1);
    expect(reports[0].currentDisplayIndex).toBe(2);
    expect((await getStateOf(page)).currentModalityIndex).toBe(2);
  });

  test('flipping to a sibling inside the dwell window loads it at once', async ({ page }) => {
    await loadPartial(page);
    const start = await outboundLength(page);
    // The accepted regression: one image's latency, never a spinner nobody clears.
    await pressAndCapture(page, ['ArrowDown', 'ArrowRight']);
    const requests = await requestsSince(page, start);
    expect(requests.map((r) => r.modalityIndex)).toEqual([0, 1]);
    expect(requests.every((r) => r.tupleIndex === 1 && !r.sibling)).toBe(true);
  });
});
