#!/usr/bin/env node
/**
 * Convert the recorded demo videos (raw/demos-<id>-chromium/video.webm) into
 * tiny animated WebPs and render a feature gallery (feature-demos.html).
 *
 * Pipeline: Playwright records flat synthetic-fixture interactions → ffmpeg
 * downscales + drops fps + compresses to WebP (~15-40 KB each, vs ~2 MB GIFs).
 *
 * Prereq: ffmpeg on PATH. Run the recorder first:
 *   npx playwright test --config=playwright.demos.config.ts
 *   node test/demos/build-gallery.mjs
 * (npm run test:demos does both.)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RAW = join(__dirname, 'raw');
const OUT = join(__dirname, 'gallery');

// Output is VP9 webm embedded as <video> in the gallery: a real motion codec,
// so it's BOTH smaller and sharper than animated WebP/GIF (~40-90 KB each).
// (Note: <video> renders in the HTML gallery/browser, not in GitHub markdown.)
const WIDTH = 680;
const CRF = 34;

function hasFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function videoFor(id) {
  const p = join(RAW, `demos-${id}-chromium`, 'video.webm');
  return existsSync(p) ? p : null;
}

function kb(path) {
  return Math.round(statSync(path).size / 1024);
}

if (!hasFfmpeg()) {
  console.error('ffmpeg not found on PATH — install it (e.g. `brew install ffmpeg`) and re-run.');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(__dirname, 'demos.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

let total = 0;
const cards = [];
for (const d of meta.demos) {
  const src = videoFor(d.id);
  if (!src) {
    console.log(`  ⚠️  no recording for "${d.id}" — run the demo recorder first`);
    continue;
  }
  const out = join(OUT, `${d.id}.webm`);
  execSync(
    `ffmpeg -y -i "${src}" -vf "scale=${WIDTH}:-2" ` +
      `-c:v libvpx-vp9 -crf ${CRF} -b:v 0 -an -row-mt 1 "${out}"`,
    { stdio: 'ignore' },
  );
  const size = kb(out);
  total += size;
  console.log(`  ${d.id.padEnd(20)} ${size} KB`);
  cards.push({ ...d, size });
}

// --- render gallery HTML ----------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const generatedAt = process.env.IC_DEMOS_TIME || '(run-time)';
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>ImageCompare — Feature Demos</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 20px 28px; border-bottom: 1px solid #262a33; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: #9aa0aa; font-size: 13px; }
  main { padding: 22px 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; }
  .card { border: 1px solid #262a33; border-radius: 10px; background: #151821; overflow: hidden; }
  .card video { display: block; width: 100%; background: #000; }
  .meta { padding: 10px 12px; }
  .row { display: flex; align-items: baseline; gap: 8px; }
  .title { font-size: 14px; font-weight: 600; }
  .keys { margin-left: auto; font-size: 11px; color: #9aa0aa; background: #1d212b; padding: 1px 7px; border-radius: 10px; white-space: nowrap; }
  .desc { font-size: 12px; color: #aeb4be; margin-top: 4px; line-height: 1.4; }
  .size { font-size: 10px; color: #6b717c; margin-top: 6px; }
</style></head>
<body>
<header>
  <h1>ImageCompare — Feature Demos</h1>
  <div class="sub">${cards.length} demos &middot; ${total} KB total (animated WebP) &middot; generated ${esc(generatedAt)}</div>
</header>
<main><div class="grid">
${cards
  .map(
    (c) => `  <div class="card">
    <video src="test/demos/gallery/${c.id}.webm" autoplay loop muted playsinline controls preload="metadata"></video>
    <div class="meta">
      <div class="row"><span class="title">${esc(c.title)}</span><span class="keys">${esc(c.keys)}</span></div>
      <div class="desc">${esc(c.description)}</div>
      <div class="size">${c.size} KB</div>
    </div>
  </div>`,
  )
  .join('\n')}
</div></main></body></html>`;

writeFileSync(join(ROOT, 'feature-demos.html'), html);
console.log(`\n✔ ${cards.length} demos, ${total} KB total → feature-demos.html`);
