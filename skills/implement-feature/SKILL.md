---
name: implement-feature
description: Implement a new user-visible feature the repo's way — formalize the contract, design docs/invariants FIRST, register the dashboard row before tests exist, then build through an adversarial implementer/verifier agent pair. Use when someone asks for new behavior ("add a toggle for X", "support Y", "make Z configurable"). For correcting existing behavior use fix-issue instead.
---

# Implement a feature the testbed way

The feature loop's obligations (CLAUDE.md) in the order that prevents omissions: **docs before
code, registry row before tests, adversarial verification before done.** The orchestrator designs
and dispatches; **it implements nothing and judges nothing itself** — the same context that wrote a
change grades it measurably softer, which is why the roles are separate agents (see
`agents/README.md`).

## 1. Formalize the contract (orchestrator)

Restate the request as a contract the implementer can be dispatched with and the verifier can
reject against:

- **Behavior** — what the user can do afterwards that they cannot do now, stated as observable
  outcomes (key presses, messages, files written), not implementation.
- **Scope boundary** — what this feature explicitly does *not* do (the verifier treats
  out-of-contract hunks as scope creep).
- **Surfaces touched** — extension host / webview / wire protocol / session format; name the
  files you expect to change.
- **Test layer(s)** — per the CLAUDE.md decision rule (webview DOM → Playwright; VS Code API →
  integration; pure logic → Vitest unit).
- **Invariants** — any rule whose silent breakage would corrupt data or violate a documented
  contract. These are what step 2 writes down and what gets a mutation entry.

If the request is ambiguous in a way that changes the contract, ask one question before designing.

## 2. Design pass — docs and registry BEFORE implementation (orchestrator)

1. **Update the `docs/` file(s) the feature touches** to describe the new behavior as it *will* be:
   the design decision, the non-obvious why, and each new invariant as a named
   `## Invariants` bullet (kebab-case key). This is deliberate: writing the doc first forces the
   design argument, and the implementer is then building to a documented contract instead of
   documenting an accident afterwards. (`check-invariants.mjs` will fail until the code cites the
   new keys — that pending red is the to-do list, closed by the implementer's citations.)
2. **Register the dashboard row now** — `test/dashboard/features.json`, area → feature, stable
   `id`, `tests: []`. Gray-before-green is the point: the gap is visible from the moment the
   feature exists, not after someone remembers.
3. Decide the **demo question** now and write it into the contract: is this a new user-visible flow
   worth a gallery clip (`test/demos/`), or not? Either answer is fine; deferring the question is
   not.

## 3. Build — adversarial implementer/verifier pair

Create a run directory (`.agent-runs/feature-<slug>/`, gitignored). Then:

1. Dispatch **`change-implementer`** with `REPO_ROOT`, `RUN_DIR`, `CLASS: feature`, and the
   `CONTRACT` (include the doc keys from step 2 and the row id). It implements to the documented
   contract, cites the invariants, writes the tests + mutation entries, lights the row, and records
   pre-images under `RUN_DIR/before/` so its diff can be derived independently.
2. Dispatch **`change-verifier`** with `REPO_ROOT`, `RUN_DIR`, `CLASS: feature`, and **the same
   `CONTRACT` only**. Never forward the implementer's summary, rationale, or self-assessment — the
   verifier's preflight rejects a dispatch that carries them. It derives the diff from the
   pre-images, proves the new tests bite (swap-restore or mutation kill), audits the feature-class
   obligations, runs the battery, and defaults to REJECT.
3. On REJECT, re-dispatch the implementer with the verifier's objections. **Two attempts, then stop
   and escalate to the user** — a third try on the same objections is where adversarial loops start
   producing regressions instead of fixes.

## 4. Close out (orchestrator)

- The verifier's PASS **is** the CLAUDE.md close-out audit — do not run a second one. State its
  per-obligation verdicts in the report or commit message.
- `npm run test:dashboard` — the row must light green (or stay deliberately gray per the contract).
- If the contract said yes to a demo: add the `demos.json` entry (caption is single-sourced there)
  and the recording script, re-record, and check the clip shows what its caption claims.
- Report: the contract, the verifier's verdicts, what shipped gray and why, and the demo decision.

### Overlapping rounds (worktrees)

Same protocol as `fix-issue` → "Overlapping rounds": verify(N) runs against the main checkout while
implement(N+1) runs with `isolation: "worktree"` off the last commit; merge onto the new HEAD before
N+1's verifier, which must see the merged tree. `scripts/mutation-check.mjs` and
`test/dashboard/features.json` collide every time and are merged by hand. Do not overlap when the two
rounds touch the same `src/` module, or when N is a REJECT fixup.
