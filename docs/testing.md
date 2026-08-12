# Testing

What is pinned, what is not, and the one trap that makes a green run mean less than it looks.

The extension is two programs with different testability:

1. **Extension host** (Node): `fileService`, `thumbnailService`, `imageCompareProvider`, file
   watching, crop/PPTX/results I/O.
2. **Webview UI** (browser, **canvas-based**): `webview/main.ts`, `webview/crop.ts` — carousel,
   zoom/pan, crop, voting.

The canvas is opaque to DOM selectors, so the webview is tested through a **state hook**
(`window.__ic_test`) that exposes the UI's logic — zoom, pan, selected tuple/modality, crop rect,
winners — letting specs assert behavior without reading pixels. Every assertion is deterministic,
so the suite runs identically on any OS.

## The three layers

| Layer | Runner | What it covers | In CI |
|-------|--------|----------------|-------|
| **1 — Unit** | Vitest | Pure logic on the **real** exported code — tuple matching, PNG tEXt chunks, crop math, the work pool, watcher helpers | 3 OSes |
| **2 — Integration** | `@vscode/test-cli` (headless VSCode) | The real extension activating — directory scanning, commands, results.txt I/O on temp fixtures | 3 OSes |
| **3 — Webview** | Playwright (headless Chromium) | The real `dist/webview.js` in a harness, driven by canned messages; deterministic state-hook assertions | 3 OSes |

```bash
npm test                  # the whole unit layer (alias: test:unit)
npm run test:integration  # Layer 2 — headless VSCode
npm run test:webview      # Layer 3 — run `npm run compile` first
npm run test:all          # all three
npx vitest run test/unit/workPool.test.ts --config test/vitest.config.ts   # one suite
```

Layer 1 is the publish gate: `.github/workflows/publish.yml` runs `npm test` and
`scripts/mutation-check.mjs` in its `test` job, which gates the whole build matrix — a red test
blocks publishing to both marketplaces. All three layers additionally run in their own workflow
(`.github/workflows/test.yml`) on **ubuntu / windows / macos** for every push and PR. That proves
the per-OS risks on a real OS — Sharp's native binary, the file watcher, Windows path/CRLF
handling — not just mocked. There are no pixel snapshots and no committed baselines, so every job
is deterministic and nothing has to be run or refreshed by hand.

Every unit suite imports the real shipped module. Suites for `vscode`-free code (`sessionFile`,
`watcherLogic`, `workPool`, `ppmxParser`, `modalityVisibility`, `thumbPack`, `wireFormat`) need
nothing but Node; the rest (`tupleMatching`, `pngTextChunk`, …) reach `vscode`-importing code
through the `vscode` mock alias in `test/vitest.config.ts`. Vitest transpiles with esbuild and
type-checks nothing itself; `tsconfig.test.json` closes that gap — `npx tsc --noEmit -p
tsconfig.test.json` runs in the CI gates job and covers all of `test/` except `test/integration/`,
which `test:integration` type-checks through its own tsconfig.
`pngTextChunk`'s Sharp-validation test needs a working native Sharp (installed by `npm ci`).

### The webview is tested out of process

The webview only talks to the extension through `postMessage`. So Layer 3 runs the **whole UI in a
plain browser**: load the real bundle against a harness that stubs `acquireVsCodeApi` (capturing
outbound messages) and feeds inbound `init`/`thumbnail`/`image` messages from fixtures. No
Electron — deterministic and fast.

The harness HTML is generated from `src/webviewShell.ts` — the **same** styles+body the production
panel uses — so it can't drift from the real shell. The `window.__ic_test` hook is read-only and
inert unless the harness sets `__ic_test_enabled`.

### Layout

```
test/
  unit/            # Layer 1 (Vitest)
  mocks/           # the `vscode` mock alias (vscode.ts)
  fixtures/        # shared message/image fixtures
  integration/     # Layer 2 (@vscode/test-cli) + its tsconfig
  webview/         # Layer 3 (Playwright): specs + generated harness
  dashboard/       # feature-coverage dashboard (generated)
  demos/           # captioned demo gallery (generated)
  vitest.config.ts                     # Layer 1 config
  webview/playwright.config.ts         # Layer 3 config
.vscode-test.mjs                       # Layer 2 config (must sit by package.json)
```

The Vitest and Playwright configs live next to their tests (invoked via `--config`).
`.vscode-test.mjs` stays at the repo root because `@vscode/test-cli` reads the extension's
`package.json` from the config's own directory.

## The suites

| Suite | Imports | Pins |
|---|---|---|
| `sessionFile` | real source | Path resolution, duplicate-path rejection, `labels`/`colors` validation, malformed JSON, `applyLabels()`, `suggestSessionFileName()`, the version gate, `serializeSessionFile()` relative-path rule |
| `watcherLogic` | real source | `matchDeletedFile()` rename disambiguation (incl. the ambiguous-multi-delete no-hijack rule), `shiftIndexAfterRemoval()`, `modalityInsertIndex()` (caller order beats alphabetical on re-add) and `tupleInsertIndex()` (crop lands after its parent; natural row order) |
| `workPool` | real source | Concurrency cap (incl. the reject path), priority + FIFO/seq order, cancellation, re-entrancy, error propagation |
| `ppmxParser` | real source | All four magic x flags combinations, size-based flags detection, normalization, malformed input |
| `modalityVisibility` | real source | Hidden-pill keyboard cycling: skip, run-skip, non-wrapping edges, all-hidden stay; the tiny-tile mouse-vote guard threshold |
| `thumbPack` | real source | Packfile round-trip, uuid pairing rejection, truncation/overflow/duplicate rejection |
| `wireFormat` | real source | Image payload normalization: Buffer→plain Uint8Array (species-safe), offset views copied tight, structuredClone survival |

Two more suites sit in the same directory and import the real shipped code via the `vscode` mock
alias: `test/unit/tupleMatching.test.ts` pins trie matching end to end (crop
deprioritization, each tie-break in isolation, nested crops, matcher key order, the final row order
by tuple *name*, colliding tuple names de-duplicated, and unique modality naming including the
collided-tail fallback — the pipeline cases run the real `scanForImages` over temp directories), and
`test/unit/pngTextChunk.test.ts` pins the tEXt round-trip, the `x,y,w,h,srcW,srcH` crop format, PNG
structure survival, CRC-32 against the IEEE check value and a full-table probe, and a Sharp re-read
of an injected PNG (the one unit test that needs a working native Sharp).

## The copy trap (historical)

`tupleMatching.test.ts` used to contain **pure TypeScript copies** of the trie-matching functions,
because the originals live in `fileService.ts`, which imports `vscode` — and nothing kept the copy in
step with the original, so a green run proved only that the *algorithm as transcribed* behaved.
`pngTextChunk` was a copy once too, and that is exactly how a crop-breaking bug shipped: the real
`pngInjectText` called `zlib.crc32` (Node 20.15+) while `engines.vscode` allowed Node 18, so every
crop threw on older VSCode — while the suite stayed green, because its copy had its own `zlib.crc32`.
The copy era is over: both suites import the real
`matchTuplesWithTrie`/`scanForImages` and `pngText.ts` through the Vitest `vscode` mock alias, so they
cannot drift. For code that has no `vscode` import, the extraction pattern still holds —
`watcherLogic.ts`, `workPool.ts`, `sessionFile.ts`, `ppmxParser.ts`, `pngText.ts`, `thumbPack.ts`,
`wireFormat.ts` and `webview/modalityVisibility.ts` all exist because extracting a decision into a
pure module is what makes it testable at all. Never test a copy.

## A green suite is not evidence

`scripts/mutation-check.mjs` (a CI gate) flips a known rule in the real source file the suite
exercises — every suite is killed through `vitest run` (the trie mutations hit `fileService.ts`
and are killed by `test/unit/tupleMatching.test.ts`) — reruns that suite, and fails if it stays
green. **Run it to see what it covers** — it prints one
line per mutation, and that output *is* the list. Nothing here enumerates them: two attempts to do so
went stale within a day, the second while correcting the first. It exists because the tuple-matching suite once passed
with several of its rules deliberately broken. When you add a test, pin a value
from *outside* the implementation (a spec constant, a hand-computed expectation); code compared to
itself proves nothing.

## Adding a feature, fix, or test — the one workflow

Every change lands the same way, so it can't silently regress:

1. **Formalize** the report — symptom → repro → expected vs actual → suspected component → which layer.
2. **Write the failing test first (RED)** at the lowest layer that reproduces it (unit →
   integration → webview). Import the **real** function (`export` it if needed); assert webview
   state via `window.__ic_test`'s `getState()`. For a known-but-unfixed bug, pin it with
   `it.fails(...)` so it flips to a hard failure once fixed.
3. **Fix (GREEN)** — smallest change; re-run the layer, then `npm run test:all`.
4. **Document** — one line in *Findings* below; update `CLAUDE.md` or the relevant `docs/` file if
   architecture changed; map the feature in `test/dashboard/features.json` (CLAUDE.md → "Growing
   the dashboard").
5. **CI guards it** — all three layers run on ubuntu/windows/macos for every push and PR. No local
   step and no per-OS baselines: every assertion is deterministic.

This is automated by the **`fix-issue` agent skill** (`skills/fix-issue/`, symlinked into
`.claude/skills/`): give it a bug description in prose and it produces the issue, the failing test,
the fix, the docs, and the CI check.

## What nothing covers

- **The image backends.** Nothing tests Jimp or `sharpLoader.ts`, and nothing tests the fallback
  chain. `test/unit/pngTextChunk.test.ts` uses Sharp only to mint a fixture PNG and re-read it — that
  exercises Sharp incidentally, not the loader or the tiers. See the Testing section of `docs/image-backends.md` for
  why a real test is awkward: the `Unsupported CPU` path needs a CPU no CI runner has, so it would
  have to be simulated, and the wasm32 tier it falls back to is absent from any normal install.
- **Most of `imageCompareProvider.ts`** (the largest file). The integration layer covers
  activation, command registration, real-fs scanning, and results.txt I/O, but the provider's
  message loop, watcher wiring, and PPTX export run untested — only their pure helpers
  (`watcherLogic`, `workPool`, `pngText`, …) are extracted and pinned. Prefer that shape for new
  logic.
- **The webview's pixels.** The Playwright layer drives the real bundle but asserts logic through
  the state hook — no pixel snapshots — so canvas rendering and visual layout are verified by eye
  (the demo gallery and the manual checks below).
- **Packaging.** One CI step scans the VSIX for the wasm32 tier (`docs/image-backends.md`), which
  transitively pins two entries of the `.vscodeignore` un-ignore list (`@img`, `@emnapi`). Nothing
  checks the rest of it — `sharp` itself, `detect-libc`, `semver` — whose failure mode is identical
  and silent.

## Findings (caught by this testbed)

- **Modality reorder lost the tooltip path** *(fixed)* — `moveCurrentModality` swapped
  `modalities`, `modalityColors`, and `modalityOrder` but not `modalityPaths`, so after reordering
  the pill name updated while its hover tooltip stayed in startup order. One-line fix in
  `webview/main.ts`; guarded by `test/webview/reorder.spec.ts`.
- **Matcher: orig+crop collision** *(open, documented)* — when originals and crops coexist, a crop
  query file can take the original's match slot. Pinned as `it.fails` in
  `test/unit/tupleMatching.test.ts` — it flips to a hard failure the moment the matcher is fixed.

## Viewing the generated reports

Two artifacts are meant to be opened by a developer (both regenerated by the test commands; neither
ships in the extension; both are republished to GitHub Pages on every main push):

- **`test/dashboard/dashboard.html`** — the feature-coverage dashboard (generated by
  `npm run test:dashboard`, not versioned); open in any browser.
- **`test/demos/gallery/index.html`** — the captioned demo gallery (generated by
  `npm run test:demos`, not versioned; also uploaded as the `demo-gallery` artifact on every CI
  run); open in any browser. Clips are H.264 MP4, so they play in Safari, Chrome, and VS Code's
  built-in preview alike. Keep the sibling `*.mp4` files next to the HTML.

`test/webview/harness/index.html` is generated at test time and git-ignored — it's the internal
Playwright harness, not for reading.

## Manual checks

Failures here are invisible to CI, so they are worth walking before a release. Two former entries
are automated now and dropped from the walk: three-mode scanning/commands run in the headless
integration layer (`npm run test:integration`), and placeholder rendering plus the webview
interactions run in the Playwright layer (`npm run test:webview`) — both on every push via
`.github/workflows/test.yml`. What remains manual:

2. Rename detection — a quick delete+create must move the image, not drop the row.
4. A remote filesystem (SSH, WSL) or a FUSE/network mount, where the watchers do not fire and the
   existence sweep is the only detector.
5. In base-dir mode, add a modality directory while the comparison is open — both by `mkdir` then
   writing images into it, and by moving in a directory that is already populated. The column must
   appear without reopening. The base glob is non-recursive, so no event fires for the images inside
   it — the directory entry itself is the only event, and where neither watcher reports it the
   existence sweep is what picks it up, so allow a sweep interval before calling it a failure.
   Do this once with a custom pill order ([ ] rearrangement) and a non-first modality focused: the
   arrangement must survive, focus must stay put, and the new column must land beside its
   original-order neighbour (docs/tuple-matching.md: rearrangement-survives-insert applies).
6. Carousel feel with a many-modality session (10+): it opens with every column visible; the resize
   handle tracks continuously — each drag frame runs a real refit of the virtualized row pool, so
   tiles stay crisp throughout the drag (no scale-preview softness) and the focused row holds its
   viewport position, moving only where the top/bottom bounds clamp forces it; arrow-key stepping
   keeps the tile grid pixel-stationary at the ends too — only tile content and the highlight
   change, with the last column always clear of the scrollbar thumb — and wheel or thumb drag
   scroll freely.

## What changed in the app to enable testing

- `src/webviewShell.ts` — extracted the static styles+body (one source of truth for the panel and
  the harness).
- `window.__ic_test` read-only state hook in `webview/main.ts` (inert unless a test sets
  `__ic_test_enabled`).
- `export` added to a few pure functions so tests import **real** code instead of copies.

## Debug logging

Enable `imageCompare.debug` in settings, then read the webview dev console
(**Help > Toggle Developer Tools**) for `[IC-EXT]` and the Extension Host output for `[IC-MATCH]`:

```jsonc
// settings.json
"imageCompare.debug": true
```

`[IC-EXT]` traces watcher events, sweep results, and the handler error paths. `[IC-MATCH]` traces
matching: per-modality file counts, the elected reference, exact hits, then fuzzy candidates and
scores. To debug a mis-grouped comparison, read the final tuple summary and look for `MISSING:`
entries — those are the modalities that found no file for a row.
