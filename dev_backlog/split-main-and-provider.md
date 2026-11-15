# Backlog: split `webview/main.ts` and the provider by concern

**Status: approved 2026-11-10, steps 1–3. Step 1 is done; steps 2 and 3 are left.** Each step is
one branch and one PR. Delete a step's section when it merges, and this file after step 3.

`src/webview/main.ts` has 2,832 lines, 115 functions and 66 module-level variables in one scope.
`src/imageCompareProvider.ts` has 2,477 lines: about 60 methods on one object, each taking the
panel's 45-field `PanelState` as its first argument. A class around `PanelState` alone renames
`state.x` to `this.x` and gains nothing. These steps give each concern an owner.

## Step 2: `webview/carousel.ts`

Move the strip out of `main.ts`: about 25 functions and 14 variables (virtualized rows and columns,
tiles, the strip's wheel, drag and resize). It reads the model, the current indices and the
thumbnail cache, and it reports a pick through a callback. The move changes no logic. The touch
layout's strip drag moves too, so check the strip on a real phone: emulated touch has missed real
bugs here (`docs/pointer-input.md`).

## Step 3: provider `directoryWatch.ts` and a pure rename window

- Move the watching cluster (lines ~1590–2420 plus the slot lookups) into a per-panel
  `DirectoryWatch`. This covers the watchers, adoption, the existence sweep, arrivals and removals.
  Its `PanelState` fields move with it, and it gets its own `dispose()`.
- Its calls into image delivery become an interface it receives: `invalidateSlot`,
  `reindexPendingImagePosts`, `dropPendingImagePosts`, `sendImage`, `refreshCurrentTupleImages`,
  `regenerateThumbnail`.
- Extract the rename window into a pure class over timer primitives, the shape of
  `SweepAimPolicy`. It covers `recentlyDeleted`, the 500 ms commit timer and the re-resolve. Today
  only the integration layer reaches it. It gets unit tests and mutation entries.

## How each step runs

- The branch starts from `main`. The PR merges with a merge commit.
- Dispatch `change-implementer`, then `change-verifier`, with `CLASS: refactor`.
- The gates are the CLAUDE.md battery plus `npm run test:webview`. Step 3 also needs
  `npm run test:integration`, which runs only on CI here.
- Update the CLAUDE.md component list and every doc that names a moved file or function.

**Out of scope:**
- splitting image delivery and the thumbnail sweep out of the provider;
- one `selectModality(target, cause)` for the 10 writers of `currentModalityIndex`;
- a pure zoom and pan transform.

Plan these only after step 3, if the maintainer wants them.
