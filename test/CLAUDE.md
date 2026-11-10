# Editing `test/`

Pointers, not copies — the rules live in the root `CLAUDE.md` and `docs/testing.md`.

1. **A test nothing can break is decoration.** An invariant-grade rule needs an entry in
   `scripts/mutation-check.mjs`, and the entry must *discriminate*: killed with your test present,
   NOT killed without it. The harness decides KILLED from the suite's **exit status**, so a mutation
   killed by a pre-existing assertion — or by a pre-existing side effect such as Vitest failing on a
   leaked rejection — certifies nothing. Verify both directions.
2. **If a rule cannot be mutation-covered, say so.** Layer 2 and Layer 3 are outside the harness
   (it runs Vitest suites only; its sandbox carries `src/`, `standalone/` and `test/`, so Layer 1 is
   the only layer it can drive). Declare it in the
   test header and in `docs/testing.md`, and state what stands in for it — the precedent wording is
   already there. Leaving a gap open with a written reason beats closing it with a test that cannot
   fail.
