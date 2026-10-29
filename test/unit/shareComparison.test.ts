/**
 * The sharing script's decisions and sequence (docs/standalone.md, "The sharing script";
 * invariants pack-refuses-never-alters and host-regime-is-one-table). Imports the REAL
 * standalone/sharePlan.ts and drives it with the REAL node IO the script uses
 * (standalone/shareNodeIo.ts: node fs + sharp) on temp fixtures built from test/fixtures/images.
 * scripts/share-comparison.mjs itself is argument parsing and printing over these two modules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  ShareRefusal,
  limitViolations,
  planBatches,
  planLayout,
  setPageTitle,
  shareComparison,
  StagedFile,
  unopenablePaths,
} from '../../standalone/sharePlan';
import { nodeBase64, nodeShareIo } from '../../standalone/shareNodeIo';
import { parsePackedThumbs, decodePackedThumb } from '../../standalone/packedThumbs';
import { HOST_REGIMES } from '../../standalone/hostRegimes';
import { makeSolidPng } from '../fixtures/synthetic';

// Every input sharp is handed in this file, by a pass-through wrapper over the real sharp: what libvips
// can do with a path on Windows (keep the file locked) cannot be seen on a POSIX runner, so the test
// below judges the call at the seam instead, as docs/testing.md's Windows findings do for node:fs.
const sharpInputs = vi.hoisted(() => [] as unknown[]);
vi.mock('sharp', async importOriginal => {
  const real = (await importOriginal<{ default: (...args: unknown[]) => unknown }>()).default;
  return { default: Object.assign((...args: unknown[]) => { sharpInputs.push(args[0]); return real(...args); }, real) };
});

// Runtime-computed, as in publishedComparison.test.ts: fsBackends compiles under the standalone tsconfig.
const backendsModule = '../../standalone/fsBackends';
const { parsePublishedManifest } = await import(backendsModule) as { parsePublishedManifest(text: string): { files: string[] } };

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'images');
const PAGE = '<!DOCTYPE html>\n<html><head><title>ImageCompare 0.5.0</title></head><body>page</body></html>';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-share-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function put(rel: string, bytes: Buffer | string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}
const photo = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

/** A mode-1 folder: two image columns, plus the things a comparison folder also holds and must not ship. */
function columnsFolder(): string {
  put('cmp/gt/airplane.jpg', photo('airplane.jpg'));
  put('cmp/gt/baboon.jpg', photo('baboon.jpg'));
  put('cmp/pred/airplane.jpg', photo('peppers.jpg'));
  put('cmp/pred/baboon.jpg', photo('sailboat.jpg'));
  put('cmp/pred/tiny.png', makeSolidPng(50, 30, [255, 0, 0]));
  put('cmp/results.txt', '# ImageCompare Results\nairplane = gt\n');
  put('cmp/loose.jpg', photo('airplane.jpg'));
  put('cmp/gt/notes.txt', 'not an image');
  return path.join(tmp, 'cmp');
}

const share = (input: string, out: string, host: 'claude-artifact' | 'static' = 'claude-artifact', title?: string) =>
  shareComparison({ input, out, host, title, pageHtml: PAGE, base64: nodeBase64 }, nodeShareIo);

async function refusal(run: Promise<unknown>): Promise<string[]> {
  const err = await run.then(() => null, e => e);
  expect(err).toBeInstanceOf(ShareRefusal);
  return (err as ShareRefusal).violations;
}

describe('share: layout as the extension reads the input', () => {
  it('lays a folder of image columns out as it is, ignoring loose files, non-images and results.txt', async () => {
    const layout = await planLayout(columnsFolder(), nodeShareIo);
    expect(layout.name).toBe('cmp');
    expect(layout.images.map(i => i.path)).toEqual([
      'gt/airplane.jpg', 'gt/baboon.jpg', 'pred/airplane.jpg', 'pred/baboon.jpg', 'pred/tiny.png',
    ]);
  });

  it('lays a folder of loose images out flat', async () => {
    put('flat/a_gt.jpg', photo('airplane.jpg'));
    put('flat/a_pred.jpg', photo('baboon.jpg'));
    put('flat/readme.txt', 'x');
    const layout = await planLayout(path.join(tmp, 'flat'), nodeShareIo);
    expect(layout.images.map(i => i.path)).toEqual(['a_gt.jpg', 'a_pred.jpg']);
  });

  // The page opens a staged folder with the extension's own scan, which refuses both of these;
  // staged, they would publish a page that cannot open, or opens as a different comparison.
  it('refuses a folder whose only image is one loose file, which the page would not open', async () => {
    const only = put('lone/a.jpg', photo('airplane.jpg'));
    put('lone/readme.txt', 'x');
    expect(await refusal(planLayout(path.join(tmp, 'lone'), nodeShareIo))).toEqual([
      `${only} is the only image in ${path.join(tmp, 'lone')}; a comparison needs at least 2`,
    ]);
  });

  it('refuses a multi-directory session with fewer than two image directories, as the extension does', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/notes.md', 'x');
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'] }));
    expect(await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo))).toEqual([
      `Only 1 of the session's directories holds images, and a comparison of directories needs at least 2; without images: ${path.join(tmp, 'runs/y')}`,
    ]);
  });

  it('resolves a one-directory session as that folder, named after the session', async () => {
    columnsFolder();
    put('one.imagecompare', JSON.stringify({ paths: ['cmp'] }));
    const layout = await planLayout(path.join(tmp, 'one.imagecompare'), nodeShareIo);
    expect(layout.name).toBe('one');
    expect(layout.images.map(i => i.path)).toEqual(['gt/airplane.jpg', 'gt/baboon.jpg', 'pred/airplane.jpg', 'pred/baboon.jpg', 'pred/tiny.png']);
  });

  it('makes each directory of a multi-directory session a column named by its label', async () => {
    put('runs/x/out/s1.jpg', photo('airplane.jpg'));
    put('runs/y/out/s1.jpg', photo('baboon.jpg'));
    put('runs/y/out/notes.md', 'x');
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x/out', 'runs/y/out', 'runs/missing'], labels: ['Model X', 'Model Y', 'Gone'] }));
    const layout = await planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo);
    expect(layout.images).toEqual([
      { source: path.join(tmp, 'runs/x/out/s1.jpg'), path: 'Model X/s1.jpg' },
      { source: path.join(tmp, 'runs/y/out/s1.jpg'), path: 'Model Y/s1.jpg' },
    ]);
  });

  it('names unlabelled session directories as the extension derives them, shortest unique tail', async () => {
    put('runs/x/model_a/s1.jpg', photo('airplane.jpg'));
    put('runs/x/model_b/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x/model_a', 'runs/x/model_b'] }));
    const layout = await planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo);
    expect(layout.images.map(i => i.path)).toEqual(['model_a/s1.jpg', 'model_b/s1.jpg']);
  });

  // A derived name that is not one path segment is made one with the lookalike table (docs/standalone.md, "The sharing script").
  it('stages colliding-tail directories under their derived names, the slash made a lookalike', async () => {
    put('a/pred/s1.jpg', photo('airplane.jpg'));
    put('b/pred/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['a/pred', 'b/pred'] }));
    const layout = await planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo);
    expect(layout.images.map(i => i.path)).toEqual(['a\u2215pred/s1.jpg', 'b\u2215pred/s1.jpg']);
  });

  it('lays a file-list session out flat, images only', async () => {
    const a = put('x/one.jpg', photo('airplane.jpg'));
    const b = put('y/two.png', makeSolidPng(4, 4, [0, 0, 255]));
    const c = put('y/notes.txt', 'x');
    put('s.imagecompare', JSON.stringify({ paths: [a, b, c] }));
    const layout = await planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo);
    expect(layout.images).toEqual([{ source: a, path: 'one.jpg' }, { source: b, path: 'two.png' }]);
  });

  it('refuses a file-list session whose files share a name, which a flat layout cannot hold', async () => {
    const a = put('x/s1.jpg', photo('airplane.jpg'));
    const b = put('y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: [a, b] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('s1.jpg');
    expect(v[0]).toContain(a);
    expect(v[0]).toContain(b);
  });

  // docs/session-files.md: folder-of-images-is-a-file-list — staged flat, the list is read back as a
  // folder of loose images, whose enumeration sets `_cropNN` writes aside.
  it('refuses a file-list session the page would read back without its _cropNN files', async () => {
    const a = put('x/scene.png', makeSolidPng(4, 4, [255, 0, 0]));
    const b = put('y/scene_crop01.png', makeSolidPng(2, 2, [255, 0, 0]));
    const c = put('y/other.png', makeSolidPng(4, 4, [0, 0, 255]));
    put('s.imagecompare', JSON.stringify({ paths: [a, b, c] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v).toEqual([`The page reads a flat file list as a folder of loose images and would set aside 1 of them: ${b}`]);
  });

  it('keeps a file list of crops only, which the page reads back whole', async () => {
    const a = put('x/a_crop01.png', makeSolidPng(4, 4, [255, 0, 0]));
    const b = put('y/b_crop02.png', makeSolidPng(4, 4, [0, 0, 255]));
    put('s.imagecompare', JSON.stringify({ paths: [a, b] }));
    expect((await planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo)).images.map(i => i.path)).toEqual(['a_crop01.png', 'b_crop02.png']);
  });

  it('refuses a session mixing files and directories, as the extension does', async () => {
    const a = put('x/s1.jpg', photo('airplane.jpg'));
    put('d/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: [a, 'd'] }));
    expect(await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo))).toEqual(['Cannot mix files and directories in one session']);
  });
});

describe('share: staging', () => {
  it('stages the page, manifest, thumbs, plan and every image byte for byte', async () => {
    const input = columnsFolder();
    const out = path.join(tmp, 'out');
    const summary = await share(input, out, 'claude-artifact', 'My <comparison>');

    const layoutPaths = ['gt/airplane.jpg', 'gt/baboon.jpg', 'pred/airplane.jpg', 'pred/baboon.jpg', 'pred/tiny.png'];
    for (const rel of layoutPaths) {
      expect(fs.readFileSync(path.join(out, rel)).equals(fs.readFileSync(path.join(input, rel)))).toBe(true);
    }
    expect(fs.existsSync(path.join(out, 'results.txt'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'loose.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'gt', 'notes.txt'))).toBe(false);

    const page = fs.readFileSync(path.join(out, 'image_compare.html'), 'utf8');
    expect(page).toBe(PAGE.replace('<title>ImageCompare 0.5.0</title>', '<title>My &lt;comparison&gt;</title>'));

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'imagecompare.json'), 'utf8'));
    expect(manifest).toEqual({ files: layoutPaths, host: 'claude-artifact', thumbs: ['imagecompare.thumbs.0.json'] });

    const plan = JSON.parse(fs.readFileSync(path.join(out, 'publish-plan.json'), 'utf8'));
    expect(plan.host).toBe('claude-artifact');
    expect(plan.page).toBe('image_compare.html');
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].files.map((f: { path: string }) => f.path))
      .toEqual(['image_compare.html', 'imagecompare.json', 'imagecompare.thumbs.0.json', ...layoutPaths]);
    for (const f of plan.batches[0].files) expect(f.bytes).toBe(fs.statSync(path.join(out, f.path)).size);

    expect(summary).toMatchObject({ name: 'cmp', host: 'claude-artifact', images: 5, thumbsFiles: 1, thumbless: [], batches: 1 });
    expect(fs.readdirSync(out).sort()).toEqual(['gt', 'image_compare.html', 'imagecompare.json', 'imagecompare.thumbs.0.json', 'pred', 'publish-plan.json']);
  });

  it('packs one thumbnail per listed image: longest side 200, never enlarged, PNG for PNG and JPEG otherwise', async () => {
    const out = path.join(tmp, 'out');
    await share(columnsFolder(), out);
    const thumbs = parsePackedThumbs(fs.readFileSync(path.join(out, 'imagecompare.thumbs.0.json'), 'utf8'));
    expect([...thumbs.keys()].sort()).toEqual(['gt/airplane.jpg', 'gt/baboon.jpg', 'pred/airplane.jpg', 'pred/baboon.jpg', 'pred/tiny.png']);
    const meta = async (key: string) => sharp(Buffer.from(decodePackedThumb(thumbs.get(key)!)!)).metadata();
    // The 480x461 photo comes down to 200 on the longest side (twice the strip's 100 px thumbnailSize),
    // aspect kept: fit inside, not cover or fill.
    const big = await meta('gt/baboon.jpg');
    expect([big.format, big.width, big.height]).toEqual(['jpeg', 200, 192]);
    expect(thumbs.get('gt/baboon.jpg')!.mime).toBe('image/jpeg');
    const tiny = await meta('pred/tiny.png');
    expect([tiny.format, tiny.width, tiny.height]).toEqual(['png', 50, 30]);
    expect(thumbs.get('pred/tiny.png')!.mime).toBe('image/png');
  });

  it('hands sharp the image bytes, never its path, so the source is free the moment its thumbnail exists', async () => {
    const source = put('one/a.jpg', photo('airplane.jpg'));
    sharpInputs.length = 0;
    expect(await nodeShareIo.thumbnail(source, 200, 'image/jpeg', 80)).not.toBeNull();
    expect(sharpInputs.length).toBeGreaterThan(0);
    for (const input of sharpInputs) expect(typeof input).not.toBe('string');
    // The Windows symptom itself, which only the windows-latest leg can see: the source deletes at once.
    fs.rmSync(source);
    expect(fs.existsSync(source)).toBe(false);
  });

  it('defaults the page title to the folder name, and stages for a static host with its host named', async () => {
    const out = path.join(tmp, 'out');
    await share(columnsFolder(), out, 'static');
    expect(fs.readFileSync(path.join(out, 'image_compare.html'), 'utf8')).toContain('<title>cmp</title>');
    expect(JSON.parse(fs.readFileSync(path.join(out, 'imagecompare.json'), 'utf8')).host).toBe('static');
  });

  it('stages into an existing empty --out', async () => {
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    await share(columnsFolder(), out);
    expect(fs.existsSync(path.join(out, 'imagecompare.json'))).toBe(true);
  });
});

describe('share: names made safe with lookalikes, the page\'s own rule deciding', () => {
  it('stages a label with a colon under its lookalike, and the staged manifest opens in the page', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'], labels: ['Model: A', 'v2:full'] }));
    const out = path.join(tmp, 'out');
    await share(path.join(tmp, 's.imagecompare'), out);
    const text = fs.readFileSync(path.join(out, 'imagecompare.json'), 'utf8');
    // The page's own parser, the one the published page runs on this very file.
    expect(parsePublishedManifest(text).files).toEqual(['Model\uA789 A/s1.jpg', 'v2\uA789full/s1.jpg']);
    expect(fs.readFileSync(path.join(out, 'Model\uA789 A', 's1.jpg')).equals(photo('airplane.jpg'))).toBe(true);
  });

  // A Windows file name cannot hold any of these characters (NTFS even reads the colon as a stream
  // separator and creates `a`), so there is no such name to map there; the label tests still stage
  // lookalikes on every OS.
  it.skipIf(process.platform === 'win32')('maps every unsafe character of a file name through the one table', async () => {
    put('cmp/gt/a:b*c?d"e<f>g|h.jpg', photo('airplane.jpg'));
    put('cmp/pred/a:b*c?d"e<f>g|h.jpg', photo('baboon.jpg'));
    const layout = await planLayout(path.join(tmp, 'cmp'), nodeShareIo);
    const safe = 'a\uA789b\u2217c\uFF1Fd\uFF02e\u2039f\u203Ag\u2223h.jpg';
    expect(layout.images.map(i => i.path)).toEqual([`gt/${safe}`, `pred/${safe}`]);
  });

  it('refuses a label no lookalike can make safe, naming it, and stages nothing', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'], labels: ['Model A.', 'base'] }));
    const out = path.join(tmp, 'out');
    const v = await refusal(share(path.join(tmp, 's.imagecompare'), out));
    expect(v).toEqual([`${path.join(tmp, 'runs/x/s1.jpg')}: the column name "Model A." cannot be made a safe folder name; change the session label "Model A."`]);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a label holding a control character, which no lookalike replaces', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'], labels: ['a\u0007b', 'base'] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v).toEqual([`${path.join(tmp, 'runs/x/s1.jpg')}: the column name "a\\u0007b" cannot be made a safe folder name; change the session label "a\\u0007b"`]);
  });

  it('refuses two columns that would share a folder once made safe', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'], labels: ['a:b', 'a\uA789b'] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v[0]).toBe('Columns "a:b" and "a\uA789b" would share the folder "a\uA789b"; change a session label');
  });

  // macOS and Windows hold `Pred` and `pred` as one folder or file, and macOS also the NFC and NFD
  // spellings of one name: staged there, the second source would silently merge into or overwrite
  // the first.
  it('refuses two columns whose folders differ only in case', async () => {
    put('runs/x/s1.jpg', photo('airplane.jpg'));
    put('runs/y/s1.jpg', photo('baboon.jpg'));
    put('s.imagecompare', JSON.stringify({ paths: ['runs/x', 'runs/y'], labels: ['Pred', 'pred'] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v).toEqual(['Columns "Pred" and "pred" would share the folder "pred"; change a session label']);
  });

  it('refuses two files whose staged paths differ only in case or Unicode normalization', async () => {
    const a = put('x/Scene.png', makeSolidPng(4, 4, [255, 0, 0]));
    const b = put('y/scene.png', makeSolidPng(4, 4, [0, 0, 255]));
    const c = put('x/caf\u00e9.png', makeSolidPng(4, 4, [0, 255, 0]));
    const d = put('y/cafe\u0301.png', makeSolidPng(4, 4, [9, 9, 9]));
    put('s.imagecompare', JSON.stringify({ paths: [a, b, c, d] }));
    const v = await refusal(planLayout(path.join(tmp, 's.imagecompare'), nodeShareIo));
    expect(v).toEqual([
      `2 files would be staged at the same path Scene.png: ${a}, ${b}`,
      `2 files would be staged at the same path caf\u00e9.png: ${c}, ${d}`,
    ]);
  });

  it('names every staged path the page\'s listing rule refuses', () => {
    expect(unopenablePaths([
      { source: '/s/gt/a.png', path: 'gt/a.png' },
      { source: '/s/v2/a.png', path: 'v2:full/a.png' },
      { source: '/s/x/a.png', path: 'x\\a.png' },
    ])).toEqual([
      '/s/v2/a.png would be listed as "v2:full/a.png", which the page refuses to open',
      '/s/x/a.png would be listed as "x\\\\a.png", which the page refuses to open',
    ]);
  });
});

describe('share: refuses, never alters (docs/standalone.md: pack-refuses-never-alters)', () => {
  it('refuses before building any thumbnail', async () => {
    const input = columnsFolder();
    put('cmp/pred/depth.tif', 'II*');
    let thumbnails = 0;
    const counting = { ...nodeShareIo, thumbnail: async (...args: Parameters<typeof nodeShareIo.thumbnail>) => { thumbnails++; return nodeShareIo.thumbnail(...args); } };
    const err = await shareComparison({ input, out: path.join(tmp, 'out'), host: 'claude-artifact', pageHtml: PAGE, base64: nodeBase64 }, counting).then(() => null, e => e);
    expect(err).toBeInstanceOf(ShareRefusal);
    expect(thumbnails).toBe(0);
  });

  it('counts the thumbs files it builds: a comparison they push over the file limit is refused', async () => {
    const png = makeSolidPng(2, 2, [1, 2, 3]);
    // 509 images + page + manifest is exactly the 511-file limit; the thumbs file makes it 512.
    for (let i = 0; i < 509; i++) put(`many/c/${String(i).padStart(3, '0')}.png`, png);
    const out = path.join(tmp, 'out');
    const v = await refusal(share(path.join(tmp, 'many'), out));
    expect(v).toEqual(['512 files (3 page/manifest/thumbs + 509 images) exceed the 511-file limit per published version']);
    expect(fs.existsSync(out)).toBe(false);
  }, 30_000);

  it('refuses types the host does not serve, naming every file, and stages nothing', async () => {
    const input = columnsFolder();
    put('cmp/pred/depth.tif', await sharp(photo('airplane.jpg')).tiff().toBuffer());
    put('cmp/gt/old.bmp', 'BM not really');
    put('cmp/gt/depth.ppmx', 'PPMX');
    const out = path.join(tmp, 'out');
    const v = await refusal(share(input, out));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^3 image\(s\) of a type this host does not serve \(it serves \.png \.jpg \.jpeg \.gif \.webp\): /);
    for (const f of ['gt/depth.ppmx', 'gt/old.bmp', 'pred/depth.tif']) expect(v[0]).toContain(f);
    expect(fs.existsSync(out)).toBe(false);
    // The same comparison is fine where the host imposes no type list: nothing was converted to make it so.
    await share(input, out, 'static');
    expect(fs.readFileSync(path.join(out, 'pred/depth.tif')).equals(fs.readFileSync(path.join(input, 'pred/depth.tif')))).toBe(true);
  });

  it('refuses an image over the per-image limit, naming it and its size', async () => {
    const input = columnsFolder();
    put('cmp/gt/huge.png', Buffer.alloc(15_000_001, 1));
    const out = path.join(tmp, 'out');
    const v = await refusal(share(input, out));
    expect(v).toEqual(['1 image(s) over the 15.0 MB per-image limit: gt/huge.png (15.0 MB)']);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a non-empty --out together with every other violation, leaving --out as it was', async () => {
    const input = columnsFolder();
    put('cmp/pred/depth.tif', 'II*');
    const out = path.join(tmp, 'out');
    put('out/keep.txt', 'mine');
    const v = await refusal(share(input, out));
    expect(v[0]).toBe(`--out ${out} is not empty`);
    expect(v[1]).toContain('pred/depth.tif');
    expect(fs.readdirSync(out)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('removes what it staged when staging itself fails midway', async () => {
    const out = path.join(tmp, 'out');
    let copies = 0;
    const flaky = { ...nodeShareIo, copyFile: async (from: string, to: string) => {
      if (++copies === 3) throw new Error('disk full');
      await nodeShareIo.copyFile(from, to);
    } };
    const err = await shareComparison({ input: columnsFolder(), out, host: 'claude-artifact', pageHtml: PAGE, base64: nodeBase64 }, flaky).then(() => null, e => e);
    expect((err as Error).message).toBe('disk full');
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('share: refuses an input it cannot read as a comparison', () => {
  it('refuses an input that does not exist, or is neither a folder nor a session', async () => {
    const missing = path.join(tmp, 'nope');
    expect(await refusal(planLayout(missing, nodeShareIo))).toEqual([`No such file or folder: ${missing}`]);
    const png = put('a.png', makeSolidPng(4, 4, [1, 2, 3]));
    expect(await refusal(planLayout(png, nodeShareIo))).toEqual([`Not a folder or a .imagecompare session: ${png}`]);
  });

  it('refuses a folder with neither image subdirectories nor loose images', async () => {
    put('empty/readme.txt', 'x');
    expect(await refusal(planLayout(path.join(tmp, 'empty'), nodeShareIo))).toEqual([
      `No images to share in ${path.join(tmp, 'empty')}: neither image subdirectories nor loose images`,
    ]);
  });

  it('refuses a session that does not parse, naming the session', async () => {
    const session = put('bad.imagecompare', '{ not json');
    const v = await refusal(planLayout(session, nodeShareIo));
    expect(v).toHaveLength(1);
    expect(v[0].startsWith(`${session}: `)).toBe(true);
  });

  it('refuses a session listing no existing image or directory', async () => {
    const session = put('s.imagecompare', JSON.stringify({ paths: [put('x/notes.txt', 'x'), path.join(tmp, 'gone.png')] }));
    expect(await refusal(planLayout(session, nodeShareIo))).toEqual([`${session}: lists no existing images or directories`]);
  });

  it('refuses a file-list session of one image, which the page would not open', async () => {
    const session = put('s.imagecompare', JSON.stringify({ paths: [put('x/a.png', makeSolidPng(4, 4, [1, 2, 3]))] }));
    expect(await refusal(planLayout(session, nodeShareIo))).toEqual(['A file list needs at least 2 images; the page would not open 1']);
  });

  // No file name on Windows can hold a control character; the label test covers the column side everywhere.
  it.skipIf(process.platform === 'win32')('refuses a file name no lookalike can make safe, never dropping the file', async () => {
    const bad = put('cmp/gt/a\u0007.jpg', photo('airplane.jpg'));
    put('cmp/gt/b.jpg', photo('baboon.jpg'));
    put('cmp/pred/b.jpg', photo('peppers.jpg'));
    expect(await refusal(planLayout(path.join(tmp, 'cmp'), nodeShareIo))).toEqual([
      `${bad}: the file name "a\\u0007.jpg" cannot be made a safe file name`,
    ]);
  });

  it('refuses an --out that is a file, and leaves it as it was', async () => {
    const out = put('out.txt', 'keep');
    expect(await refusal(share(columnsFolder(), out))).toEqual([`--out ${out} is a file, not a folder`]);
    expect(fs.readFileSync(out, 'utf8')).toBe('keep');
  });
});

describe('share: the script\'s modules reach no vscode module', () => {
  // scripts/share-comparison.mjs bundles these for node with no vscode stand-in, while this suite
  // reaches them through the vscode mock alias: only a bundle like the script's can see the import.
  it('bundles sharePlan, shareNodeIo and hostRegimes for node without resolving vscode', async () => {
    const esbuild = await import('esbuild');
    const root = path.resolve(__dirname, '..', '..');
    const result = await esbuild.build({
      entryPoints: ['sharePlan.ts', 'shareNodeIo.ts', 'hostRegimes.ts'].map(f => path.join(root, 'standalone', f)),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      write: false,
      outdir: path.join(tmp, 'bundle'),
      external: ['sharp'],
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles).toHaveLength(3);
  });
});

describe('share: limits are the regime row\'s (docs/standalone.md: host-regime-is-one-table)', () => {
  const limits = HOST_REGIMES['claude-artifact'].limits;
  const page = (bytes = 300_000): StagedFile => ({ path: 'image_compare.html', bytes, kind: 'page' });
  const manifest: StagedFile = { path: 'imagecompare.json', bytes: 1_000, kind: 'manifest' };
  const images = (n: number, bytes: number): StagedFile[] => Array.from({ length: n }, (_, i) => ({ path: `c/${i}.png`, bytes, kind: 'image' }));

  it('passes a comparison inside every limit, and checks nothing for a host with none', () => {
    expect(limitViolations([page(), manifest, ...images(509, 400_000)], limits)).toEqual([]);
    expect(limitViolations([page(), manifest, ...images(2000, 20_000_000), { path: 'x.tif', bytes: 1, kind: 'image' }], null)).toEqual([]);
  });

  it('counts page, manifest and thumbs files toward the per-version file limit', () => {
    const v = limitViolations([page(), manifest, { path: 'imagecompare.thumbs.0.json', bytes: 10, kind: 'thumbs' }, ...images(509, 10)], limits);
    expect(v).toEqual(['512 files (3 page/manifest/thumbs + 509 images) exceed the 511-file limit per published version']);
  });

  it('names the total-size limit with the measured total', () => {
    expect(limitViolations([page(0), { ...manifest, bytes: 0 }, ...images(20, 13_000_000)], limits))
      .toEqual(['260.0 MB in total exceeds the 256.0 MB limit per published version']);
  });

  it('holds each text file to the text-file limit, naming it', () => {
    const v = limitViolations([page(16_000_001), manifest, ...images(1, 10)], limits);
    expect(v).toEqual(['1 text file(s) over the 16.0 MB per-text-file limit: image_compare.html (16.0 MB)']);
  });

  it('refuses when the page, manifest and thumbs alone exceed one publish call', () => {
    const thumbs = Array.from({ length: 5 }, (_, i): StagedFile => ({ path: `imagecompare.thumbs.${i}.json`, bytes: 15_000_000, kind: 'thumbs' }));
    const v = limitViolations([page(), manifest, ...thumbs, ...images(1, 10)], limits);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^The page, manifest and thumbs files alone \(7 files, 75\.3 MB\) exceed one publish call \(255 files, 64\.0 MB\)/);
  });

  // Every publish call sends the artifact page, so each later batch carries it again, counted within the caps.
  it('batches within the per-publish caps, page, manifest and thumbs first, the page again in every later batch, every other file once in order', () => {
    const thumbs: StagedFile = { path: 'imagecompare.thumbs.0.json', bytes: 2_000_000, kind: 'thumbs' };
    const files = [page(), manifest, thumbs, ...images(300, 400_000), ...images(1, 14_000_000).map(f => ({ ...f, path: 'c/big.png' }))];
    const batches = planBatches([...files.slice(3, 10), ...files.slice(0, 3), ...files.slice(10)], limits);
    expect(batches[0].slice(0, 3).map(f => f.path)).toEqual(['image_compare.html', 'imagecompare.json', 'imagecompare.thumbs.0.json']);
    for (const batch of batches) {
      expect(batch[0]).toEqual({ path: 'image_compare.html', bytes: 300_000 });
      expect(batch.length).toBeLessThanOrEqual(255);
      expect(batch.reduce((n, f) => n + f.bytes, 0)).toBeLessThanOrEqual(64_000_000);
    }
    const flat = batches.flatMap((batch, i) => (i === 0 ? batch : batch.slice(1))).map(f => f.path);
    expect(flat).toEqual(['image_compare.html', 'imagecompare.json', 'imagecompare.thumbs.0.json', ...images(300, 0).map(f => f.path), 'c/big.png']);
    // 254 images beside the page fill a later call to 255 files exactly; the 255th image starts another.
    const counted = planBatches([page(10), { ...manifest, bytes: 10 }, ...images(253 + 254 + 1, 10)], limits);
    expect(counted.map(b => b.length)).toEqual([255, 255, 2]);
    // 300 images of 0.4 MB: 120 MB plus the big one cannot fit in fewer than three calls.
    expect(batches.length).toBe(3);
    expect(planBatches(files, null)).toHaveLength(1);
  });
});

describe('share: page title', () => {
  it('replaces only the title, escaped', () => {
    expect(setPageTitle('<head><title>x</title></head><body><title>y</title>', 'a & "b"')).toBe('<head><title>a &amp; &quot;b&quot;</title></head><body><title>y</title>');
    expect(() => setPageTitle('<html></html>', 'x')).toThrow();
  });
});
