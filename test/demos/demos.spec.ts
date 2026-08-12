import { test, Page, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_URL } from '../webview/harness';
import { initMessage, FixtureSpec } from '../fixtures/messages';
import { photoFixtures, PHOTO_TUPLES, PHOTO_MODALITIES } from './photoFixtures';

// demos.json is the single source for the banner text: burned into the clip here, printed above it by build-gallery.mjs.
const DEMO_META = JSON.parse(readFileSync(join(__dirname, 'demos.json'), 'utf8')) as {
  demos: Array<{ id: string; caption: string }>;
};
function captionFor(id: string): string {
  const d = DEMO_META.demos.find((x) => x.id === id);
  if (!d) throw new Error(`no demos.json entry for "${id}"`);
  return d.caption;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Each test records a short, captioned video of ONE feature on real
 * photographs (test/fixtures/images/) processed into fake CV modalities via
 * Sharp (see photoFixtures.ts), so what's happening is obvious. Playwright
 * auto-saves each video to raw/demos-<id>-chromium/video.webm;
 * build-gallery.mjs maps it back by id.
 */

const SPEC: FixtureSpec = {
  tupleNames: PHOTO_TUPLES,
  modalities: PHOTO_MODALITIES,
  width: 480,
  height: 480,
  votingEnabled: true,
};

const beat = (page: Page, ms = 650) => page.waitForTimeout(ms);

/** On-screen caption banner so the viewer knows what each step does. */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      Object.assign(el.style, {
        position: 'fixed',
        left: '50%',
        bottom: '60px',
        transform: 'translateX(-50%)',
        background: 'rgba(10,12,18,0.9)',
        color: '#fff',
        font: '600 19px -apple-system, Segoe UI, sans-serif',
        padding: '11px 20px',
        borderRadius: '12px',
        zIndex: '99999',
        pointerEvents: 'none',
        maxWidth: '82%',
        textAlign: 'center',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      } as CSSStyleDeclaration);
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

/** Init the webview with real photos processed into fake CV modalities. */
async function loadDemo(page: Page): Promise<void> {
  const fixtures = await photoFixtures();
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() =>
    (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'),
  );
  await page.evaluate((msg) => (window as any).__ic_send(msg), initMessage(SPEC) as any);
  for (const f of fixtures) {
    await page.evaluate((x) => (window as any).__ic_send(x), {
      type: 'thumbnail',
      tupleIndex: f.tupleIndex,
      modalityIndex: f.modalityIndex,
      dataUrl: f.thumbUrl,
    } as any);
  }
  // Completion signal, as the extension host sends it — hides the progress toast.
  await page.evaluate(
    (n) => (window as any).__ic_send({ type: 'thumbnailProgress', current: n, total: n }),
    fixtures.length,
  );
  // Full-size images as dataUrl; the harness's __ic_send converts each to the
  // real binary bytes+mime wire shape before dispatching to the bundle.
  for (const f of fixtures) {
    await page.evaluate((x) => (window as any).__ic_send(x), {
      type: 'image',
      tupleIndex: f.tupleIndex,
      modalityIndex: f.modalityIndex,
      dataUrl: f.dataUrl,
      width: f.width,
      height: f.height,
    } as any);
  }
  await expect(page.locator('#viewer')).toHaveClass(/active/);
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  });
}

async function focusViewer(page: Page) {
  await page.locator('#viewer').click({ position: { x: 12, y: 12 } });
}
async function center(page: Page) {
  const b = await page.locator('#viewer').boundingBox();
  if (!b) throw new Error('no viewer');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
}

test('navigate-tuples', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, captionFor('navigate-tuples'));
  await beat(page, 900);
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(k);
    await beat(page, 850);
  }
});

test('switch-modality', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, captionFor('switch-modality'));
  await beat(page, 900);
  for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(k);
    await beat(page, 850);
  }
});

test('zoom', async ({ page }) => {
  await loadDemo(page);
  await caption(page, captionFor('zoom'));
  const { x, y } = await center(page);
  await page.mouse.move(x, y);
  await beat(page, 700);
  for (let i = 0; i < 9; i++) {
    await page.mouse.wheel(0, -170);
    await beat(page, 150);
  }
  await beat(page, 700);
  await page.keyboard.press('Escape');
  await beat(page, 700);
});

test('pan', async ({ page }) => {
  await loadDemo(page);
  await caption(page, captionFor('pan'));
  const { x, y } = await center(page);
  await page.mouse.move(x, y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -190);
  await beat(page, 700);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y - 80, { steps: 25 });
  await page.mouse.move(x + 110, y + 60, { steps: 25 });
  await page.mouse.up();
  await beat(page, 700);
});

test('crop', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, captionFor('crop'));
  await beat(page, 900);
  await page.keyboard.press('c');
  await beat(page, 600);
  const { b } = await center(page);
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.38);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.68, { steps: 30 });
  await page.mouse.up();
  await beat(page, 900);
  await page.keyboard.press('Enter');
  await beat(page, 800);
});

test('winner-vote', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, captionFor('winner-vote'));
  await beat(page, 900);
  await page.keyboard.press('Enter');
  await beat(page, 1000);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await beat(page, 1000);
});

test('reorder-modality', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, captionFor('reorder-modality'));
  await beat(page, 900);
  await page.keyboard.press(']');
  await beat(page, 1000);
  await page.keyboard.press('[');
  await beat(page, 1000);
});

test('help-modal', async ({ page }) => {
  await loadDemo(page);
  await caption(page, captionFor('help-modal'));
  await beat(page, 700);
  await page.locator('#help-btn').click();
  await beat(page, 1400);
  await page.keyboard.press('Escape');
  await beat(page, 600);
});

test('collapse-panel', async ({ page }) => {
  await loadDemo(page);
  await caption(page, captionFor('collapse-panel'));
  await beat(page, 700);
  await page.locator('#fp-collapse-btn').click();
  await beat(page, 1000);
  await page.locator('#fp-collapse-btn').click();
  await beat(page, 700);
});

test('click-pill', async ({ page }) => {
  await loadDemo(page);
  await caption(page, captionFor('click-pill'));
  await beat(page, 700);
  await page.locator('.modality-btn').nth(1).click();
  await beat(page, 900);
  await page.locator('.modality-btn').nth(0).click();
  await beat(page, 700);
});
