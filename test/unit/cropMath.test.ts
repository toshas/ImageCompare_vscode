import { describe, it, expect } from 'vitest';
import { screenToImage, imageToScreen, ViewportInfo } from '../../src/webview/crop';

// Fake a 1000x600 viewer rect with no carousel offset.
function viewport(over: Partial<ViewportInfo> = {}): ViewportInfo {
  return {
    viewerEl: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    } as unknown as HTMLElement,
    zoom: 1,
    panX: 0,
    panY: 0,
    imgW: 800,
    imgH: 400,
    carouselOffset: 0,
    ...over,
  };
}

describe('crop coordinate mapping (real webview/crop.ts code)', () => {
  it('viewer center maps to image center', () => {
    const vp = viewport();
    const { x, y } = screenToImage(500, 300, vp);
    expect(x).toBe(vp.imgW / 2);
    expect(y).toBe(vp.imgH / 2);
  });

  it('screenToImage and imageToScreen are inverses (interior point)', () => {
    const vp = viewport({ zoom: 2, panX: 40, panY: -25 });
    const screen = imageToScreen(123, 77, vp);
    const back = screenToImage(screen.x, screen.y, vp);
    expect(back.x).toBe(123);
    expect(back.y).toBe(77);
  });

  it('clamps to image bounds', () => {
    const vp = viewport();
    expect(screenToImage(-99999, -99999, vp)).toEqual({ x: 0, y: 0 });
    expect(screenToImage(99999, 99999, vp)).toEqual({ x: vp.imgW, y: vp.imgH });
  });

  it('accounts for the carousel offset on the left', () => {
    const noOffset = screenToImage(500, 300, viewport());
    const withOffset = screenToImage(500, 300, viewport({ carouselOffset: 200 }));
    // Same screen X now lands further right in image space (viewer is narrower & shifted).
    expect(withOffset.x).not.toBe(noOffset.x);
  });
});
