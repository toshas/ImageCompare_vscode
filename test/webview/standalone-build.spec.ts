/**
 * Smoke spec for the standalone browser build (docs/standalone.md).
 *
 * beforeAll builds the real artifact (scripts/build-standalone.mjs), a throwaway
 * http server serves it (OPFS needs a secure context; 127.0.0.1 qualifies, file:// may not),
 * and the spec creates a real directory tree in OPFS in-page, then boots the adapter
 * through the window.__ic_standalone seam. The pinned literals below (tuple/modality
 * counts, tuple names, modality paths) are what the REAL scanForImages/matchTuplesWithTrie
 * pipeline produces from the fixture names — the fixtures deliberately have NO exact
 * basename matches across modalities (scene_01_gt.png vs scene_01_pred.png), so a naive
 * same-name reimplementation in the adapter would fail every one of these assertions.
 * The results.txt readback pins the shared serializer byte-for-byte end to end.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serializeResults } from '../../src/resultsFile';

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'dist', 'standalone', 'image_compare.html');

let server: http.Server;
let pageUrl: string;

test.beforeAll(async () => {
  execSync('node scripts/build-standalone.mjs', { cwd: ROOT, stdio: 'inherit' });
  const html = fs.readFileSync(ARTIFACT);
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image_compare.html`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('standalone landing shows the ported dropzone chrome', async ({ page }) => {
  await page.goto(pageUrl);

  // The full-frame drop target is up, carrying the class the dashed-frame styling hangs on.
  const drop = page.locator('#ic-drop');
  await expect(drop).toBeVisible();
  await expect(drop).toHaveClass(/ic-dropframe/);

  // The version badge sits at the BOTTOM of the drop zone (not in the title) and carries the injected package version.
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
  await expect(page.locator('#ic-landing h2 .ic-version')).toHaveCount(0);
  const badge = page.locator('.ic-dropframe .ic-version');
  await expect(badge).toContainText(`v${version}`);
  await expect(badge).toContainText('standalone build');

  // FSA browsers get exactly one entry button: the writable picker.
  await expect(page.locator('#ic-drop button#ic-open')).toBeVisible();
  // The read-only picker is the FALLBACK entry path: rendered only when FSA is absent, never beside it.
  await expect(page.locator('#ic-drop input#ic-open-ro')).toHaveCount(0);

  // The keyboard-hints block from the old design is present.
  await expect(page.locator('#ic-landing .ic-hints')).toContainText('Scroll: zoom');

  // Drag-over toggles the hover-state class the highlight styling hangs on.
  await drop.dispatchEvent('dragover', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await expect(drop).toHaveClass(/ic-over/);
  await drop.dispatchEvent('dragleave');
  await expect(drop).not.toHaveClass(/ic-over/);
});

test('standalone build boots the real webview and matches via the real scanForImages', async ({ page }) => {
  // The state hook must be armed BEFORE any page script runs (the bundle reads it once at load).
  await page.addInitScript(() => {
    (window as unknown as { __ic_test_enabled: boolean }).__ic_test_enabled = true;
  });
  await page.goto(pageUrl);

  // Landing chrome is up, showing the injected version.
  await expect(page.locator('#ic-landing')).toBeVisible();
  await expect(page.locator('#ic-landing .ic-version')).toContainText('standalone build');

  // Build a real directory tree in OPFS: 2 modality subdirs, 2 images each, distinct
  // dimensions per file, and basenames that only the fuzzy trie matcher can pair.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('fixtures', { recursive: true });
    } catch { /* fresh profile */ }
    const fix = await root.getDirectoryHandle('fixtures', { create: true });
    const makePng = async (w: number, h: number, color: string): Promise<Uint8Array> => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const write = async (dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    };
    const gt = await fix.getDirectoryHandle('gt', { create: true });
    const pred = await fix.getDirectoryHandle('pred', { create: true });
    await write(gt, 'scene_01_gt.png', await makePng(8, 6, '#f00'));
    await write(gt, 'scene_02_gt.png', await makePng(9, 7, '#0f0'));
    await write(pred, 'scene_01_pred.png', await makePng(5, 4, '#00f'));
    await write(pred, 'scene_02_pred.png', await makePng(6, 5, '#ff0'));
    await (window as unknown as { __ic_standalone: { open(h: FileSystemDirectoryHandle): Promise<void> } })
      .__ic_standalone.open(fix);
  });

  // The viewer becomes active and the state hook reports the scan.
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test?: { getState(): { tupleCount: number } } }).__ic_test;
    return !!t && t.getState().tupleCount > 0;
  });
  await expect(page.locator('#viewer')).toHaveClass(/active/);

  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  // Literals pinned from the real pipeline: 2 tuples paired across differing basenames,
  // named by findCommonSubstring ('scene_01_gt' ∩ 'scene_01_pred' → 'scene_01'), rows
  // natural-sorted, modality dirs natural-sorted (gt before pred) under the OPFS root.
  expect(state.tupleCount).toBe(2);
  expect(state.modalityCount).toBe(2);
  expect(state.currentTupleName).toBe('scene_01');
  expect(state.modalityPaths).toEqual(['/fixtures/gt', '/fixtures/pred']);
  expect(state.votingEnabled).toBe(true);

  // The first tuple's image really renders (the adapter answered requestImage with decodable bytes).
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  });

  // And every carousel tile really paints from binary: the adapter posts thumbnails as
  // {bytes, mime} (never a data url) and the webview blob-URLs them. The ✕ placeholder is a data
  // url that also decodes, so the blob: prefix is what separates a real tile from a fallback.
  await expect
    .poll(() =>
      page.$$eval('.carousel-row .carousel-thumb', imgs =>
        imgs.filter(
          i => (i as HTMLImageElement).naturalWidth > 0 && (i as HTMLImageElement).src.startsWith('blob:'),
        ).length,
      ),
    )
    .toBe(4);

  // Navigate to the second tuple and let its image land.
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test: { getState(): { currentTupleName: string | null } } }).__ic_test;
    return t.getState().currentTupleName === 'scene_02';
  });

  // Vote the current modality (Enter toggles the winner) on tuple 'scene_02'.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test: { getState(): { winners: Array<[number, number]> } } }).__ic_test;
    return t.getState().winners.length === 1;
  });

  // Read results.txt back OUT of OPFS: the adapter must have written it via the shared serializer.
  const actual = await expect
    .poll(async () =>
      page.evaluate(async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const fix = await root.getDirectoryHandle('fixtures');
          const fh = await fix.getFileHandle('results.txt');
          return await (await fh.getFile()).text();
        } catch {
          return null;
        }
      }),
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const fix = await root.getDirectoryHandle('fixtures');
        const fh = await fix.getFileHandle('results.txt');
        return await (await fh.getFile()).text();
      }),
    );

  // Byte-for-byte the output of the REAL serializeResults for this vote (timestamp taken
  // from the file itself — the only line the adapter cannot pin in advance).
  const iso = /^# Generated: (.+)$/m.exec(actual)?.[1];
  expect(iso).toBeTruthy();
  const expected = serializeResults(
    [{ name: 'scene_01' }, { name: 'scene_02' }],
    new Map([[1, 'gt']]),
    ['gt', 'pred'],
    new Date(iso!),
  );
  expect(actual).toBe(expected);
});

test('standalone landing falls back to the read-only picker without FSA', async ({ page }) => {
  // Simulate Firefox/Safari: no File System Access API before the page boots.
  await page.addInitScript(() => { delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
  await page.goto(pageUrl);

  const ro = page.locator('.ic-dropframe input#ic-open-ro[webkitdirectory]');
  await expect(ro).toHaveCount(1);
  await expect(page.locator('.ic-dropframe label.ic-file-btn')).toBeVisible();
  await expect(page.locator('.ic-dropframe label.ic-file-btn')).toHaveClass(/ic-btn-primary/);
  // No writable picker — but the drop frame IS wired (read-only entry walker), and the no-FSA notice is up.
  await expect(page.locator('button#ic-open')).toHaveCount(0);
  await expect(page.locator('#ic-drop')).toHaveCount(1);
  await expect(page.locator('#ic-drop h2')).toContainText('Drop or Open');
  await expect(page.locator('#ic-warn')).toBeVisible();
});

test('standalone no-FSA drop path walks webkit entries into the read-only backend', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ic_test_enabled: boolean }).__ic_test_enabled = true;
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await page.goto(pageUrl);

  // A synthetic DataTransfer cannot carry webkitGetAsEntry entries in headless Chromium, so the
  // walker is driven through the adapter's openDroppedEntry seam with a faithful fake entry tree
  // (batched createReader/readEntries semantics included). Same code path as the drop handler.
  await page.evaluate(async () => {
    const makePng = async (w: number, h: number, color: string): Promise<Uint8Array> => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const fileEntry = (fullPath: string, file: File) => ({
      isFile: true,
      isDirectory: false,
      fullPath,
      name: file.name,
      file: (ok: (f: File) => void) => ok(file),
    });
    const dirEntry = (fullPath: string, children: unknown[]) => ({
      isFile: false,
      isDirectory: true,
      fullPath,
      name: fullPath.split('/').pop(),
      createReader: () => {
        // Real readers return entries in batches and then one empty batch — mimic that.
        let served = false;
        return {
          readEntries: (ok: (entries: unknown[]) => void) => {
            const batch = served ? [] : children;
            served = true;
            ok(batch);
          },
        };
      },
    });
    const png = (name: string, bytes: Uint8Array) => new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'image/png' });
    const root = dirEntry('/dropped', [
      dirEntry('/dropped/gt', [
        fileEntry('/dropped/gt/scene_01_gt.png', png('scene_01_gt.png', await makePng(8, 6, '#f00'))),
        fileEntry('/dropped/gt/scene_02_gt.png', png('scene_02_gt.png', await makePng(9, 7, '#0f0'))),
      ]),
      dirEntry('/dropped/pred', [
        fileEntry('/dropped/pred/scene_01_pred.png', png('scene_01_pred.png', await makePng(5, 4, '#00f'))),
        fileEntry('/dropped/pred/scene_02_pred.png', png('scene_02_pred.png', await makePng(6, 5, '#ff0'))),
      ]),
    ]);
    await (window as unknown as { __ic_standalone: { openDroppedEntry(e: unknown): Promise<void> } })
      .__ic_standalone.openDroppedEntry(root);
  });

  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test?: { getState(): { tupleCount: number } } }).__ic_test;
    return !!t && t.getState().tupleCount > 0;
  });
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  // Same literals the FSA path pins: the walker feeds the SAME matcher through the FileList backend.
  expect(state.tupleCount).toBe(2);
  expect(state.modalityCount).toBe(2);
  expect(state.currentTupleName).toBe('scene_01');
  expect(state.modalityPaths).toEqual(['/dropped/gt', '/dropped/pred']);
  // webkitGetAsEntry drops are read-only: no directory handle, so nothing can be written.
  expect(state.votingEnabled).toBe(false);

  // The dropped images actually decode and render.
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  });
});

// ---- External-change detection (the standalone poll) ----

/** Boot the standalone page on a fresh OPFS tree with a short injected poll interval; returns nothing — state lives in the page. */
async function bootPolledFixture(page: import('@playwright/test').Page, dirName: string, intervalMs = 150): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __ic_test_enabled: boolean }).__ic_test_enabled = true;
    // Record every extension→webview post so specs can assert granular traffic (never a re-init).
    const log: string[] = [];
    (window as unknown as { __ic_msgs: string[] }).__ic_msgs = log;
    window.addEventListener('message', e => {
      const d = (e as MessageEvent).data as { type?: string; tuple?: { name?: string }; tupleIndex?: number; modalityIndex?: number };
      if (!d || !d.type) return;
      if (d.type === 'tupleAdded') log.push(`tupleAdded:${d.tuple?.name}`);
      else if (d.type === 'image' || d.type === 'thumbnail' || d.type === 'fileDeleted' || d.type === 'tupleDeleted' || d.type === 'fileRestored') {
        log.push(`${d.type}:${d.tupleIndex}-${d.modalityIndex ?? ''}`);
      } else log.push(d.type);
    });
  });
  await page.goto(pageUrl);
  await page.evaluate(async ({ dir, interval }) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(dir, { recursive: true });
    } catch { /* fresh profile */ }
    const fix = await root.getDirectoryHandle(dir, { create: true });
    const makePng = async (w: number, h: number, color: string): Promise<Uint8Array> => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const write = async (d: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => {
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    };
    const gt = await fix.getDirectoryHandle('gt', { create: true });
    const pred = await fix.getDirectoryHandle('pred', { create: true });
    await write(gt, 'scene_01_gt.png', await makePng(8, 6, '#f00'));
    await write(gt, 'scene_02_gt.png', await makePng(9, 7, '#0f0'));
    await write(pred, 'scene_01_pred.png', await makePng(5, 4, '#00f'));
    await write(pred, 'scene_02_pred.png', await makePng(6, 5, '#ff0'));
    const seam = (window as unknown as { __ic_standalone: { pollIntervalMs: number; open(h: FileSystemDirectoryHandle): Promise<void> } }).__ic_standalone;
    // Injected test interval — the seam the poll loop reads when it arms its timer.
    seam.pollIntervalMs = interval;
    await seam.open(fix);
  }, { dir: dirName, interval: intervalMs });
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test?: { getState(): { tupleCount: number } } }).__ic_test;
    return !!t && t.getState().tupleCount === 2;
  });
}

/** Write a canvas-rendered PNG into `<dir>/<sub>/<name>` in OPFS. */
async function writeOpfsPng(page: import('@playwright/test').Page, dir: string, sub: string, name: string, w: number, h: number, color: string): Promise<void> {
  await page.evaluate(async (a) => {
    const root = await navigator.storage.getDirectory();
    const fix = await root.getDirectoryHandle(a.dir);
    const d = await fix.getDirectoryHandle(a.sub, { create: true });
    const c = document.createElement('canvas');
    c.width = a.w;
    c.height = a.h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = a.color;
    ctx.fillRect(0, 0, a.w, a.h);
    const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
    const fh = await d.getFileHandle(a.name, { create: true });
    const wr = await fh.createWritable();
    await wr.write(await blob.arrayBuffer());
    await wr.close();
  }, { dir, sub, name, w, h, color });
}

test('standalone poll detects an external new file as a granular tupleAdded with view state intact', async ({ page }) => {
  await bootPolledFixture(page, 'pollfix');

  // Zoom in so the poll's granular update can be proven not to reset the view.
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0;
  });
  const canvas = page.locator('#canvas');
  await canvas.hover();
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test;
    return t.getState().zoom > 1;
  });
  const zoomBefore = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test.getState().zoom,
  );

  // An external writer (e.g. a training run) adds a new file into a modality dir after boot.
  await writeOpfsPng(page, 'pollfix', 'gt', 'scene_03_gt.png', 7, 5, '#0ff');

  // The poll must deliver it as a granular tupleAdded — never a re-init.
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_test: { getState(): { tupleCount: number } } }).__ic_test.getState().tupleCount,
    ), { timeout: 15000 })
    .toBe(3);
  const msgs = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  expect(msgs).toContain('tupleAdded:scene_03_gt');
  expect(msgs.filter(m => m === 'init')).toHaveLength(1);

  // View state survived: same tuple under the cursor, zoom untouched.
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.currentTupleName).toBe('scene_01');
  expect(state.zoom).toBe(zoomBefore);
});

test('standalone poll delivers external deletes, content changes and results.txt edits', async ({ page }) => {
  await bootPolledFixture(page, 'pollfix2');

  // 1) External results.txt edit → winnersReset with the parsed winners.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fix = await root.getDirectoryHandle('pollfix2');
    const fh = await fix.getFileHandle('results.txt', { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode('scene_02 = pred\n'));
    await w.close();
  });
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_test: { getState(): { winners: Array<[number, number]> } } }).__ic_test.getState().winners,
    ), { timeout: 15000 })
    .toEqual([[1, 1]]);
  const msgsAfterResults = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  expect(msgsAfterResults).toContain('winnersReset');

  // 2) External delete of both of scene_01's files → the tuple leaves and the winner re-keys.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fix = await root.getDirectoryHandle('pollfix2');
    await (await fix.getDirectoryHandle('gt')).removeEntry('scene_01_gt.png');
    await (await fix.getDirectoryHandle('pred')).removeEntry('scene_01_pred.png');
  });
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_test: { getState(): { tupleCount: number } } }).__ic_test.getState().tupleCount,
    ), { timeout: 15000 })
    .toBe(1);
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.currentTupleName).toBe('scene_02');
  expect(state.winners).toEqual([[0, 1]]);
  const msgsAfterDelete = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  expect(msgsAfterDelete.some(m => m.startsWith('tupleDeleted:'))).toBe(true);

  // 3) External content change of the (now current) tuple's gt file → the slot is re-served.
  const imagePosts = (list: string[]) => list.filter(m => m.startsWith('image:0-0')).length;
  const before = imagePosts(msgsAfterDelete);
  await writeOpfsPng(page, 'pollfix2', 'gt', 'scene_02_gt.png', 12, 9, '#fff');
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_msgs: string[] }).__ic_msgs,
    ).then(imagePosts), { timeout: 15000 })
    .toBeGreaterThan(before);
});

test('standalone re-open cancels the previous root: no stale poll posts after the switch', async ({ page }) => {
  await bootPolledFixture(page, 'pollfixA');

  // Open a second root through the same seam — the flagged two-root case.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('pollfixB', { recursive: true });
    } catch { /* fresh */ }
    const fix = await root.getDirectoryHandle('pollfixB', { create: true });
    const makePng = async (w: number, h: number, color: string): Promise<Uint8Array> => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const write = async (d: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => {
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    };
    const m1 = await fix.getDirectoryHandle('m1', { create: true });
    const m2 = await fix.getDirectoryHandle('m2', { create: true });
    await write(m1, 'item_01_m1.png', await makePng(4, 3, '#123'));
    await write(m2, 'item_01_m2.png', await makePng(4, 3, '#321'));
    await (window as unknown as { __ic_standalone: { open(h: FileSystemDirectoryHandle): Promise<void> } })
      .__ic_standalone.open(fix);
  });
  // Root B has exactly one tuple, root A had two — the count switching is the boot signal.
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test?: { getState(): { tupleCount: number } } }).__ic_test;
    return !!t && t.getState().tupleCount === 1;
  });
  const nameB = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): { currentTupleName: string | null } } }).__ic_test.getState().currentTupleName,
  );
  expect(nameB).not.toBeNull();

  // Draw a line after the switch, then stir the OLD root: nothing from it may land.
  await page.evaluate(() => { (window as unknown as { __ic_msgs: string[] }).__ic_msgs.length = 0; });
  await writeOpfsPng(page, 'pollfixA', 'gt', 'scene_09_gt.png', 6, 6, '#909');
  // Wait out several poll intervals so a stale loop would have fired.
  await page.waitForTimeout(1200);
  const msgs = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  expect(msgs.filter(m => m.startsWith('tupleAdded:'))).toEqual([]);
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.tupleCount).toBe(1);
  expect(state.currentTupleName).toBe(nameB);
});

test('standalone poll adopts a modality directory copied in after boot', async ({ page }) => {
  await bootPolledFixture(page, 'adoptfix');

  // Zoom in so the adoption can be proven to leave view state intact.
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0;
  });
  await page.locator('#canvas').hover();
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test;
    return t.getState().zoom > 1;
  });
  const zoomBefore = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test.getState().zoom,
  );

  // A user copies a whole modality directory in beside gt and pred after boot.
  await writeOpfsPng(page, 'adoptfix', 'mask', 'scene_01_mask.png', 6, 4, '#909');
  await writeOpfsPng(page, 'adoptfix', 'mask', 'scene_02_mask.png', 7, 5, '#099');

  // The poll must adopt it as a new column — never a re-init.
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_test: { getState(): { modalityCount: number } } }).__ic_test.getState().modalityCount,
    ), { timeout: 15000 })
    .toBe(3);
  const msgs = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  expect(msgs).toContain('modalityAdded');
  expect(msgs.filter(m => m === 'init')).toHaveLength(1);

  // 'mask' lands between gt and pred — the real modalityInsertIndex position, not an append.
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.modalityPaths).toEqual(['/adoptfix/gt', '/adoptfix/mask', '/adoptfix/pred']);
  expect(state.tupleCount).toBe(2);
  await expect(page.locator('#modality-selector .modality-btn')).toHaveCount(3);

  // Each existing tuple's free slot was filled granularly, and its thumbnail delivered.
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs), { timeout: 15000 })
    .toEqual(expect.arrayContaining(['fileRestored:0-1', 'fileRestored:1-1', 'thumbnail:0-1', 'thumbnail:1-1']));

  // View state survived the adoption.
  expect(state.currentTupleName).toBe('scene_01');
  expect(state.zoom).toBe(zoomBefore);
});

test('standalone poll executes a modality dir rename as remove-then-adopt with view state preserved', async ({ page }) => {
  await bootPolledFixture(page, 'renamefix');

  await page.waitForFunction(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0;
  });
  await page.locator('#canvas').hover();
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test;
    return t.getState().zoom > 1;
  });
  const zoomBefore = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): { zoom: number } } }).__ic_test.getState().zoom,
  );

  // A rename on disk is delete + create of the directory; delete-first keeps the wire order deterministic.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fix = await root.getDirectoryHandle('renamefix');
    await fix.removeEntry('pred', { recursive: true });
    const renamed = await fix.getDirectoryHandle('aaa_pred', { create: true });
    const makePng = async (w: number, h: number, color: string): Promise<Uint8Array> => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const write = async (d: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => {
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes.slice().buffer as ArrayBuffer);
      await w.close();
    };
    await write(renamed, 'scene_01_pred.png', await makePng(5, 4, '#00f'));
    await write(renamed, 'scene_02_pred.png', await makePng(6, 5, '#ff0'));
  });

  // The pill reappears under the new name at its sorted position (aaa_pred sorts before gt).
  await expect
    .poll(async () => page.evaluate(
      () => (window as unknown as { __ic_test: { getState(): { modalityPaths: string[] } } }).__ic_test.getState().modalityPaths,
    ), { timeout: 15000 })
    .toEqual(['/renamefix/aaa_pred', '/renamefix/gt']);

  const msgs = await page.evaluate(() => (window as unknown as { __ic_msgs: string[] }).__ic_msgs);
  // Old column removed, new one adopted — remove-then-adopt, never a re-init.
  expect(msgs).toContain('modalityRemoved');
  expect(msgs).toContain('modalityAdded');
  expect(msgs.indexOf('modalityRemoved')).toBeLessThan(msgs.indexOf('modalityAdded'));
  expect(msgs.filter(m => m === 'init')).toHaveLength(1);

  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.modalityCount).toBe(2);
  expect(state.tupleCount).toBe(2);
  await expect(page.locator('#modality-selector .modality-btn').filter({ hasText: 'aaa_pred' })).toHaveCount(1);

  // View state survived the rename.
  expect(state.currentTupleName).toBe('scene_01');
  expect(state.zoom).toBe(zoomBefore);
});

test('standalone re-open picks up a modality dir added while the comparison was open', async ({ page }) => {
  // A long interval keeps the poll out of the picture: this pins the fresh-scan path alone.
  await bootPolledFixture(page, 'reopenfix', 60000);

  await writeOpfsPng(page, 'reopenfix', 'mask', 'scene_01_mask.png', 6, 4, '#909');
  await writeOpfsPng(page, 'reopenfix', 'mask', 'scene_02_mask.png', 7, 5, '#099');

  // Second open of the same root re-scans from scratch and shows the new modality.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fix = await root.getDirectoryHandle('reopenfix');
    await (window as unknown as { __ic_standalone: { open(h: FileSystemDirectoryHandle): Promise<void> } })
      .__ic_standalone.open(fix);
  });
  await page.waitForFunction(() => {
    const t = (window as unknown as { __ic_test?: { getState(): { modalityCount: number } } }).__ic_test;
    return !!t && t.getState().modalityCount === 3;
  });
  const state = await page.evaluate(
    () => (window as unknown as { __ic_test: { getState(): Record<string, unknown> } }).__ic_test.getState(),
  );
  expect(state.modalityPaths).toEqual(['/reopenfix/gt', '/reopenfix/mask', '/reopenfix/pred']);
  expect(state.tupleCount).toBe(2);
});
