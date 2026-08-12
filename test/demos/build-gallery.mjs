#!/usr/bin/env node
/**
 * Convert the recorded demo videos (raw/demos-<id>-chromium/video.webm) into
 * tiny H.264 MP4 clips and render a feature gallery (test/demos/gallery/index.html).
 *
 * Pipeline: Playwright records interactions on real photo fixtures → ffmpeg
 * downscales + compresses to H.264 MP4. MP4/H.264 plays in every
 * browser incl. Safari and VS Code's built-in preview (unlike VP9 WebM).
 *
 * Prereq: ffmpeg on PATH. Run the recorder first:
 *   npx playwright test --config=test/demos/playwright.demos.config.ts
 *   node test/demos/build-gallery.mjs
 * (npm run test:demos does both.)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, 'raw');
const OUT = join(__dirname, 'gallery');

// Output is H.264 MP4 embedded as <video>: a real motion codec (small + sharp)
// that plays in EVERY viewer — Safari, Chrome, VS Code's built-in HTML preview.
// (Note: <video> renders in a browser, not inline in GitHub markdown.)
const WIDTH = 680;
const CRF = 28;

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
  const out = join(OUT, `${d.id}.mp4`);
  execSync(
    `ffmpeg -y -i "${src}" -vf "scale=${WIDTH}:-2" ` +
      `-c:v libx264 -crf ${CRF} -preset slow -pix_fmt yuv420p -movflags +faststart -an "${out}"`,
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
  /* One row per demo: the clip and its caption side by side — a dense card grid buried the captions. */
  .grid { display: flex; flex-direction: column; gap: 14px; max-width: 980px; margin: 0 auto; }
  .card { display: flex; gap: 16px; align-items: flex-start; }
  .card video { width: 420px; flex-shrink: 0; }
  .card .meta { padding-top: 4px; }
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
  <div class="sub">${cards.length} demos &middot; ${total} KB total (H.264 MP4) &middot; generated ${esc(generatedAt)}</div>
</header>
<p class="hint">Hover a clip to preview it; click for sound-free playback with controls.</p>
<main><div class="grid">
${cards
  .map(
    (c) => `  <div class="card">
    <video src="${c.id}.mp4" muted playsinline controls preload="metadata"></video>
    <div class="meta">
      <div class="row"><span class="title">${esc(c.title)}</span><span class="keys">${esc(c.keys)}</span></div>
      <div class="desc">${esc(c.description)}</div>
      <div class="size">${c.size} KB</div>
    </div>
  </div>`,
  )
  .join('\n')}
</div></main>
<script>
  // Play-on-hover, one clip at a time — autoplaying every video at once made the page unreadable.
  for (const v of document.querySelectorAll('video')) {
    v.addEventListener('mouseenter', () => { v.play(); });
    v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
  }
</script></body></html>`;

writeFileSync(join(OUT, 'index.html'), html);
console.log(`\n✔ ${cards.length} demos, ${total} KB total → test/demos/gallery/index.html`);
