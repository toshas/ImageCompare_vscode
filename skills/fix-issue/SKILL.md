---
name: fix-issue
description: Turn a plain-text bug/feature/issue report into a formalized issue, a failing test that reproduces it, a minimal fix, docs, and CI coverage across all three platforms. Use whenever someone describes a problem in prose ("when I drag the window the labels collapse", "crops steal the original's match slot", "add a toggle for X") and wants it fixed the right way — reproduced by a test first, then fixed, then documented.
---

# Fix an issue the testbed way

The goal: **never fix a bug without a test that fails before the fix and passes after.**
Every fix lands with a guard so it can't silently regress on any of the three OSes.

Input is free-form prose. Drive it through these steps in order. Keep the code diff
as small as the fix allows — assess every added line.

## 1. Formalize the report

Restate the prose as a structured issue (write it in the PR/commit body):

- **Symptom** — what the user observes.
- **Repro** — exact steps / inputs that trigger it (smallest possible).
- **Expected vs actual.**
- **Suspected component** — which file/function. Grep for the UI string, the message
  type, or the state variable named in the report.
- **Layer** — see step 2.

If the report is ambiguous (no repro, multiple readings), ask one clarifying question
before writing code.

## 2. Pick the test layer

This repo has three (see [TESTING.md](../../../TESTING.md)):

| The bug is about… | Layer | Lives in | Runner |
|---|---|---|---|
| Pure logic — matching, parsing, crop math, cross-platform IO | **unit** | `test/unit/*.test.ts` | `npm run test:unit` (Vitest) |
| Webview UX — keyboard/mouse, zoom/pan, panel, pills, selection, rendering | **webview** | `test/webview/*.spec.ts` | `npm run test:webview` (Playwright) |
| VS Code API — scanning, activation, commands, results.txt IO | **integration** | `test/integration/*.test.ts` | `npm run test:integration` |

Prefer the **lowest** layer that can reproduce the bug (fastest, most stable). Only
reach for webview/integration when the bug genuinely needs the DOM or the VS Code host.

To assert webview state without reading canvas pixels, use the `window.__ic_test`
hook (`getState()` in `helpers.ts`). For new pure logic, `export` the real function
and import it — never copy logic into the test.

## 3. Reproduce — write the failing test first (RED)

Add the smallest test that fails *because of the bug*. Run it and confirm it fails
for the right reason (not a typo). For a known-but-unfixed issue, encode it as
`it.fails(...)` (Vitest) so it flips to a hard failure the moment it's fixed.

## 4. Fix — minimal change (GREEN)

Make the smallest change that turns the test green. Re-run the layer; then run the
**full** suite (`npm run test:all`) to catch collateral damage.

## 5. Document

- Add a one-line entry to the **"Findings (caught by this testbed)"** section of
  [TESTING.md](../../../TESTING.md): symptom → root cause → fix location → guarding test.
- If the fix changed architecture (new message type, new exported API, new state),
  update [CLAUDE.md](../../../CLAUDE.md).

## 6. Confirm CI coverage

The matrix in `.github/workflows/test.yml` runs **all three layers — unit, webview,
integration** — on ubuntu/windows/macos (every push to `main`/`test/**` and every PR).
So a test placed under `test/` is guarded on all three OSes automatically; no machine-
specific step is involved. Two rules keep it that way:

- **Assert behavior, not pixels.** Use the `window.__ic_test` `getState()` hook (and
  outbound-message checks) so every assertion is deterministic on every OS. Don't add
  screenshot/pixel comparisons — they need per-OS baselines and a human to refresh them.
- Keep new files out of the published vsix — `test/**` is already in `.vscodeignore`.

## Worked example — the modality-reorder tooltip bug

Report: *"after I reorder modalities with `[` / `]`, the pill's hover tooltip shows
the wrong path."*

1. **Formalize** — Symptom: tooltip path stale after reorder. Suspected component:
   `moveCurrentModality` in `webview/main.ts`. Layer: **webview**.
2. **Reproduce** — `test/webview/reorder.spec.ts` reorders, then asserts via
   `getState()` that the pill name *and* its path tooltip both moved. Fails before fix.
3. **Fix** — `moveCurrentModality` swapped `modalities`, `modalityColors`, and
   `modalityOrder` but not `modalityPaths`. Add the one-line `modalityPaths` swap.
4. **Document** — entry added to TESTING.md "Findings".
5. **CI** — pure `getState()` assertion (no screenshot) → runs on all three OSes as-is.

Total change: **1 line of app code + 1 spec.** That's the target shape.

## After the fix: the dashboard row

The loop does not end at green tests. Map the new test in `test/dashboard/features.json`: a bug fix
usually adds its test to the affected feature's existing `tests` array; add a NEW feature row only
when the bug exposed a feature the registry never tracked. Then `npm run test:dashboard` and confirm
the row lights green — CI republishes the live dashboard from this registry on every main push.
