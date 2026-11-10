---
name: prune
description: Cut the bloat the repo has accumulated — dead code, duplicate tests, prose restating code, stale fixtures, one-use helpers — without changing behaviour or losing coverage, through an auditor/implementer/verifier agent trio. Use periodically, before a release, or when the repo has grown heavier than what it does. A single change's bloat is already audited inside implement-feature and fix-issue.
---

# Prune the repo

`implement-feature` and `fix-issue` audit each change for bloat before it is verified. This is the
periodic sweep for what accumulated before that existed, or slipped past it. As in those skills, the
orchestrator finds nothing, cuts nothing and judges nothing itself (see `agents/README.md`).

## 1. Partition and audit

Split the tracked files into slices an auditor can hold whole, about 6-8k lines each: a group of
`src/` modules with their tests and the docs that describe them is one slice. Large registries
(`scripts/mutation-check.mjs`, `test/dashboard/features.json`) get a slice of their own. Create
`.agent-runs/prune-<date>/` as `RUN_DIR`, then dispatch one **`bloat-auditor`** per slice
(`SCOPE: repo`, its `PATHS`), in parallel: they only read. Concatenate their ledgers into
`RUN_DIR/cuts.json`.

## 2. Triage

- Drop every entry without evidence, and every entry two auditors contradict.
- `JUDGMENT` entries go to the user, one `AskUserQuestion` per real decision with its evidence, and
  are applied only on a yes.
- Group the `CUT` entries into batches by area (production code, tests, docs and tooling), so each
  batch reads as one change and a rejected cut holds up only its own batch.
- **A rewrite batch holds one or two docs**, because its verifier must check that every claim of the
  original survived (prose standard: agents/bloat-auditor.md).

## 3. Apply and verify, one batch at a time

Serially, because batches share the tree and `dist/`:

1. Dispatch **`change-implementer`** with `REPO_ROOT`, a `RUN_DIR` per batch, `CLASS: prune` and
   the batch's entries as the `CONTRACT`.
2. Dispatch **`change-verifier`** with the same `CONTRACT` only.
3. On REJECT, re-dispatch once with the objections. A second REJECT drops the cuts it names, and
   the rest of the batch lands without them.

Commit each passed batch before the next starts, so a later reject never entangles an earlier one.

## 4. Stop

One sweep per invocation. A second sweep over the same tree mostly re-finds what the first chose to
keep, so it runs only when the user asks after reading the report.

## Report

Lines removed per area (`git diff --stat` against the sweep's base), the cuts applied, skipped and
rejected, the `JUDGMENT` items and their answers, and each batch's verifier verdicts.
