# Crop and PPTX Export

How a rectangle drawn on one image becomes a set of crops across every modality, how a crop
remembers where it came from, and how the exporter reassembles that into callout slides. The PPTX
button is offered only where the host can hand the user a file (`exportPptx` in `HostCapabilities`;
a Claude-artifact comparison cannot — `docs/standalone.md`, "Publishing a comparison").

Code:
- `webview/crop.ts` and `webview/main.ts`: draw + send.
- `cropFlow.ts` (`performCrop`): the whole confirm-to-`cropComplete` sequence over per-product IO.
- `cropPlan.ts` (`nextCropName`, `toRelativeRect`, `scaleAndClampRect`) and `pptxDeck.ts`
  (`buildDeck`, plus `exportDeck`: the name/build/save/answer sequence over per-product IO): pure,
  `vscode`-free modules the provider and the standalone build share (`docs/standalone.md`).
- `imageCompareProvider.ts` (`handleCropImages`, `handleExportPptx`): the provider's IO tables for
  those two flows.
- `thumbnailService.ts` (`getImageDimensions`, `cropImage`, `capSlideImage`, `readCropMetadata`,
  `parseExifDescription`).
- `pngText.ts`: the pure, `vscode`-free wire-format module `cropFlow.ts`, `thumbnailService.ts` and
  the test import (`CROP_RECT_KEYWORD`, `encodeCropMeta`/`parseCropMeta`, `pngInjectText`/`pngReadText`,
  and `crc32`, test-only).

Pinned by the suites in [Testing](#testing).

## The crop coordinate contract

A crop is drawn on **one** image and applied to **all** modalities of the tuple. Those modalities
need not share a resolution: a 4K render next to a 1080p baseline is normal. A pixel rectangle is
only meaningful relative to the image it was drawn on. Copying those pixel numbers to a
different-sized sibling crops the wrong region, silently and plausibly enough to go unnoticed.

The rectangle therefore crosses three spaces:

1. **Screen → displayed-image pixels** (`crop.ts:screenToImage`). The rect lives in the pixel space
   of the modality currently on screen, inverted through `baseScale * zoom` plus pan. Everything
   the overlay stores and re-renders is in this space, so the rect stays glued to image content
   while the user zooms and pans. The viewer's usable width subtracts `carouselOffset`: the
   carousel overlays the viewer element rather than shrinking it, so its bounding rect lies.
2. **Pixels → relative 0–1** (`toRelativeRect` in `cropPlan.ts`, called once by the shared
   `performCrop` flow), dividing by the `srcWidth`/`srcHeight` the webview sent. This is the only
   resolution-independent form, and the only form that may cross between modalities.
3. **Relative → each modality's own pixels**, re-multiplying by that file's true dimensions from
   `getImageDimensions()`, then clamping to bounds. A rect that scales to nothing is skipped, not
   an error.

`srcWidth`/`srcHeight` come from the decoded image, not from disk: `handleCropConfirm` sends
`currentImage.width/height`, which the webview took from `img.naturalWidth`/`naturalHeight`. For
browser-decodable formats the extension does not run Sharp on the visible load, so it sends `0`/`0`
for the dimensions (see `docs/image-backends.md`). This costs nothing. The webview always prefers the
decoded image (`img.naturalWidth || message.width`), the wire dims being only the fallback.
`naturalWidth` also accounts for EXIF orientation.

The extension does not trust these numbers for the extraction itself: it re-reads true dimensions
per modality via Sharp/Jimp. The webview's numbers only serve as the denominator that makes the rect
relative, including for the drawn-on modality itself. If the two ever disagree (EXIF rotation being
the live risk), the crop scales rather than shifts.

What is *not* preserved: aspect ratio. Rounding is per-modality and independent, so two modalities'
crops can differ by a pixel. That is intended — matching the region beats matching the size.

## One filename for all modalities

The output basename is the **tuple** name, not the source file's name, so every modality writes
`{tupleName}_cropNN.png` into its own directory. `performCrop` lands each written file eagerly
through the product's `arriveFile` io, not via the watcher, which never fires on network mounts
(`docs/file-watching.md`: `self-writes-never-wait`). The provider's routes straight through
`handleFileCreated`, which re-matches them into a single new tuple. Per-file basenames would scatter
the crops across N tuples of one image each.

The crop number is resolved once: `nextCropName` scans the directory listing of every image *the
tuple actually has* (`tuple.images` is sparse) and takes the highest number + 1. Every modality
reuses that one number, which keeps the names identical. Taking the max, not the first directory's
number, stops an out-of-step directory (a cancelled crop leaves some behind) from having an existing
crop overwritten. The cost is a gap in the numbering of the ones that were behind. There is still no
locking: two crops confirmed in the same instant would race to the same number.

`performCrop` then invokes every modality's work unit eagerly through the product's `schedule` io;
both products pool each one at `EXPORT`. The per-modality cost is *two* full-resolution reads, not
one. The dimensions read (`getImageDimensions` in the provider, a browser decode in the adapter)
parses the file for its true dimensions. The render reads it again to extract (so a `.ppmx` is parsed
twice), before the single extract-and-encode. See `docs/loading-architecture.md`, "Crop and PPTX
export: pooled at `EXPORT`", for how they are scheduled and what they cost.

### `_cropNN` is a cross-file contract

`nextCropName` in `cropPlan.ts` writes `_crop${String(n).padStart(2, '0')}`. The invariant
`cropnn-writer-reader-match` below lists every reader. The writer's format and those readers'
patterns must keep agreeing. Break the agreement and nothing throws: crops start winning matches away
from originals, and tuples quietly bind the wrong files.

Zero-padding buys nothing inside this codebase. Every sort that *orders* a `_cropNN` name is natural:
`naturalCompare` in `watcherLogic.ts` (`localeCompare(…, { numeric: true })`), which `fileService.ts`
imports as `naturalSort`. The two `tuple.images.sort` calls in `imageCompareProvider.ts` order by
modality index and never look at the name. Every reader parses `\d+`, so `_crop2` beside `_crop10`
would still order and parse correctly. Keep writing it padded anyway: it keeps the names in order for
anything *outside* that sorts them plainly, and the invariant below pins it.

## Crop metadata: written twice, read from either

Every crop carries the region it came from, so the exporter can draw the callout without
recomputing anything.

**Keyword** `ImageCompare:CropRect`, **value** `x,y,w,h,srcW,srcH`: comma-separated integers,
`x,y,w,h` in the *source* image's pixels, `srcW,srcH` that source's full dimensions. The writer
emits integers only; the readers are looser, and differently so. `parseCropMeta` (the `tEXt` side,
and the final parser on both paths) enforces exactly six comma-separated numeric fields, not
integer-ness. The EXIF-side marker scan (`parseExifDescription`) consumes only the `[\d,]` run after
the marker, stopping at the first other character. It feeds that run to `parseCropMeta`. It is a wire
format the companion standalone HTML tool reads and writes too, so do not repurpose fields or append a
seventh.

The shared `performCrop` flow injects the `tEXt` chunk once, into whatever bytes the product's
renderer produced. Every crop carries it, whichever backend rendered it: Sharp, Jimp, or the
standalone's canvas. The provider's Sharp renderer (`thumbnailService.cropImage`) *additionally*
writes the same value as EXIF `ImageDescription` (as `ImageCompare:CropRect=<value>`); the Jimp path
cannot write EXIF at all. Hence the rule (`metadata-written-twice` of `docs/image-backends.md`): the
tEXt chunk is always present and is the cross-tool contract. EXIF is a Sharp-path bonus, and readers
must accept either.

`readCropMetadata` tries EXIF first and falls back to `tEXt`, so a crop written by either backend, or
by the HTML tool, reads back the same. Dropping the flow's tEXt injection would break the HTML tool
and Jimp-written crops in one go.

`pngInjectText`/`pngReadText` walk the real chunk structure (length/type/data/CRC) rather than
assuming offsets, and insert before `IEND`, so injection composes: a second chunk can be added to
an already-injected file and both remain readable (and Sharp still parses the result).

The EXIF reader is deliberately not an EXIF parser. It works because the value is ASCII digits and
commas and the marker is unique; it would not survive a value containing anything else.

`readCropMetadata` calls `sharp(buffer).metadata()` directly, bypassing `createSharpInstance()`.
That is a deliberate exception to `ppmx-through-helpers` of `docs/image-backends.md`, safe only because crops
are always written as PNG and PPMX therefore never reaches this call. Widen its inputs and it must
move behind the helper.

## PPTX: pairing parents with crops

The webview exports the voted tuples — or the whole view when nothing is voted (see below) — and
the exporter's job is to guess what the vote *meant*.
A crop and its parent are two rows in the carousel but one idea, so the pairing logic works on
names:

- **A voted tuple whose name strips to an existing parent** (`^(.+)_crop\d+$`) is rendered as a
  crop slide against that parent — even if the parent was never voted for. Voting for the crop is
  taken as voting for the region, and a crop shown without its context is close to meaningless.
  "Existing" is load-bearing: `findParentTuple` returns -1 when no tuple carries the stripped name,
  so an **orphan crop** — parent deleted, or never scanned — falls through to the branches below and,
  having no crop children of its own, ships as a plain solo slide. There is no parent image to
  draw a callout on.
- **A voted parent with exactly one crop child, itself unvoted**, is auto-expanded into that crop
  slide. The user almost certainly cropped to make a point; showing the untouched full image would
  throw that away.
- **A voted parent with several crop children, none of them voted** — ambiguity resolved by
  breadth: one crop slide per child, per modality, so a voted parent can produce *only* crop slides
  and no full-image slide at all.
- **A voted parent whose crop child is also voted** falls back to a plain full-image slide,
  precisely because the crop already gets a slide of its own — otherwise the region appears twice.
- **A voted parent with no crop children** gets the plain full-image slide. The ordinary case.

Slides are emitted per modality in the user's display order, and the caption marks the winner; the
pairing above decides *which* slides exist, not what is on them (`one-slide-per-region`).

### No votes exports the whole view

A click with zero voted tuples sends every tuple in display order with a `null` winner per tuple —
the wire type (`(OriginalModalityIndex | null)[]`) always permitted this, and a `null` winner
simply renders no winner mark in the caption. The old behavior was a silent `return`: a user who
never voted clicked PPTX and nothing observable happened, ever.

From the click until the provider answers, the button wears a spinner overlay and further clicks
are ignored. This is not cosmetic: each `exportPptx` re-reads and re-encodes every exported image
through the shared work pool, so concurrent re-click exports multiply minutes of work and race on
the output filename. The busy flag can only be trusted because of `export-always-answers` below.

### Why the layout negotiates instead of fixing positions

A crop slide is the crop image plus a small full-image thumbnail bottom-right, with a red rectangle
marking the region — placed from the `CropRect` metadata scaled into the thumbnail (`thumbW / srcW`),
the exporter's only way to know what was cropped.

The callout must not sit on top of the crop. `computeCropLayout` does a contain-fit then negotiates:
shrink the main image leftward to clear the thumbnail; if that costs too much of its area, shrink the
thumbnail instead; if even that is too expensive, accept the overlap rather than ship an unreadably
small image. Keep the ordering (shrink main → shrink thumb → accept overlap) and the priority (main-image
legibility first); the thresholds are tuned, not derived — do not read the constants as meaningful.

Output is `comparison_NN.pptx` in the export directory that `exportOutputDir` (`exportTarget.ts`)
picks, numbered max+1. This is the same "scan and increment" pattern as crops, with the same absence
of locking. The webview's completion notice carries the reveal action. The provider builds the deck
to a single buffer and writes it once via `workspace.fs`. Only then does `pptxComplete` go out, so a
deck opened from the notice is the whole deck.

## Testing

`pngTextChunk` pins the `tEXt` round-trip and the CRC. `cropFlow` pins the whole crop sequence,
including the value `encodeCropMeta` writes and the injected chunk. `cropPlan` and `cropRelRect` pin
naming and rect math, and `cropMath` pins the screen mapping. `pptxDeck`, `exportDeck` and
`pptxName` pin the export. No test covers `parseCropMeta`, the EXIF path or `readCropMetadata`.

## Invariants

- **`deck-images-bounded`** — every image placed on a slide is downscale-capped (never enlarged)
  and JPEG-recompressed, never embedded at full resolution. The bounds are
  `DECK_IMAGE_MAX_DIM`/`DECK_JPEG_QUALITY` in `pptxDeck.ts` (2560px longest side, quality 85),
  shared by whichever backend runs: Sharp, `ThumbnailService.capSlideImage` (Jimp) when Sharp is
  absent, or the standalone's canvas encode.
  The one exception is the no-backend last resort: when Sharp and Jimp both fail to load (already a
  hard-error state for thumbnails), original bytes pass through uncapped. Not a quality preference:
  pptxgenjs zips with jszip (3.10.1 installed). Its *read* path handles ZIP64 (`lib/signature.js`,
  `lib/zipEntries.js`), but its `lib/generate/` write path contains no ZIP64 code at all. A deck it
  writes with media past the 4 GB zip offset limit is structurally corrupt. PowerPoint "repairs" it
  by dropping the trailing entries, which read as "images missing from the last slides". A slide is
  10 inches wide; full resolution buys nothing.

- **`relative-coords-only`** — a crop rect only crosses modalities in relative (0–1) form. Pixel
  coordinates are valid only against the image whose dimensions produced them. This binds the webview
  too. The overlay's rect is stored in the drawn image's pixels, so switching modality under an open
  rect re-maps it relatively before drawing. Without that, a same-aspect modality at another
  resolution renders the stale pixel rect at the wrong size.
- **`srcdims-are-denominator`** — `srcWidth`/`srcHeight` from the webview are a denominator, never an
  extraction size. True per-modality dimensions are always re-read from disk; the webview's come from
  the decoded image's `naturalWidth`/`naturalHeight`.
- **`shared-crop-filename`** — where the columns are directories (modes 1 and 2), all modalities of
  one crop share one filename. It is built from the tuple name with a single crop number resolved
  once, so the watcher re-groups them into exactly one tuple.

  A **file list** (mode 3) is the exception, and has to be. Its columns can be files in ONE
  directory, where "beside each image" is the same path N times: two concurrent writes, one file,
  and whichever bytes land last. There the name is built from each image's own stem (`shot_a.png` →
  `shot_a_crop01.png`), numbered against that image's own listing. Each name is claimed as it is
  handed out, so two images that reduce to the same stem (`a.png` beside `a.jpg`) number past each
  other. Nothing is lost by not sharing, because nothing re-groups them: a file list is enumerated
  once and does not grow, so its crops land on disk and stay there
  (`docs/session-files.md: folder-of-images-is-a-file-list`).

  The shared flow enforces this rather than each host, and it had to. The provider
  dropped a mode-3 crop through `handleNewFile`'s early return, while the adapter's `arriveFile`
  called the arrival planner unconditionally. One crop gesture produced no new row in one product
  and two single-column rows in the other. Both branches are on `ScanResult.mode` inside
  `performCrop`, never on a host's guess (`docs/session-files.md: mode-is-explicit`).
- **`cropnn-writer-reader-match`** — the `_cropNN` format keeps matching every `_crop\d+`
  reader:
  - `fileService.ts`'s reference deprioritization;
  - the folder enumeration filter (`enumeratedImages` in `cropPlan.ts`,
    `docs/session-files.md: folder-of-images-is-a-file-list`);
  - the PPTX parent/crop pairing;
  - `nextCropName`'s scan for the next free number.

  Zero-padded, decimal, at the end of the basename. The deprioritization and the enumeration filter
  test through `CROP_SUFFIX_RE`, exported from `cropPlan.ts` beside the writer, so the format has one
  regex, not a copy per reader.
- **`croprect-six-integers`** — the `CropRect` value stays `x,y,w,h,srcW,srcH`, six integers, in
  source-image pixels. Both the exporter and an external tool parse it. (That it is written to both
  EXIF and `tEXt`, and that `readCropMetadata` may use a bare `sharp()`, are `metadata-written-twice`
  and `ppmx-through-helpers` of `docs/image-backends.md`.)
- **`one-slide-per-region`** — a region never gets two slides. Crop slides and a full-image slide are
  mutually exclusive for the same parent, because the parent only emits crop slides when no child was
  voted. The vote does *not* by itself pick the slide type:
  - a voted parent with unvoted crops yields crop slides (one per child);
  - a voted crop whose parent tuple is gone yields a plain solo slide: `findParentTuple` returns -1
    and no image exists for the callout.

  **A voted crop is never shown without its parent's context** whenever that parent still exists.
- **`export-always-answers`** — every `exportPptx` received on a live panel is answered with exactly
  one `pptxComplete` or `pptxError`. The shared `exportDeck` flow (`pptxDeck.ts`) enforces this by
  construction. The whole name→build→save sequence runs inside its one try. Any throw becomes the
  single error post, including a missing output directory from the provider's `listExistingNames` io.
  The complete post follows the save unconditionally.

  The flow has no product notification hook at all: what the user is *told* is the webview's, worded
  from the answer it already receives (`docs/standalone.md: affordances-rendered-by-the-webview`). No
  toast can run in here and forge a second one. Both products merely inject `post` and their output
  mechanics; neither owns an answer path. The webview's PPTX button stays busy and refuses clicks
  until an answer arrives, so an io that swallows one bricks the button for the panel's lifetime.

  The only non-answering exit is cancellation (`isCancelled` io). The provider maps it to
  `state.disposed` and `TaskCancelled`, which the pool raises for this key only from
  `onDidDispose`'s `cancel(poolKey)`. With the webview already gone, no answer is owed.
- **`callout-from-metadata`** — the callout thumbnail's red rectangle comes from metadata, not from
  re-deriving the region by comparing images.
- **`crop-needs-viewport`** — crop mode is never entered without a decoded current image. The two
  handlers that can create or resize a rect, `handleCropMouseDown` and `handleCropMouseMove`, bail
  on a null viewport. Entering anyway yields a mode that looks active (overlay up, button lit) while
  drags fall through to pan. `handleCropMouseUp` and `handleCropKeyDown` have no such guard, and need
  none: with the other two bailing, no `cropRect` can exist for them to act on. They are inert, bar
  `Escape`, which still leaves the mode.

  The `missing` sentinel counts as no image: it is truthy but carries no dimensions, so it would map
  every rect to `NaN` and silently discard it. Enforced by the compiler: `enterCropMode`'s `viewport`
  parameter is required, so an unguarded call site fails the build rather than shipping a dead mode.
- **`post-crop-message-order`** — the shared `performCrop` flow (`cropFlow.ts`) owns the sequence.
  After the whole write batch, it lands each saved file in modality order through the product's
  `arriveFile` io. It posts `cropComplete` only after the last arrival, then runs the thumbnail
  hook; full images come only on the webview's `requestImage`. A file list (mode 3) skips both
  the arrivals and the thumbnail hook and posts `cropComplete` alone. There is no row for a crop to
  join, and the hook would otherwise push thumbnails for a tuple that was never added
  (`docs/session-files.md: folder-of-images-is-a-file-list`).

  Only the shared arrival planner (`arrivalPlan.ts`) produces the per-file wire payloads:
  - the first saved file: a *sparse* `tupleAdded` at its sorted insert position (only its own
    modality named, current/winner indices shifted);
  - each further file: a `fileRestored` with `imageInfo`.

  The provider's `arriveFile` reaches it through `handleFileCreated`/`handleNewFile`, and
  the adapter's calls it directly. The demo recorder's host emulation still speaks the sequence by
  hand and cites this key as a reader.
