---
name: fix-issue
description: Turn a plain-text bug report into a formalized issue, a failing test that reproduces it, a minimal fix, docs, and CI coverage — built through an adversarial implementer/verifier agent pair. Use whenever someone describes broken existing behavior in prose ("when I drag the window the labels collapse", "crops steal the original's match slot"). For NEW behavior ("add a toggle for X") use implement-feature instead.
---

# Fix an issue the testbed way

The goal: **never fix a bug without a test that fails before the fix and passes after** — and never
let the author of the fix be the one who certifies it. The orchestrator formalizes and dispatches;
**it implements nothing and judges nothing itself** — the same context that wrote a change grades
it measurably softer, which is why the roles are separate agents (see `agents/README.md`).

## 1. Formalize the report (orchestrator)

Restate the prose as a structured issue — this becomes the `CONTRACT` both agents are dispatched
with, so it must stand on its own:

- **Symptom** — what the user observes.
- **Repro** — exact steps / inputs that trigger it (smallest possible).
- **Expected vs actual.**
- **Suspected component** — which file/function. Grep for the UI string, the message type, or the
  state variable named in the report.
- **Layer** — see step 2.

If the report is ambiguous (no repro, multiple readings), ask one clarifying question before
dispatching anything.

## 1b. Locate before you formalize (orchestrator)

When the report does not name a file and finding it means sweeping several directories or naming
conventions, delegate that search to the **`Explore`** agent rather than grepping it into this
context — it skips `CLAUDE.md` and git status deliberately, so it stays small, and it returns the
conclusion instead of the file dumps. Use it for "where does X live"; do the targeted read yourself
once you know where to look.

Note the implementer cannot do this: `change-implementer`'s tool grant is Read/Glob/Grep/Bash/Edit/
Write with no Agent tool, by design — an implementer that spawns helpers muddies who authored what.
Discovery breadth is the orchestrator's job, and it belongs in the contract you hand over.

## 2. Pick the test layer (orchestrator)

This repo has three (see [docs/testing.md](../../../docs/testing.md)):

| The bug is about… | Layer | Lives in | Runner |
|---|---|---|---|
| Pure logic — matching, parsing, crop math, cross-platform IO | **unit** | `test/unit/*.test.ts` | `npm run test:unit` (Vitest) |
| Webview UX — keyboard/mouse, zoom/pan, panel, pills, selection, rendering | **webview** | `test/webview/*.spec.ts` | `npm run test:webview` (Playwright) |
| VS Code API — scanning, activation, commands, results.txt IO | **integration** | `test/integration/*.test.ts` | `npm run test:integration` |

Prefer the **lowest** layer that can reproduce the bug (fastest, most stable). Only reach for
webview/integration when the bug genuinely needs the DOM or the VS Code host. Write the chosen
layer into the contract.

## 3. Build — adversarial implementer/verifier pair

Create a run directory (`.agent-runs/fix-<slug>/`, gitignored). Then:

1. Dispatch **`change-implementer`** with `REPO_ROOT`, `RUN_DIR`, `CLASS: fix`, and the `CONTRACT`.
   It writes the failing test first (RED, captured), makes the smallest change that turns it green,
   maps the test into the feature's existing `test/dashboard/features.json` row (a new row only if
   the bug exposed an untracked feature), adds the docs/testing.md "Findings" entry, and records
   pre-images under `RUN_DIR/before/` so its diff can be derived independently.
2. Dispatch **`change-verifier`** with `REPO_ROOT`, `RUN_DIR`, `CLASS: fix`, and **the same
   `CONTRACT` only**. Never forward the implementer's summary, rationale, or self-assessment — the
   verifier's preflight rejects a dispatch that carries them. It re-derives RED itself by restoring
   the pre-change production code (recompiling for webview-layer tests, which run against
   `dist/webview.js`), audits the fix-class obligations, runs the battery, and defaults to REJECT.
3. On REJECT, re-dispatch the implementer with the verifier's objections. **Two attempts, then stop
   and escalate to the user** — a third try on the same objections is where adversarial loops start
   producing regressions instead of fixes.

For a known-but-unfixed issue (reproduce now, fix later), the implementer encodes it as
`it.fails(...)` (Vitest) so it flips to a hard failure the moment it's fixed — that is a legitimate
single-agent outcome and needs no verifier round.

### Overlapping rounds (worktrees)

Within a round the pair is strictly sequential — the verifier reads what the implementer wrote. But
**verify(N) and implement(N+1) are independent** when N+1 is a different backlog item, and running
them concurrently is the only lever that overlaps agent wall time rather than shaving subprocess
cost. Do it when the queue has more than one item left:

1. Dispatch the verifier for round N against the **main checkout**, which holds N's uncommitted work.
2. Dispatch the implementer for round N+1 with `isolation: "worktree"`. It branches from the last
   **commit**, so it cannot see N's uncommitted changes — which is what makes the two safe.
3. When N passes and is committed, merge N+1's worktree onto the new HEAD before dispatching its
   verifier. **The verifier must run against the merged tree**, never the worktree in isolation, or
   it certifies a state that will never exist.

**The two files that collide, every time:** `scripts/mutation-check.mjs` and
`test/dashboard/features.json`. Both are append-only in practice, so the merge is mechanical — but
resolve it by hand and re-run the harness afterwards. `mutation-check.mjs` is what certifies every
other round; a bad merge there invalidates evidence retroactively, silently.

**Do not overlap when:** N and N+1 touch the same `src/` module (the merge stops being mechanical),
or N is a REJECT fixup (its objections may change what N+1 should do). Serialise those.

## 4. Close out (orchestrator)

- The verifier's PASS **is** the CLAUDE.md close-out audit — do not run a second one. State its
  per-obligation verdicts in the report or commit message.
- `npm run test:dashboard` — confirm the mapped row lights green.
- CI needs no extra step: the matrix in `.github/workflows/test.yml` runs all three layers on
  ubuntu/windows/macos for every push and PR, so a deterministic, behavior-not-pixels test is
  guarded everywhere automatically. Bug fixes get a test, never a demo clip.

## Worked example — the modality-reorder tooltip bug

Report: *"after I reorder modalities with `[` / `]`, the pill's hover tooltip shows the wrong
path."*

1. **Formalize** — Symptom: tooltip path stale after reorder. Suspected component:
   `moveCurrentModality` in `webview/main.ts`. Layer: **webview**.
2. **Implementer** — `test/webview/reorder.spec.ts` reorders, then asserts via `getState()` that
   the pill name *and* its path tooltip both moved: fails before the fix. Root cause:
   `moveCurrentModality` swapped `modalities`, `modalityColors`, and `modalityOrder` but not
   `modalityPaths` — the one-line swap turns it green. Findings entry added; test mapped to the
   reorder row.
3. **Verifier** — restores the pre-fix `main.ts`, recompiles, watches the spec fail for the right
   reason, restores, re-runs green, audits obligations, runs the battery: PASS.

Total change: **1 line of app code + 1 spec.** That's the target shape.
