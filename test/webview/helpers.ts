import { Page, expect } from '@playwright/test';
import { HARNESS_URL } from './harness';
import {
  DEFAULT_SPEC,
  FixtureSpec,
  initMessage,
  imageMessages,
  thumbnailMessages,
} from '../fixtures/messages';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IcState {
  currentTupleIndex: number;
  currentModalityIndex: number;
  currentTupleName: string | null;
  tupleCount: number;
  modalityCount: number;
  modalityOrder: number[];
  zoom: number;
  panX: number;
  panY: number;
  cropMode: boolean;
  cropRect: { x: number; y: number; w: number; h: number } | null;
  winners: [number, number][];
  votingEnabled: boolean;
  ppmxColormap: string;
}

/** Load the harness and complete the init handshake with synthetic fixtures. */
export async function loadInited(page: Page, spec: FixtureSpec = DEFAULT_SPEC): Promise<void> {
  await page.goto(HARNESS_URL);
  // Webview posts 'ready' once its listeners are attached.
  await page.waitForFunction(() =>
    (window as any).__ic_outbound.some((m: any) => m && m.type === 'ready'),
  );
  await page.evaluate((msg) => (window as any).__ic_send(msg), initMessage(spec) as any);
  for (const msg of thumbnailMessages(spec)) {
    await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
  }
  for (const msg of imageMessages(spec)) {
    await page.evaluate((m) => (window as any).__ic_send(m), msg as any);
  }
  await expect(page.locator('#viewer')).toHaveClass(/active/);
  // Let the canvas settle (image decode + first draw).
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  });
}

export async function getState(page: Page): Promise<IcState> {
  return page.evaluate(() => (window as any).__ic_test.getState());
}

export async function outbound(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__ic_outbound);
}

export async function lastOutbound(page: Page, type: string): Promise<any> {
  return page.evaluate((t) => (window as any).__ic_lastOutbound(t), type);
}

/** Focus the viewer so keyboard shortcuts reach the window handlers. */
export async function focusViewer(page: Page): Promise<void> {
  await page.locator('#viewer').click({ position: { x: 10, y: 10 } });
}
