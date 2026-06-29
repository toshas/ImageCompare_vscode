# ImageCompare — Test Plan & Coverage Status

Living plan for the testing effort. Strategy detail lives in [TESTING.md](TESTING.md);
the per-feature green/red status lives in [FEATURES.md](FEATURES.md) and the
visual dashboard [test-dashboard.html](test-dashboard.html).

## How to see "all features green"

```bash
npm run test:dashboard        # run all suites + regenerate the dashboard
npm run test:dashboard:reuse  # regenerate from the last run's JSON (no re-run)
open test-dashboard.html      # colored grid, grouped by area, with a summary bar
```

The dashboard is **data-driven**: each feature in [test/dashboard/features.json](test/dashboard/features.json)
maps to the real test(s) that cover it. The generator runs Vitest + Playwright +
@vscode/test-cli with JSON reporters and lights each feature:
✅ tested · ❌ failing · ⬜ no test yet · 🟡 stale mapping.

## Current status

**41 / 62 features tested · 0 failing · 21 not-yet-covered** (as of last run).

| Layer | Runner | Tests |
|-------|--------|-------|
| 1 — Unit | Vitest | 29 (incl. cross-platform path logic) |
| 2 — Integration | @vscode/test-cli (real VSCode) | 7 |
| 3 — Webview UX | Playwright (real bundle, out-of-process) | 26 (incl. 10 UI-interaction tests + 3 visual baselines) |

**CI status:** the 3-OS matrix ([.github/workflows/test.yml](.github/workflows/test.yml))
ran green on **ubuntu / windows / macos** (2026-06-29) — unit + integration pass
on each platform with its native Sharp binary. Status badge is in the README.
Cross-platform logic is also tested from macOS via Windows-style inputs.

## Findings surfaced by the testbed

- ✅ **Fixed** — modality reorder dropped the pill tooltip path (name swapped, tooltip
  stuck in startup order). Guarded by `test/webview/reorder.spec.ts`.
- ⚠️ **Open, documented** — trie matcher: when originals + crops coexist with
  different per-modality suffixes, a crop can steal the original's slot. Encoded as
  an `it.fails` in `test/unit/tupleMatching.test.ts`.
- ⚠️ **Discrepancy** — CLAUDE.md's shortcut table lists `Del` to delete a tuple, but
  the key is **not actually bound** in `webview/main.ts` (delete is button-only).

## Backlog — the 21 untested features (next tests to write)

These are honest gaps shown ⬜ in the dashboard. Roughly prioritized:

**High value (core UX, easy to drive in the harness)**
- [ ] Drag to pan (mouse) → assert `panX/panY` change via state hook
- [ ] Click modality pill to switch modality
- [ ] Space (hold) flip to previous modality
- [ ] `[` reorder modality left (mirror of the existing `]` test)
- [ ] Click carousel thumbnail to navigate
- [ ] Toggle winner via carousel circle click
- [ ] Win counts shown on pills
- [ ] Zoom % readout in status bar
- [ ] Help modal open/close (`?` / Esc)

**Tools window**
- [ ] Show-zoom toggle
- [ ] PPMX colormap select (grayscale/jet) → asserts `setPpmxColormap` message
- [ ] Minimap navigator + viewport rectangle (zoomed)
- [ ] Drag panel to reposition
- [ ] Collapse/expand panel

**Crop tool (sub-interactions)**
- [ ] Resize via the 8 handles
- [ ] Move rectangle by dragging inside
- [ ] Double-click cardinal handle → snap to square

**Carousel**
- [ ] Scroll carousel
- [ ] Drag the resize handle (carousel width)

**Needs a PPMX fixture / extra plumbing**
- [ ] Value-under-cursor (PPMX pixel readout) — requires a PPMX image fixture +
      mocking the `requestPixelValue`/`pixelValue` round-trip in the harness
- [ ] `Del` key delete — first decide: bind the key (to match the docs) or fix the
      docs; then test whichever is chosen

**Not in the dashboard (backend, but worth adding)**
- [ ] PPTX export end-to-end (integration) — currently only the button visibility is covered
- [ ] Delete-tuple file operation (integration)
- [ ] File-watcher events: create / delete / rename / modify (integration, per-OS)

## Done

- [x] 3-layer test pyramid (unit / integration / webview) — all green
- [x] Webview shell extracted (`src/webviewShell.ts`), byte-identical to production
- [x] `window.__ic_test` state hook + out-of-process Playwright harness
- [x] Visual-regression baselines (local macOS)
- [x] Cross-platform logic suite + guarded 3-OS CI workflow
- [x] Feature dashboard (`features.json` + generator → `FEATURES.md` / `test-dashboard.html`)
