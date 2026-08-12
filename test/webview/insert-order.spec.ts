import { test, expect } from '@playwright/test';
import { loadInited, getState } from './helpers';

// Pins docs/tuple-matching.md: rearrangement-survives-insert — a watcher-inserted
// modality must not reset the user's pill arrangement or the focused modality.
test.describe('modalityAdded preserves the user arrangement', () => {
  test('custom order and focus survive an insert; the new column lands beside its original neighbour', async ({ page }) => {
    await loadInited(page); // 3 tuples x 2 modalities (originals 0,1), identity order

    // Rearrange: move modality 0 right -> display order [1, 0], focus follows to display 1.
    await page.keyboard.press(']');
    let s = await getState(page);
    expect(s.modalityOrder).toEqual([1, 0]);
    expect(s.currentModalityIndex).toBe(1);

    // Extension inserts a new modality at original index 1 (between old originals 0 and 1).
    await page.evaluate(() => (window as any).__ic_send({
      type: 'modalityAdded',
      modality: 'inserted',
      modalityPath: '/data/inserted',
      modalityColors: ['#ff0000', '#00ff00', '#0000ff'],
      modalityIndex: 1,
    }));

    s = await getState(page);
    // Old originals shift (0->0, 1->2); arrangement [2, 0] preserved; new original 1
    // lands after its original-order predecessor 0 -> [2, 0, 1]. No identity reset.
    expect(s.modalityOrder).toEqual([2, 0, 1]);
    // Focus stays on the same modality (display index shifts only at/after the insertion point).
    expect(s.currentModalityIndex).toBe(1);
    await expect(page.locator('#modality-selector .modality-btn')).toHaveCount(3);
  });
});
