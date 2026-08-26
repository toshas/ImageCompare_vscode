# Backlog: multi-select thumbnails, and save the selection to `.selection_NN`

**Status: not started.** Raised 2026-08-26 from
[ImageCompare_standalone#4](https://github.com/toshas/ImageCompare_standalone/pull/4), an external
contribution against the frozen hand-written standalone. The code there cannot be merged — that file
is generated now — but the behaviour is worth having in both products.

## What the user gets

- **Ctrl+Click** a carousel thumbnail adds or removes it from a selection.
- **Shift+Click** selects the rectangle between the last click and this one — several tuples across
  several modalities at once.
- Selected thumbnails are outlined; **Esc** clears the selection.
- **Alt+S** copies every selected image into a `.selection_NN` folder beside the modality folders,
  byte-for-byte, no re-encoding.

## The folder name

`.selection_01`, `.selection_02`, … — leading dot, two-digit id, `NN = max existing + 1`. This
mirrors `comparison_NN.pptx` (`pptxDeck.ts:300-308`) and `_cropNN` (`cropPlan.ts`), and the numbering
belongs in a **pure planner** beside those two, not in either host.

The leading dot is load-bearing: it is what keeps the folder out of the comparison. See the trap
below.

## The hard requirement: a selection must survive the grid changing under it

The maintainer named this explicitly, and it is the whole difficulty. A selection has to stay
attached to the *same images* across:

- **`[` / `]` reorder** — changes display order only, but a selection remembering "third column"
  now points at a different modality;
- **a new tuple or modality arriving** (`arrivalPlan.ts`) — shifts indices;
- **a deletion** (`removalPlan.ts`) — shifts indices, and the selected image may itself be gone.

**Therefore: do not key the selection by index at all.** Key it by the image's identity — its URI /
path. Reorder then costs nothing, insertion and removal cost nothing, and a deleted image simply
drops out of the selection because its key no longer resolves. Any index-keyed design will need
re-shifting logic in three places and will still be wrong after the fourth.

Note `winners` (`webview/main.ts:163`) *is* keyed `TupleIndex -> DisplayModalityIndex`. Check whether
that already misbehaves under `[` / `]`; if it does, that is a separate bug and this plan should not
copy the pattern.

## Second trap: the carousel recycles rows

Rows come from a pool and rebind to different tuples as you scroll
(`ensureVisibleCarouselRows` / `bindCarouselRow`). A one-shot "walk every `.carousel-thumb` and add a
class" pass — what the PR does — leaves a recycled row showing a highlight belonging to a row you
scrolled past. **Selection state must be applied in `bindCarouselRow`**, so a row paints the right
outline every time it binds.

## Third trap: the saved folder must not become a modality

`.selection_NN` sits next to the modality folders, so a naive scan makes it a modality column full of
the user's own saved images.

The PR guesses — a folder named `selection` holding under half the median file count is assumed to be
output. **Do not port that.** It silently deletes a real modality that happens to be sparse and
happens to be named `selection`, and it would drop a path listed explicitly in a `.imagecompare`
file, contradicting `docs/session-files.md`.

Use a deterministic rule instead. Two candidates, decide in the round:
1. **The leading dot.** Skip dot-directories when scanning for modalities. Cheap, conventional, and
   the reason the name starts with one.
2. **The crop mechanism.** `docs/tuple-matching.md` already deprioritises our own output as *rule 1*
   of the tie-break, with the reasoning written down. Reuse it if the dot alone is not enough.

State which, and whether an explicitly listed `.selection_NN` path in a session file should be
honoured as a modality (the user asked for it by name) or still skipped.

## Shape of the work

- Selection state + visuals + key handling → `src/webview/main.ts`, with the selection rules
  (toggle, rectangle, what a reorder does) in a **pure module** like `webview/modalityVisibility.ts`
  so Layer 1 can test them.
- The save is a **write**, so it needs a message type in `types.ts`, a pure `.selection_NN` planner,
  and a shared flow over injected IO in the shape of `cropFlow.ts` — both hosts implement the IO,
  `vscode.workspace.fs` on one side and the FSA handle on the other.
- Alt+S must fail gracefully where the folder is read-only (the standalone's FileList backend, and
  Firefox/Safari generally) — the same check `performCrop` already makes.

## Acceptance

- Selection survives `[` / `]`, an arrival and a deletion, each pinned by a test that mutates the
  grid and asserts the same *images* are still selected.
- A scrolled-away-and-back row paints the correct outline (pooled-row rebind test).
- `.selection_NN` numbering is a pure function with the same test shape as `comparison_NN`.
- A `.selection_NN` folder in the tree does not appear as a modality, and the rule that achieves that
  is deterministic and stated in `docs/tuple-matching.md`.
- Read-only backends refuse with a message, not a silent no-op.
