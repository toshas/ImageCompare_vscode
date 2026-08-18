# Backlog: symlinks not working (triage needed — bug vs. unimplemented feature)

**Status: not started.** Reported 2026-08-16: comparing folders that are (or contain) symlinks
doesn't work. Not yet reproduced or scoped.

One grounding fact from a first grep: no production code handles `FileType.SymbolicLink` — the
only mention in the repo is the enum constant in `test/mocks/vscode.ts`. VS Code's
`workspace.fs.readDirectory` reports a symlinked file as `File | SymbolicLink` (bitmask 65) and a
symlinked directory as 66, so any scan that compares `type === FileType.File` /
`=== FileType.Directory` with strict equality silently skips every symlinked entry. If
`fileService`'s scanning does that (check `scanForImages` and the directory walk), symlinked
images and symlinked modality directories are invisible — which would present exactly as
"symlinks not working."

Triage, when picked up:
1. Reproduce: a session with (a) a symlinked modality directory, (b) symlinked image files inside
   a real directory, (c) a symlinked root. Which of the three fails, and how (empty modality,
   missing tuples, error)?
2. Decide bug-vs-feature: if the strict-equality skip is confirmed, treat as a **bug** (mask with
   `&` instead) — the user's intent when pointing at a symlink is unambiguous. Broken/circular
   symlinks are the feature-ish part (stat may throw or loop) and need a policy: skip silently is
   probably right, but decide and document.
3. Watchers are a separate question: whether file watching fires through symlinks is
   platform-dependent (inotify does not follow them for the target's changes) — scope that
   separately in `docs/file-watching.md` terms; the polling fallback may already cover it.
4. Standalone note: FSA directory handles cannot express OS symlinks at all (the browser resolves
   or hides them), so whatever fix lands is extension-side; the shared matcher is unaffected.

Route through `/fix-issue` once triaged (step 1 gives the repro the contract needs). Delete this
file when done.
