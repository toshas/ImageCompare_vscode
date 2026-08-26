# Backlog: copy a multi-selection to the clipboard

**Status: not started. Depends on [`multi-select-and-save-selection.md`](multi-select-and-save-selection.md)**,
which owns the selection itself. This file is only the clipboard half. Raised 2026-08-26 from
[ImageCompare_standalone#4](https://github.com/toshas/ImageCompare_standalone/pull/4).

## What the user gets

With several thumbnails selected, one keystroke puts them all on the clipboard.

## What already exists — do not rewrite it

Copying **one** image already works: right-click a thumbnail, `copyCurrentImage()` ->
`writeImageToClipboard()` (`webview/main.ts:2174-2210`), with `showCopyToast` and its CSS already in
`webviewShell.ts`. This round extends that path; it must not add a parallel one.

**The reason that matters is a bug we already paid for.** `writeImageToClipboard` defers the write
until the document has focus, because Chromium silently drops `clipboard.write()` from an unfocused
document — the context-menu case — leaving the *previous* image on the clipboard with only a 1.4 s
"Copy failed" toast as evidence. It is written up in `docs/testing.md` Findings ("copy-image
staleness"). A fresh `navigator.clipboard.write(...)` call, which is what the PR adds, reintroduces
it exactly.

## The open question this round has to answer

**Is multi-image clipboard worth promising at all?**

Browser support for more than one `ClipboardItem` is poor and inconsistent. The PR's own code
concedes this: on failure it falls back to copying just the first image and toasts "Copied 1 image
(multi-copy not supported)" — a promise that silently degrades to something else.

Three honest options, pick one on evidence rather than optimism:

1. **Ship multi-copy with the degradation stated** — try all, fall back to one, and say so in the
   toast. Closest to the PR.
2. **Keep Ctrl+C single-image, and let Alt+S be the multi-image answer.** Saving to `.selection_NN`
   is reliable, works for any count, and is already the sibling feature. Arguably the better product:
   one keystroke that always works beats one that sometimes half-works.
3. **Copy a montage** — compose the selection into one image and copy that. Always one
   `ClipboardItem`, always works, and for "paste into a doc" it may be what the user wanted anyway.
   More work, and it needs a layout decision the PPTX deck already had to make (`pptxDeck.ts`).

Measure actual browser behaviour before choosing. Option 2 costs nothing and cannot disappoint.

## Traps

- Route everything through `writeImageToClipboard`, so the focus deferral applies. If the deferral
  cannot express "several blobs", extend it — do not bypass it.
- Decode cost: the PR re-decodes every selected file to a canvas to produce PNG bytes. On a wide
  selection that is a lot of full-resolution decodes on the UI thread. Check whether the already
  loaded image or the thumbnail can serve, and what the user expects — clipboard almost certainly
  means full resolution, so this may simply need to be bounded and cancellable.
- Order: a clipboard with several images has an order. Pick one (tuple-major, display order) and
  state it, or paste order is arbitrary.

## Acceptance

- Whatever is promised is what happens: if multi-copy can degrade to one image, the UI says so at the
  moment it degrades.
- The focus-deferral path still holds — pinned by a test, since this is the exact regression the
  existing Findings entry documents.
- No second clipboard code path exists in `webview/main.ts`.
