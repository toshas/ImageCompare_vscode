# Editing `test/`

Pointers, not copies — the rules live in the root `CLAUDE.md` and `docs/testing.md`.

1. **Which layer.** Webview DOM/interaction → a Playwright spec in `test/webview/`. Real VS Code API
   (fs scanning, commands, activation) → `test/integration/`. Pure logic → Vitest in `test/unit/`
   importing the real module. Prefer the lowest layer that can reproduce the behaviour.
2. **A test nothing can break is decoration.** An invariant-grade rule needs an entry in
   `scripts/mutation-check.mjs`, and the entry must *discriminate*: killed with your test present,
   NOT killed without it. The harness decides KILLED from the suite's **exit status**, so a mutation
   killed by a pre-existing assertion — or by a pre-existing side effect such as Vitest failing on a
   leaked rejection — certifies nothing. Verify both directions.
3. **If a rule cannot be mutation-covered, say so.** Layer 2 and Layer 3 are outside the harness
   (it runs Vitest suites only, and never copies `standalone/` into its sandbox). Declare it in the
   test header and in `docs/testing.md`, and state what stands in for it — the precedent wording is
   already there. Leaving a gap open with a written reason beats closing it with a test that cannot
   fail.
4. **Multi-line comments are allowed here** — deliberately. `comment-lint` reads `src/` and
   `scripts/`, never `test/`, because a comment explaining why a fixture triggers an edge case
   belongs beside the fixture.
5. **Pin values from outside the implementation.** Comparing the code to itself proves nothing; when
   you add a test, break the code it covers and watch it fail.
