# ImageCompare — Testing Strategy

This extension is two apps with very different testability profiles:

1. **Extension host** (Node): `fileService`, `ppmxParser`, `thumbnailService`, `imageCompareProvider`, file watching, PPTX/crop I/O.
2. **Webview UI** (browser, **canvas-based**): `webview/main.ts`, `webview/crop.ts` — carousel, zoom/pan, crop, voting.

The canvas viewport is opaque to DOM selectors, so the webview is tested two ways: **visual regression** (screenshots) for "does it look right" and a **test state hook** (`window.__ic_test`) for "is the logic right" (zoom, pan, selected tuple/modality, crop rect) without reading pixels.

## Test pyramid (this repo implements Layers 1–3)

| Layer | Runner | What | Speed |
|-------|--------|------|-------|
| **1 — Unit** | Vitest | Pure logic on **real production code** (matching, ppmx, png chunks, crop math, results parse, winner mapping) | ms |
| **2 — Integration** | `@vscode/test-cli` (Mocha in real VSCode, headless) | Provider behavior: tuple building per mode, file-watch events, crop/results/PPTX I/O on temp fixtures | sec |
| **3 — Webview UX** | Playwright (normal headless browser) | The real `dist/webview.js` loaded in a **harness** with a stubbed `acquireVsCodeApi`, driven by canned messages; visual + state-hook assertions | sub-sec/test |
| 4 — Electron E2E | *(deferred)* | Thin smoke proving the real message bridge | slow |

### The key idea — test the webview out of process
The webview only talks to the extension via `acquireVsCodeApi().postMessage()` + `window.onmessage`. So we run the **entire UI in a plain browser**: load the real bundle against a harness that (a) stubs the vscode API to capture outbound messages and (b) injects inbound `init`/`thumbnail`/`image` messages from fixtures. No Electron, fully deterministic, 10–50× faster.

The harness DOM is rendered from `src/webview/shell.ts` — the **same** styles+body the production panel uses (`getHtmlContent`) — so the harness can never drift from the real shell.

## Visual regression — local-only baselines (no CI cost)
Baselines are generated and committed **from one canonical machine** (this Mac, `darwin-arm64`). To keep canvas screenshots stable:
- Force software rendering / disable GPU in the browser launch flags.
- Use **synthetic** fixtures (solid colors, gradients, numbered tiles, a known PPMX), never photos.
- Tolerant threshold (`maxDiffPixelRatio`) and mask dynamic text (zoom %, dimensions).
- Snapshots live under `test/webview/__screenshots__/`. Update with `npm run test:webview -- --update-snapshots` **on the canonical machine only**.

Logic-level webview assertions (state hook, outbound messages) are platform-independent and are the primary signal; screenshots are a secondary guard.

## Commands
```bash
npm run test:unit         # Layer 1 (Vitest)        — fast, run always
npm run test:webview      # Layer 3 (Playwright)    — needs `npm run compile` first
npm run test:integration  # Layer 2 (@vscode/test-cli)
npm run test:all          # unit + webview + integration
npm run test:webview:update   # regenerate visual baselines (canonical machine only)
```

## Layout
```
test/
  mocks/vscode.ts            # minimal vscode stub (Vitest alias)
  unit/*.test.ts             # Layer 1
  fixtures/                  # synthetic image + message generators (shared)
  webview/
    harness/                 # generated harness.html + stub api
    *.spec.ts                # Layer 3 Playwright specs
    __screenshots__/         # committed local baselines
  integration/               # Layer 2 (@vscode/test-cli)
vitest.config.ts
playwright.config.ts
.vscode-test.mjs
```

## Cross-platform (Windows / Linux / macOS)

Two risk classes, covered differently:

- **Logic** (Windows-style URIs, drive letters, UNC, CRLF results.txt, case
  sensitivity) — covered by `test/unit/crossPlatform.test.ts`, which feeds
  foreign inputs and runs on any OS. The `vscode` mock's `Uri.file` normalizes
  Windows paths exactly like real VSCode (`\`→`/`, drive-letter leading slash),
  so these tests exercise the real Windows code paths from macOS.
- **Native / runtime** (Sharp's per-platform binary, FileSystemWatcher) — only a
  real OS proves these. The `.github/workflows/test.yml` matrix runs unit +
  integration on `ubuntu / windows / macos` (Linux via `xvfb`). `npm ci` installs
  the host-OS Sharp binary, so integration tests exercise real Sharp per platform.
  The workflow is lightweight + `concurrency`-guarded to stay within free quota.

Notes from the audit: `vscode.Uri.path` is always `/`-normalized, so
`uri.path.split('/')` is safe on Windows; output paths use `Uri.joinPath` /
Node `path`; `results.txt` CRLF is absorbed by `.trim()`. The webview (Layer 3)
is a browser and inherently OS-agnostic, so it isn't part of the OS matrix.

## Findings (caught by this testbed)

- **Modality reorder lost the tooltip path** *(fixed)* — `moveCurrentModality` swapped
  `modalities`, `modalityColors`, and `modalityOrder` in place but not `modalityPaths`,
  so after reordering the pill name updated while its hover tooltip (original path)
  stayed in startup order. Fixed in `webview/main.ts`; guarded by
  `test/webview/reorder.spec.ts`.
- **Matcher: orig+crop collision** *(open, documented)* — when originals and crops
  coexist with different suffixes per modality, a crop query file can overwrite the
  original on the same reference slot (`00000079_gt.png` pairs with
  `00000079_rgb_crop01.png`). The "crops never steal originals" rule only deprioritizes
  crops on the reference side, not the query side. Encoded as `it.fails` in
  `test/unit/tupleMatching.test.ts` — it will flip to a hard failure (alerting us) once
  the matcher is fixed.

## What changed in the app to enable testing
- `src/webview/shell.ts` — extracted static styles+body (single source of truth for provider + harness).
- `window.__ic_test` getter in `webview/main.ts` (gated by `window.__ic_test_enabled`; harmless no-op in production).
- `export` added to previously-local pure functions so tests import **real** code instead of maintaining copies.
