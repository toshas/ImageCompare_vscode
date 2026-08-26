# Contributing to ImageCompare

This repo is built for **agent-driven development**. The guardrails — mutation-checked tests,
invariant citations, a coverage dashboard that fails CI on stale mappings — exist precisely so that
code written fast, by a human or an AI agent, cannot silently rot the project. Contributions are
expected to play by those rules; PRs that route around them will be asked to redo the work through
the procedures below.

## Vibe-coding: required, but with the safety on

Write your PR with an AI coding agent (Claude Code, Codex, or similar) opened at the repo root, so
it loads **[CLAUDE.md](CLAUDE.md)** — that file is the contract, not a suggestion. It encodes the
procedures, the test-layer decision rule, and the verification battery; an agent that has it in
context will walk them for you. Hand-written PRs are welcome too, but they are held to exactly the
same gates — the checklist below is then yours to walk manually.

"Vibe-coding" here does **not** mean unreviewed output. It means: let the agent write the code,
then make it prove the work through the repo's machinery. The machinery is the point; the vibes are
just the throughput.

## The two loops (from CLAUDE.md — follow them literally)

- **New feature** → the `/implement-feature` skill (formalize the contract → docs/invariants and a
  gray `test/dashboard/features.json` row *first* → adversarial implementer/verifier build) →
  verification battery → (demo clip only if a new user-visible flow is worth showing).
- **Bug fix** → the `/fix-issue` skill (formalize → **failing test first** → minimal fix → docs) →
  the new test joins the feature's existing `features.json` row → verification battery.

Before finishing, run the **Change close-out** (CLAUDE.md): classify the change (feature / fix /
refactor / test-only / docs / infra), audit the diff against that class's obligations, and state
the classification in the PR description.

## Non-negotiables

1. **Never test a copy.** Tests import the real shipped module (via the `vscode` mock alias if
   needed). A hand-transcribed function in a test once let a crop-breaking bug ship green; that era
   is over. See "The copy trap" in [docs/testing.md](docs/testing.md).
2. **A green test you never saw fail is decoration.** Break the code it covers, watch it fail,
   restore. Invariant-grade tests additionally get an entry in `scripts/mutation-check.mjs` — CI
   runs it and every mutation must be killed.
3. **Docs state invariants, not mechanics** — and every invariant in `docs/` is cited from the code
   that could break it (`node scripts/check-invariants.mjs` gates this). If your change makes a doc
   claim untrue, fix the doc in the same PR.
4. **Code comments are one line.** Longer explanations belong in `docs/`
   (`node scripts/comment-lint.mjs` gates `src/` and `scripts/`; `test/` is deliberately exempt).
5. **No Co-Authored-By lines in commits.**
6. **Minimize the diff.** No drive-by renames, reformatting, or refactors of code you aren't
   changing.

## The verification battery (run before pushing)

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.webview.json && npx tsc --noEmit -p tsconfig.test.json
npm test                            # Vitest unit layer
node scripts/check-invariants.mjs
node scripts/comment-lint.mjs
node scripts/mutation-check.mjs
npm run compile
```

CI re-runs all of this plus the integration and webview layers on **ubuntu, windows, and macos**
for every push and PR, and the coverage dashboard build **fails on stale `features.json`
mappings** — a test you renamed without updating its registry entry turns the build red, not gray.

## Where a new test goes (decision rule, in order)

1. Webview DOM/interaction behavior → Playwright spec in `test/webview/`.
2. Real VS Code API behavior (fs scanning, commands, activation) → `test/integration/`.
3. Pure logic → Vitest in `test/unit/`, importing the real module.

Demos (`test/demos/`) are **not** tests — add one only when a new user-visible flow is worth a
gallery clip. Details, harness docs, and the manual pre-release checklist:
[docs/testing.md](docs/testing.md).

## PR checklist

- [ ] Change classified (feature / fix / refactor / test-only / docs / infra) in the description
- [ ] Tests at the right layer, seen failing before the fix / passing after
- [ ] `features.json` row added or updated (honest gray is fine if tests come later)
- [ ] Mutation entry for any invariant-grade test
- [ ] Docs and invariant citations updated where the change invalidated them
- [ ] Verification battery green locally
- [ ] Diff minimal, commits free of Co-Authored-By
