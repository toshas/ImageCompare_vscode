import { Page, CDPSession } from '@playwright/test';

/**
 * Real touch input for the webview specs, through CDP `Input.dispatchTouchEvent` — the path Chromium
 * itself uses for emulated touch, so pointer events, `touchstart` cancellation and the tap-to-click
 * rule all behave as they do for a finger. Needs a `hasTouch` context.
 *
 * What emulation does NOT do (docs/pointer-input.md, "Only the row's capture ends a drag"): it fires
 * no implicit-capture events, so a real Android WebView's `lostpointercapture` at the pressed pill
 * never happens here. The pill-drag spec dispatches that event by hand.
 */
export interface Point { x: number; y: number }

export class TouchDriver {
  private constructor(private readonly page: Page, private readonly cdp: CDPSession) {}

  static async attach(page: Page): Promise<TouchDriver> {
    return new TouchDriver(page, await page.context().newCDPSession(page));
  }

  async start(...pts: Point[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts.map((p, id) => ({ ...p, id })) });
  }

  async move(...pts: Point[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts.map((p, id) => ({ ...p, id })) });
  }

  /** Lift only finger `id` (its index in the `start` call), leaving the others down; CDP's touchEnd lists the points released. */
  async lift(id: number, p: Point): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...p, id }] });
  }

  async end(): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** One finger from `a` to `b` in `steps` moves, `stepMs` apart. */
  async drag(a: Point, b: Point, steps = 10, stepMs = 16, holdMs = 0): Promise<void> {
    await this.start(a);
    if (holdMs) await this.page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i++) {
      await this.move({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
      if (stepMs) await this.page.waitForTimeout(stepMs);
    }
    await this.end();
  }

  async tap(p: Point): Promise<void> {
    await this.start(p);
    await this.end();
  }
}

/** Centre of the first element matching `selector`, in client coordinates. */
export async function centreOf(page: Page, selector: string): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
