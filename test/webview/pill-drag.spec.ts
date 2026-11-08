import { test, expect, Page } from '@playwright/test';
import { loadInited, getState, focusViewer } from './helpers';
import { DEFAULT_SPEC, FixtureSpec } from '../fixtures/messages';
import { TouchDriver, centreOf } from './touchDriver';
import { FRACTIONAL_PILLS_CSS } from './harness';

/**
 * Pill drag-reorder (docs/pointer-input.md), on the real bundle. The permutation itself is
 * mutation-covered in test/unit/pillReorder.test.ts; everything here is DOM and pointer wiring in
 * webview/pillDrag.ts and webview/main.ts, which the Vitest-only mutation harness cannot reach — see
 * docs/testing.md, "What nothing covers".
 */

const FOUR: FixtureSpec = { ...DEFAULT_SPEC, modalities: ['A', 'B', 'C', 'D'] };
const LONG: FixtureSpec = {
  ...DEFAULT_SPEC,
  modalities: Array.from({ length: 40 }, (_, i) => `M${String(i).padStart(2, '0')}`),
};

const pill = (i: number) => `#modality-selector .modality-btn >> nth=${i}`;

async function pillBox(page: Page, i: number) {
  const box = await page.locator('#modality-selector .modality-btn').nth(i).boundingBox();
  if (!box) throw new Error(`pill ${i} has no box`);
  return box;
}

/** x the dragged pill's pointer must reach for its centre to sit `px` past pill `to`'s midpoint. */
async function dropX(page: Page, from: number, to: number, px = 3): Promise<{ x0: number; y: number; x1: number }> {
  const a = await pillBox(page, from);
  const b = await pillBox(page, to);
  const x0 = a.x + a.width / 2;
  const target = b.x + b.width / 2 + (to > from ? px : -px);
  return { x0, y: a.y + a.height / 2, x1: target };
}

async function mouseDrag(page: Page, from: number, to: number, steps = 12): Promise<void> {
  const { x0, y, x1 } = await dropX(page, from, to);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps });
  await page.mouse.up();
}

/** Replaces `navigator.vibrate` with a counter; read it back with `vibrations`. */
async function stubVibrate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vibrations: number };
    w.__vibrations = 0;
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { w.__vibrations++; return true; } });
  });
}

async function vibrations(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __vibrations: number }).__vibrations);
}

test.describe('pill drag-reorder (mouse)', () => {
  test('dragging a pill 0 -> 2 moves it, the pills between close up, and votes, peek target and the shown modality follow', async ({ page }) => {
    await loadInited(page, FOUR);
    await stubVibrate(page);
    await focusViewer(page);
    // Vote B on tuple 0, then return to A so B is the Space-peek target.
    await page.locator(pill(1)).click();
    await page.keyboard.press('Enter');
    await page.locator(pill(0)).click();
    let s = await getState(page);
    expect(s.currentModalityIndex).toBe(0);
    expect(s.winners).toEqual([[0, 1]]);

    await mouseDrag(page, 0, 2);
    // Only a finger's lift vibrates.
    expect(await vibrations(page)).toBe(0);

    s = await getState(page);
    // [A, B, C, D] -> [B, C, A, D]: a move, not a swap of A and C.
    expect(s.modalityOrder).toEqual([1, 2, 0, 3]);
    expect(await page.locator('#modality-selector .modality-btn').allTextContents()).toEqual(['B (1)', 'C', 'A', 'D']);
    expect(s.modalityPaths).toEqual(['/fixtures/B', '/fixtures/C', '/fixtures/A', '/fixtures/D']);
    // The shown modality is still A, now at display 2.
    expect(s.modalityOrder[s.currentModalityIndex]).toBe(0);
    // The vote on B (between from and to) followed B to display 0.
    expect(s.winners).toEqual([[0, 0]]);
    // The Space-peek target is still B.
    await page.keyboard.down('Space');
    const peek = await getState(page);
    expect(peek.modalityOrder[peek.currentModalityIndex]).toBe(1);
    await page.keyboard.up('Space');
    // No pill is left carrying an inline transform.
    const transforms = await page.$$eval('#modality-selector .modality-btn', (els) => els.map((e) => (e as HTMLElement).style.transform));
    expect(transforms.every((t) => t === '')).toBe(true);
  });

  test('a click, and a 3 px wobble, select the pill without reordering', async ({ page }) => {
    await loadInited(page, FOUR);
    await page.locator(pill(2)).click();
    let s = await getState(page);
    expect(s.currentModalityIndex).toBe(2);
    expect(s.modalityOrder).toEqual([0, 1, 2, 3]);

    const b = await pillBox(page, 3);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2, { steps: 3 });
    await page.mouse.up();
    s = await getState(page);
    expect(s.currentModalityIndex).toBe(3);
    expect(s.modalityOrder).toEqual([0, 1, 2, 3]);
  });

  test('dragging a pill that is not current does not select it', async ({ page }) => {
    await loadInited(page, FOUR);
    await mouseDrag(page, 3, 0);
    // Chromium sends no click at all after a drop that rebuilds the row (the pressed pill is gone), and
    // after a drag dropped where it started sends one to the row (the capture target), never the pill
    // (probed; docs/pointer-input.md, "drag-is-not-a-click"). An engine that clicks the pill beneath
    // is what the swallow exists for, so stand in for one by hand: a pointer-made click carries
    // detail >= 1, which a programmatic click() (detail 0, never swallowed) does not.
    await page.evaluate(() => document.querySelectorAll('#modality-selector .modality-btn')[0].dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    ));
    const s = await getState(page);
    // [A, B, C, D] -> [D, A, B, C]; A stays on screen, now at display 1.
    expect(s.modalityOrder).toEqual([3, 0, 1, 2]);
    expect(s.currentModalityIndex).toBe(1);
    expect(s.modalityOrder[s.currentModalityIndex]).toBe(0);
  });

  test('a real mouse click 50 ms after a mouse drag drop selects the pill', async ({ page }) => {
    await loadInited(page, FOUR);
    await mouseDrag(page, 3, 0);
    let s = await getState(page);
    expect(s.modalityOrder).toEqual([3, 0, 1, 2]);
    expect(s.currentModalityIndex).toBe(1);
    await page.waitForTimeout(50);
    await page.locator(pill(2)).click();
    s = await getState(page);
    expect(s.currentModalityIndex).toBe(2);
    expect(s.modalityOrder).toEqual([3, 0, 1, 2]);
  });

  test('a lifted end pill, its lift scale included, stays within the row\'s ends at either end of a drag', async ({ page }) => {
    await loadInited(page, FOUR);
    // Fractional pill widths whatever the fonts: whole-pixel offsets put the clamp ~1.3 px past the far end here.
    await page.addStyleTag({ content: FRACTIONAL_PILLS_CSS });
    const rect = (i: number) => page.locator('#modality-selector .modality-btn').nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
    });
    const scrollLeft = () => page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft);
    // The first pill dragged past the far end, then the last pill (the same one, now at display 3) past the near end.
    for (const [i, dir, order] of [[0, 1, [1, 2, 3, 0]], [3, -1, [0, 1, 2, 3]]] as const) {
      await page.mouse.move(5, 5);
      // The ends are read at rest: no pill hovered or mid-transition.
      await expect.poll(() => page.$$eval('#modality-selector .modality-btn', (els) => els.every((el) => el.getAnimations().length === 0 && !el.matches(':hover')))).toBe(true);
      const start = await rect(0);
      const end = await rect(3);
      const p = await rect(i);
      expect(p.width % 1).not.toBe(0);
      expect(await scrollLeft()).toBe(0);
      await page.mouse.move(p.cx, p.cy);
      // Pressed fully hovered, as a hand presses: the hover scale must not leak into the measured row.
      await expect.poll(() => page.locator(pill(i)).evaluate((el) => el.matches(':hover') && el.getAnimations().length === 0)).toBe(true);
      await page.mouse.down();
      await page.mouse.move(dir > 0 ? end.right + 200 : start.left - 200, p.cy, { steps: 12 });
      await expect(page.locator(pill(i))).toHaveClass(/pill-dragging/);
      const lifted = await rect(i);
      const scale = await page.locator(pill(i)).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      expect(scale).toBeGreaterThan(1.05);
      expect(await scrollLeft()).toBe(0);
      expect(lifted.left).toBeGreaterThanOrEqual(start.left - 0.5);
      expect(lifted.right).toBeLessThanOrEqual(end.right + 0.5);
      // Pinned against the end it was dragged to, not merely inside.
      if (dir > 0) expect(lifted.right).toBeGreaterThan(end.right - 1.5);
      else expect(lifted.left).toBeLessThan(start.left + 1.5);
      await page.mouse.up();
      expect((await getState(page)).modalityOrder).toEqual(order);
    }
  });

  test('the reorder buttons are gone and [ ] still reorder', async ({ page }) => {
    await loadInited(page, FOUR);
    await expect(page.locator('#reorder-left')).toHaveCount(0);
    await expect(page.locator('#reorder-right')).toHaveCount(0);
    await focusViewer(page);
    await page.keyboard.press(']');
    expect((await getState(page)).modalityOrder).toEqual([1, 0, 2, 3]);
    await page.keyboard.press(']');
    expect((await getState(page)).modalityOrder).toEqual([1, 2, 0, 3]);
    await page.keyboard.press('[');
    expect((await getState(page)).modalityOrder).toEqual([1, 0, 2, 3]);
  });

  test('long row: a drag restyles only the pills it passes, never rebuilds the row, and commits with one rebuild', async ({ page }) => {
    await loadInited(page, LONG);
    await page.evaluate(() => { document.getElementById('modality-selector')!.scrollLeft = 100; });
    const scrolled = await page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft);
    expect(scrolled).toBe(100);

    await page.evaluate(() => {
      const row = document.getElementById('modality-selector')!;
      const w = window as unknown as { __rebuilds: number; __childRecords: number; __styled: Set<Element> };
      w.__rebuilds = 0;
      w.__childRecords = 0;
      w.__styled = new Set();
      new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'childList' && r.target === row) {
            w.__childRecords++;
            if (r.removedNodes.length === 40) w.__rebuilds++;
          }
          if (r.type === 'attributes') w.__styled.add(r.target as Element);
        }
      }).observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    });

    const from = 8, to = 11;
    const { x0, y, x1 } = await dropX(page, from, to);
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x1, y, { steps: 15 });
    // Let the observer deliver everything the moves caused.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    const during = await page.evaluate(() => {
      const w = window as unknown as { __rebuilds: number; __childRecords: number; __styled: Set<Element> };
      const pills = Array.from(document.querySelectorAll<HTMLElement>('#modality-selector .modality-btn'));
      return {
        childRecords: w.__childRecords,
        styled: w.__styled.size,
        withTransform: pills.filter((p) => p.style.transform !== '').length,
      };
    });
    expect(during.childRecords).toBe(0);
    expect(during.withTransform).toBe(Math.abs(to - from) + 1);
    expect(during.styled).toBeLessThanOrEqual(Math.abs(to - from) + 1);

    await page.mouse.up();
    const after = await page.evaluate(() => {
      const w = window as unknown as { __rebuilds: number };
      return { rebuilds: w.__rebuilds, scrollLeft: document.getElementById('modality-selector')!.scrollLeft };
    });
    expect(after.rebuilds).toBe(1);
    expect(after.scrollLeft).toBe(100);
    const order = (await getState(page)).modalityOrder;
    expect(order.slice(7, 13)).toEqual([7, 9, 10, 11, 8, 12]);
  });
});

/** Counts the clicks that reach each pill element itself (bubble phase on the pill). */
async function countPillClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __pillClicks: number[] };
    const pills = Array.from(document.querySelectorAll('#modality-selector .modality-btn'));
    w.__pillClicks = pills.map(() => 0);
    pills.forEach((p, i) => p.addEventListener('click', () => { w.__pillClicks[i]++; }));
  });
}

async function pillClicks(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __pillClicks: number[] }).__pillClicks);
}

/** A pen through CDP: Chromium turns it into pen pointer events plus compatibility mouse events and, for a tap, its own click. */
async function penInput(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, x: number, y: number, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen' } as never);
  return {
    down: (x: number, y: number) => send('mousePressed', x, y, 1),
    move: (x: number, y: number) => send('mouseMoved', x, y, 1),
    up: (x: number, y: number) => send('mouseReleased', x, y, 0),
  };
}

/** What an engine that also fires touch events for a stylus delivers: pen pointer events and no click (the row cancels touchstart). */
async function handPenTap(page: Page, i: number): Promise<void> {
  const b = await pillBox(page, i);
  await page.evaluate(({ i, x, y }) => {
    const el = document.querySelectorAll('#modality-selector .modality-btn')[i];
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  }, { i, x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

test.describe('pill drag-reorder (pen)', () => {
  test('a CDP pen drag past 5 px reorders, and a CDP pen tap on a pill selects it with exactly one click on the pill', async ({ page }) => {
    await loadInited(page, FOUR);
    const pen = await penInput(page);
    const { x0, y, x1 } = await dropX(page, 0, 2);
    await pen.down(x0, y);
    for (let i = 1; i <= 12; i++) await pen.move(x0 + ((x1 - x0) * i) / 12, y);
    await pen.up(x1, y);
    let s = await getState(page);
    expect(s.modalityOrder).toEqual([1, 2, 0, 3]);
    expect(s.modalityOrder[s.currentModalityIndex]).toBe(0);
    // Counted on the rebuilt row.
    await countPillClicks(page);
    const b = await pillBox(page, 1);
    const x = b.x + b.width / 2, ty = b.y + b.height / 2;
    await pen.down(x, ty);
    await pen.up(x, ty);
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);
    await page.waitForTimeout(50);
    expect(await pillClicks(page)).toEqual([0, 1, 0, 0]);
    s = await getState(page);
    expect(s.modalityOrder).toEqual([1, 2, 0, 3]);
  });

  test('a pen down and up with no click from the engine selects the pill with exactly one click', async ({ page }) => {
    await loadInited(page, FOUR);
    await countPillClicks(page);
    await handPenTap(page, 3);
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(3);
    expect(await pillClicks(page)).toEqual([0, 0, 0, 1]);
    // No press precedes this programmatic click(), so whatever the unanswered tap armed must not eat it.
    await page.evaluate(() => (document.querySelectorAll('#modality-selector .modality-btn')[1] as HTMLElement).click());
    expect((await getState(page)).currentModalityIndex).toBe(1);
  });
});

test.describe('pill drag-reorder (touch)', () => {
  test.use({ hasTouch: true });

  test('a held pill lifts with one vibration and drags 0 -> 2, and a tap 50 ms after the drop selects', async ({ page }) => {
    await loadInited(page, FOUR);
    await stubVibrate(page);
    const touch = await TouchDriver.attach(page);
    const { x0, y, x1 } = await dropX(page, 0, 2);
    await touch.drag({ x: x0, y }, { x: x1, y }, 12, 16, 400);
    let s = await getState(page);
    expect(s.modalityOrder).toEqual([1, 2, 0, 3]);
    expect(s.currentModalityIndex).toBe(2);
    expect(await vibrations(page)).toBe(1);
    await page.waitForTimeout(50);
    await touch.tap(await centreOf(page, pill(0)));
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(0);
    s = await getState(page);
    expect(s.modalityOrder).toEqual([1, 2, 0, 3]);
  });

  test('a held first pill is drawn within the row\'s near end from the moment it lifts', async ({ page }) => {
    await loadInited(page, FOUR);
    const rect = () => page.locator(pill(0)).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const start = await rect();
    const touch = await TouchDriver.attach(page);
    await touch.start({ x: start.left + start.width / 2, y: start.top + start.height / 2 });
    // Lifted by the hold alone: no move has drawn it yet.
    await expect(page.locator(pill(0))).toHaveClass(/pill-dragging/, { timeout: 2000 });
    const scale = await page.locator(pill(0)).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(scale).toBeGreaterThan(1.05);
    const lifted = await rect();
    expect(lifted.left).toBeGreaterThanOrEqual(start.left - 0.5);
    await touch.end();
  });

  test('a quick swipe scrolls the row and reorders nothing, and a tap 50 ms after its fling selects', async ({ page }) => {
    await loadInited(page, LONG);
    // The pill the tap lands on, read where the press lands (the fling may still be moving the row when the target is measured).
    await page.evaluate(() => {
      const w = window as unknown as { __pressed: number[] };
      w.__pressed = [];
      const row = document.getElementById('modality-selector')!;
      row.addEventListener('pointerdown', (e) => {
        const p = (e.target as HTMLElement).closest('.modality-btn');
        w.__pressed.push(p ? Array.from(row.querySelectorAll('.modality-btn')).indexOf(p) : -1);
      }, true);
    });
    const touch = await TouchDriver.attach(page);
    const start = await centreOf(page, pill(6));
    await touch.drag(start, { x: start.x - 200, y: start.y }, 10, 10);
    expect(await page.evaluate(() => document.getElementById('modality-selector')!.scrollLeft)).toBeGreaterThan(100);
    expect((await getState(page)).currentModalityIndex).toBe(0);
    await page.waitForTimeout(50);
    await touch.tap({ x: start.x, y: start.y });
    const pressed = await page.evaluate(() => (window as unknown as { __pressed: number[] }).__pressed);
    expect(pressed).toHaveLength(2);
    const target = pressed[1];
    expect(target).toBeGreaterThan(6);
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(target);
    expect((await getState(page)).modalityOrder).toEqual(LONG.modalities.map((_, i) => i));
  });

  test('a touchstart on a pill arrives default-prevented', async ({ page }) => {
    await loadInited(page, FOUR);
    await page.evaluate(() => {
      const w = window as unknown as { __tsPrevented: boolean[] };
      w.__tsPrevented = [];
      // Bubble phase on document: runs after the row's own listener has seen the event.
      document.addEventListener('touchstart', (e) => w.__tsPrevented.push(e.defaultPrevented), { passive: false });
    });
    const touch = await TouchDriver.attach(page);
    await touch.tap(await centreOf(page, pill(1)));
    expect(await page.evaluate(() => (window as unknown as { __tsPrevented: boolean[] }).__tsPrevented)).toEqual([true]);
    // So the browser sends no click for the tap: the row clicks the pill itself.
    await expect.poll(async () => (await getState(page)).currentModalityIndex).toBe(1);
  });

  test("a lostpointercapture at the lifted pill mid-drag does not end the drag (the real-Android hand-over)", async ({ page }) => {
    await loadInited(page, FOUR);
    await page.evaluate(() => {
      const w = window as unknown as { __pid: number };
      document.getElementById('modality-selector')!.addEventListener('pointerdown', (e) => { w.__pid = e.pointerId; });
    });
    const touch = await TouchDriver.attach(page);
    const { x0, y, x1 } = await dropX(page, 0, 2);
    const mid = (await dropX(page, 0, 1)).x1;
    await touch.start({ x: x0, y });
    await page.waitForTimeout(400);
    for (let i = 1; i <= 6; i++) { await touch.move({ x: x0 + ((mid - x0) * i) / 6, y }); await page.waitForTimeout(16); }
    // What a real Android WebView fires at the pressed pill when the row takes the capture; it bubbles to the row.
    await page.evaluate(() => {
      const pid = (window as unknown as { __pid: number }).__pid;
      const lifted = document.querySelector('#modality-selector .modality-btn.pill-dragging')!;
      lifted.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: pid, pointerType: 'touch' }));
    });
    // The drag is still live: the pill is still lifted, and the order has not been committed early.
    await expect(page.locator('#modality-selector .modality-btn.pill-dragging')).toHaveCount(1);
    expect((await getState(page)).modalityOrder).toEqual([0, 1, 2, 3]);
    for (let i = 1; i <= 6; i++) { await touch.move({ x: mid + ((x1 - mid) * i) / 6, y }); await page.waitForTimeout(16); }
    await touch.end();
    expect((await getState(page)).modalityOrder).toEqual([1, 2, 0, 3]);
  });
});
