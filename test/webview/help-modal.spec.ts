import { test, expect } from '@playwright/test';
import { loadInited } from './helpers';

// Reported on a 13" laptop: the fixed-size modal clipped on all sides of a small window.
test.use({ viewport: { width: 760, height: 440 } });

test.describe('help modal', () => {
  test('help modal fits entirely within a small viewport and scrolls its content', async ({ page }) => {
    await loadInited(page);
    await page.click('#help-btn');
    await expect(page.locator('#help-modal')).toHaveClass(/active/);

    const content = page.locator('#help-modal .modal-content');
    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    // No clipping on any side: the whole content box lies inside the viewport.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(760);
    expect(box!.y + box!.height).toBeLessThanOrEqual(440);

    // Overflowing content scrolls inside the box instead of growing past the viewport.
    const scroll = await content.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(['auto', 'scroll']).toContain(scroll.overflowY);

    // The Close button stays reachable (Playwright scrolls it into view within the box).
    await page.locator('#close-help-btn').click();
    await expect(page.locator('#help-modal')).not.toHaveClass(/active/);
  });

  test('help table lists mode-dependent and mouse inputs the webview actually handles', async ({ page }) => {
    await loadInited(page);
    await page.click('#help-btn');
    const text = await page.locator('#help-modal table').innerText();
    // Enter confirms the crop in crop mode (crop.ts handleCropKeyDown), not winner-toggle.
    expect(text).toContain('Toggle winner / confirm crop (in crop mode)');
    // saveSessionAs fires on ctrlKey || metaKey (main.ts handleKeyDown), so the label must say both.
    expect(text).toContain('Ctrl/Cmd+S');
    // handleCarouselWheel: shift+wheel (or trackpad deltaX) pans overflowing film-strip columns.
    expect(text).toContain('scroll the film strip sideways');
    // crop.ts handleCropMouseDown: double-click on a cardinal handle squares the crop toward that edge.
    expect(text).toContain('square the crop toward that edge');
  });
});
