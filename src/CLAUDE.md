# Editing `src/`

Pointers, not copies — the rules live in the root `CLAUDE.md` and `docs/`. This file exists so the
four that bite *here* are in front of you while you work.

1. **One-line comments.** A run of 2+ consecutive `//` lines fails `node scripts/comment-lint.mjs`,
   which gates CI and reads only this directory. If the explanation does not fit on one line it
   belongs in `docs/` — leave a one-line pointer naming the doc.
2. **Every invariant is cited from the code that could break it.** Adding or changing an invariant in
   `docs/*.md` means adding `(docs/<file>.md: <invariant-key>)` at *every* site its text names —
   "reads and writes", "Sharp and Jimp", both hosts. `node scripts/check-invariants.mjs` catches an
   uncited key or a dangling citation, not a half-marked one.
3. **Sidedness is derived, not declared.** `node scripts/check-sidedness.mjs` computes
   extension-only / standalone / shared / webview from the real import graph. A module that only one
   product imports must not appear in `docs/standalone.md`'s shared list, and a genuinely shared
   module must. Run `--print` for the authoritative table.
4. **Prefer extracting a pure module over adding logic to a vscode-coupled one.** Pure modules get
   unit tests against the real code; provider glue does not, and the copy era ended badly (see
   `docs/testing.md`, "The copy trap").
