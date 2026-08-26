# Backlog: open a folder that is just images

**Status: not started.** Raised 2026-08-26 from
[ImageCompare_standalone#4](https://github.com/toshas/ImageCompare_standalone/pull/4).

## What the user gets

Point the app at a folder containing images and no subfolders, and browse them one per row instead of
being told it is invalid. Today `scanForImages` throws
`Please select at least 2 image files or 2 directories` (`fileService.ts:348`).

## The design question this plan exists to answer

**The current rejection is deliberate, and `docs/session-files.md` says why:**

> A single directory of only files is rejected: it has no second axis. Each file would become its own
> "modality" — the same one-tuple shape mode 3 makes deliberately, but arrived at by accident.

So the objection is not "we never thought about it". It is that the obvious reading — **files become
modalities** — produces one tuple with N columns, which is mode 3 reached by accident rather than
intent.

The PR takes the **transpose**: files become **tuples**, one modality, N rows. That is a different
shape and the doc does not argue against it. Which is exactly why this needs deciding rather than
implementing.

**Decide, and write the decision into `docs/session-files.md`:**

1. **A fourth mode.** `1 directory of only images` -> N tuples x 1 modality. Honest, explicit, and
   the mode table gains a row. Costs: every "the three modes" claim in the docs and code becomes
   four, and `classifyUris()` grows a branch.
2. **Extend mode 1.** Mode 1 is "1 directory, subdirectories are modalities". Extending it to "…or,
   with no subdirectories, each image is a tuple" hides two very different shapes behind one mode
   number. Cheaper in code, worse to explain.
3. **Reject it still, and say so better.** If one-modality browsing is not what this tool is for, the
   error message should say *that*, not count files. Legitimate outcome — this is a comparison tool,
   and a single column compares nothing.

My reading: (1). The shapes are genuinely different, the mode table is the place users look, and a
mode that means two things is how `docs/tuple-matching.md`'s traps got written in the first place.

## What follows from the shape, whichever is chosen

- **Voting.** The PR disables it. With one modality there is nothing to vote *between*, so that seems
  right — but the standalone README claims "single-tuple folders are votable", and `resultsFile.ts`
  has its own view. Reconcile all three, do not just set a flag.
- **Crop, PPTX, delete.** All are per-tuple operations and should still work with one modality. Check
  rather than assume — `pptxDeck.ts` pairs parents with crops and may assume a second column.
- **Matching.** There is nothing to match: one file per tuple, tuple name from the filename. The trie
  matcher should not run at all, rather than run and trivially succeed.
- **Modality naming.** One column needs a name. The folder's own basename is the obvious choice.

## Traps

- The scan is host-side, so both hosts need it, and `standalone/adapter.ts:868` `openRoot` calls the
  same `scanForImages`. Fix it once in the shared module and both get it.
- The PR implements `loadFlatDirectoryModern` **and** `loadFlatDirectoryLegacy` — two copies of the
  same logic for two directory-reading paths. In this codebase that is one shared path with the
  backend injected.
- Drag-and-drop and the folder picker must reach the same code. In the standalone they are different
  backends (`fsBackends.ts`), and the drop path is read-only.

## Acceptance

- The mode decision is recorded in `docs/session-files.md`'s mode table, and every "three modes"
  claim in the repo is updated or is still true.
- The chosen behaviour is pinned at Layer 1 against the real `scanForImages`, including the
  now-changed rejection case.
- Voting, crop, PPTX and delete each either work or refuse with a reason, and which is which is
  written down.
