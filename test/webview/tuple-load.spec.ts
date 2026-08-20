import { test, expect, Page } from '@playwright/test';
import { HARNESS_URL } from './harness';
import { FixtureSpec, initMessage, imageMessages, thumbnailMessages } from '../fixtures/messages';

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
    await page.evaluate(() => (window as any).__ic_send({ type: 'toggleModalityHidden', modalityIndex: 1 }));
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
