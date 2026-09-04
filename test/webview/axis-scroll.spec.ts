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

/** Wait until the strip's scrollLeft stops changing — navigation animates, so a single read can land mid-slide. */
async function settled(page: Page): Promise<void> {
  let last = -1;
  await expect.poll(async () => {
    const now = (await pillScroll(page)).left;
    const stable = now === last;
    last = now;
    return stable;
  }, { timeout: 4000 }).toBe(true);
}

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
    await settled(page);

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
    await settled(page);
    let g = await activePillGeometry(page);
    expect(g.pillStart).toBeGreaterThanOrEqual(g.viewStart);
    expect(g.pillEnd).toBeLessThanOrEqual(g.viewEnd);

    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 0; });
    await page.locator('.modality-btn').nth(9).click();
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(9);
    await expect.poll(async () => (await pillScroll(page)).left).toBeGreaterThan(0);
    await settled(page);
    g = await activePillGeometry(page);
    expect(g.pillStart).toBeGreaterThanOrEqual(g.viewStart);
    expect(g.pillEnd).toBeLessThanOrEqual(g.viewEnd);
  });

  // Reported: the active pill's outline was cropped top and bottom, only its left/right survived.
  // The ring is a 2px OUTER box-shadow, so a strip whose height equalled the pill's clipped it.
  test('the active pill\'s focus ring is not clipped by the strip', async ({ page }) => {
    await loadInited(page, WIDE);
    const g = await page.evaluate(() => {
      const strip = document.getElementById('modality-selector')!;
      const pill = strip.querySelector('.modality-btn.active') as HTMLElement;
      const ring = parseFloat(getComputedStyle(pill).boxShadow.match(/([\d.]+)px\s*$/)?.[1] ?? '0');
      return { ring, above: pill.offsetTop, below: strip.clientHeight - (pill.offsetTop + pill.offsetHeight) };
    });
    expect(g.ring).toBeGreaterThan(0);
    expect(g.above).toBeGreaterThanOrEqual(g.ring);
    expect(g.below).toBeGreaterThanOrEqual(g.ring);
  });

  // Reported: the horizontal scrollbar painted over the pills while swiping. Chromium's is an
  // OVERLAY here, so the only ways out are reserving height or not having one.
  test('no scrollbar paints over the pill row', async ({ page }) => {
    await loadInited(page, WIDE);
    const bar = await page.evaluate(() => {
      const strip = document.getElementById('modality-selector')!;
      return { layoutSpace: strip.offsetHeight - strip.clientHeight, width: getComputedStyle(strip).scrollbarWidth };
    });
    expect(bar.width).toBe('none');
    expect(bar.layoutSpace).toBe(0);
    // Still scrollable — hiding the bar must not have hidden the overflow.
    expect((await pillScroll(page)).overflow).toBeGreaterThan(0);
  });

  // Reported: switching modality flickered. The label was rewritten on every render, replacing the
  // pill's text node mid-transition; only the class attributes should change on a plain switch.
  test('switching modality mutates classes only, never the labels', async ({ page }) => {
    await loadInited(page, WIDE);
    await page.evaluate(() => {
      const w = window as any;
      w.__mut = { attr: 0, text: 0 };
      new MutationObserver((rs) => {
        for (const r of rs) {
          if (r.type === 'attributes') w.__mut.attr++;
          else w.__mut.text++;
        }
      }).observe(document.getElementById('modality-selector')!, {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
    });
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => getState(page).then((s) => s.currentModalityIndex)).toBe(1);
    await page.waitForTimeout(300);

    const mut = await page.evaluate(() => (window as any).__mut);
    expect(mut.text).toBe(0);
    expect(mut.attr).toBeGreaterThan(0);
  });

  // Navigation slides; the wheel stays instant so the strip never feels laggy under the pointer.
  // A smooth scroll emits many scroll events, an assignment exactly one — that is the discriminator.
  test('navigation slides the pill row, a wheel jumps it', async ({ page }) => {
    await loadInited(page, WIDE);

    // A wheel lands entirely inside its own event: read straight after dispatch, the strip is already there.
    const wheel = await page.evaluate(() => {
      const strip = document.getElementById('modality-selector')!;
      strip.scrollLeft = 0;
      const before = strip.scrollLeft;
      strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      return { before, immediately: strip.scrollLeft };
    });
    expect(wheel.immediately).toBe(wheel.before + 120);

    // Navigation does not: it is still short of the target one turn after the keypress, then arrives.
    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 99999; });
    const parked = (await pillScroll(page)).left;
    await page.keyboard.press('ArrowRight');
    const midSlide = await page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft);
    expect(midSlide).toBe(parked);

    await settled(page);
    expect((await pillScroll(page)).left).toBeLessThan(parked);
  });

  // Reported: the row axis felt jaggy where the native horizontal one is smooth. Its wheel deltas are
  // summed and applied once per frame, so a burst must still travel their exact sum.
  test('a burst of wheel events travels their exact sum, in one apply', async ({ page }) => {
    await loadInited(page, TALL);
    await page.locator('#carousel').hover();
    // The wall's transform is written once per apply, so counting those counts the applies. Summing
    // correctly is not enough on its own — applying each event separately reaches the same offset,
    // having done the rebind work eight times and painted only the last.
    await page.evaluate(() => {
      const w = window as any;
      w.__applies = 0;
      new MutationObserver((rs) => { w.__applies += rs.length; })
        .observe(document.getElementById('carousel-wall')!, { attributes: true, attributeFilter: ['style'] });
      const el = document.getElementById('carousel')!;
      for (let i = 0; i < 8; i++) {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
      }
    });
    await expect.poll(() => wallOffset(page)).toBe(80);
    expect(await page.evaluate(() => (window as any).__applies)).toBe(1);
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

  // Reported: after a sweep re-aim, scrolling froze for about a second. Every arriving thumbnail ran
  // an attribute-selector search over the whole carousel subtree, and a re-aim delivers hundreds.
  // Counting the searches is the discriminator — the tiles land correctly either way.
  test('a burst of thumbnails searches the carousel DOM zero times', async ({ page }) => {
    await loadInited(page, WIDE);
    await page.evaluate(() => {
      const w = window as any;
      w.__q = 0;
      const el = document.getElementById('carousel')!;
      const real = el.querySelector.bind(el);
      el.querySelector = (sel: string) => { w.__q++; return real(sel); };
      const realAll = el.querySelectorAll.bind(el);
      el.querySelectorAll = (sel: string) => { w.__q++; return realAll(sel); };
    });

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    for (let t = 0; t < 3; t++) {
      for (let m = 0; m < 24; m++) {
        await page.evaluate(
          ([tupleIndex, modalityIndex, dataUrl]) =>
            (window as any).__ic_send({ type: 'thumbnail', tupleIndex, modalityIndex, dataUrl }),
          [t, m, png] as [number, number, string],
        );
      }
    }

    expect(await page.evaluate(() => (window as any).__q)).toBe(0);
    // The thumbnails still landed: tiles on the bound rows are painting from blob urls.
    await expect
      .poll(() => page.$$eval('.carousel-row .carousel-thumb', (imgs) =>
        imgs.filter((i) => (i as HTMLImageElement).src.startsWith('blob:')).length))
      .toBeGreaterThan(0);
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
