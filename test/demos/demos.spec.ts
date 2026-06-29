import { test, Page, expect } from '@playwright/test';
import { HARNESS_URL } from '../webview/harness';
import { initMessage, thumbnailMessages, FixtureSpec } from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Each test records a short, captioned video of ONE feature on legible
 * generated fixtures (gradient + grid + big modality/tuple labels), so what's
 * happening is obvious. Playwright auto-saves each video to
 * raw/demos-<id>-chromium/video.webm; build-gallery.mjs maps it back by id.
 */

const SPEC: FixtureSpec = {
  tupleNames: ['scene_000', 'scene_001', 'scene_002'],
  modalities: ['GT', 'PRED'],
  width: 480,
  height: 320,
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

/** Init the webview with legible, content-rich images drawn in-browser. */
async function loadDemo(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() =>
    (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'),
  );
  await page.evaluate((msg) => (window as any).__ic_send(msg), initMessage(SPEC) as any);
  for (const m of thumbnailMessages(SPEC)) {
    await page.evaluate((x) => (window as any).__ic_send(x), m as any);
  }
  // Rich images: gradient + grid + big modality/tuple label, so zoom/pan/crop
  // and modality switching are visually obvious (not flat color blocks).
  await page.evaluate((spec) => {
    const draw = (w: number, h: number, label: string, sub: string, hue: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d')!;
      // Flat background (compresses well; large unchanged regions while panning).
      x.fillStyle = `hsl(${hue},52%,40%)`;
      x.fillRect(0, 0, w, h);
      // A bright marker so zoom/pan have a feature to track.
      x.fillStyle = `hsl(${(hue + 45) % 360},75%,62%)`;
      x.beginPath();
      x.arc(w * 0.72, h * 0.34, Math.min(w, h) * 0.15, 0, Math.PI * 2);
      x.fill();
      // Sparse grid so motion is visible.
      x.strokeStyle = 'rgba(255,255,255,0.3)';
      x.lineWidth = 2;
      for (let i = 48; i < w; i += 48) {
        x.beginPath();
        x.moveTo(i, 0);
        x.lineTo(i, h);
        x.stroke();
      }
      for (let j = 48; j < h; j += 48) {
        x.beginPath();
        x.moveTo(0, j);
        x.lineTo(w, j);
        x.stroke();
      }
      // Big label band.
      x.fillStyle = 'rgba(0,0,0,0.45)';
      x.fillRect(0, h / 2 - 46, w, 92);
      x.fillStyle = '#fff';
      x.textAlign = 'center';
      x.font = 'bold 58px -apple-system, Segoe UI, sans-serif';
      x.fillText(label, w / 2, h / 2 + 6);
      x.font = '22px -apple-system, Segoe UI, sans-serif';
      x.fillText(sub, w / 2, h / 2 + 38);
      return c.toDataURL('image/png');
    };
    spec.tupleNames.forEach((name: string, ti: number) => {
      spec.modalities.forEach((m: string, mi: number) => {
        const hue = (ti * 75 + mi * 185) % 360;
        const url = draw(spec.width, spec.height, m, name, hue);
        (window as any).__ic_send({
          type: 'image',
          tupleIndex: ti,
          modalityIndex: mi,
          dataUrl: url,
          width: spec.width,
          height: spec.height,
        });
      });
    });
  }, SPEC);
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
  await caption(page, '↑ / ↓  — move between tuples (scene_000 → 001 → 002)');
  await beat(page, 900);
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(k);
    await beat(page, 850);
  }
});

test('switch-modality', async ({ page }) => {
  await loadDemo(page);
  await focusViewer(page);
  await caption(page, '← / →  — switch modality (GT ⇄ PRED), zoom/pan stay locked');
  await beat(page, 900);
  for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(k);
    await beat(page, 850);
  }
});

test('zoom', async ({ page }) => {
  await loadDemo(page);
  await caption(page, 'Scroll to zoom in — Esc resets to fit');
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
  await caption(page, 'Zoom in, then drag to pan around the image');
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
  await caption(page, 'Press C, drag a rectangle, Enter — crops every modality at once');
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
  await caption(page, 'Enter — mark the current modality as the winner (saved to results.txt)');
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
  await caption(page, '[ / ]  — reorder the modality pills');
  await beat(page, 900);
  await page.keyboard.press(']');
  await beat(page, 1000);
  await page.keyboard.press('[');
  await beat(page, 1000);
});

test('help-modal', async ({ page }) => {
  await loadDemo(page);
  await caption(page, 'Click “?” for the keyboard-shortcut reference — Esc closes it');
  await beat(page, 700);
  await page.locator('#help-btn').click();
  await beat(page, 1400);
  await page.keyboard.press('Escape');
  await beat(page, 600);
});

test('collapse-panel', async ({ page }) => {
  await loadDemo(page);
  await caption(page, 'Collapse / expand the floating Tools panel');
  await beat(page, 700);
  await page.locator('#fp-collapse-btn').click();
  await beat(page, 1000);
  await page.locator('#fp-collapse-btn').click();
  await beat(page, 700);
});

test('multi-select', async ({ page }) => {
  await loadDemo(page);
  await caption(page, 'Drag a box over thumbnails to multi-select — ⌘/Ctrl+C copies the files');
  await beat(page, 900);
  const a = await page.locator('.carousel-thumb-container').first().boundingBox();
  const b = await page.locator('.carousel-thumb-container').last().boundingBox();
  if (!a || !b) throw new Error('no tiles');
  await page.mouse.move(a.x + 4, a.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 4, b.y + b.height - 4, { steps: 30 });
  await beat(page, 1100);
  await page.mouse.up();
  await beat(page, 900);
});

test('click-pill', async ({ page }) => {
  await loadDemo(page);
  await caption(page, 'Click a colored modality pill to jump to it');
  await beat(page, 700);
  await page.locator('.modality-btn').nth(1).click();
  await beat(page, 900);
  await page.locator('.modality-btn').nth(0).click();
  await beat(page, 700);
});
