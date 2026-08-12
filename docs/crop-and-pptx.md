# Crop and PPTX Export

How a rectangle drawn on one image becomes a set of crops across every modality, how a crop
remembers where it came from, and how the exporter reassembles that into callout slides.

Code: `webview/crop.ts` and `webview/main.ts` (draw + send), `imageCompareProvider.ts`
(`handleCropImages`, `getNextCropNumber`, `handleExportPptx`), `thumbnailService.ts`
(`getImageDimensions`, `cropImage`, `capSlideImage`, `readCropMetadata`, `parseExifDescription`), and `pngText.ts` —
the pure, `vscode`-free wire-format module `thumbnailService.ts` imports (with the test):
`CROP_RECT_KEYWORD`,
`encodeCropMeta`/`parseCropMeta`, `pngInjectText`/`pngReadText`, and `crc32` (test-only).

Pinned by `test/unit/pngTextChunk.test.ts` (Vitest; imports the real `pngText.ts`); see [Testing](#testing).

## The crop coordinate contract

A crop is drawn on **one** image and applied to **all** modalities of the tuple. Those modalities
need not share a resolution (a 4K render next to a 1080p baseline is normal), so a pixel rectangle
is only meaningful relative to the image it was drawn on. Copying those pixel numbers to a
different-sized sibling crops the wrong region — silently, and plausibly enough to go unnoticed.

The rectangle therefore crosses three spaces:

1. **Screen → displayed-image pixels** (`crop.ts:screenToImage`). The rect lives in the pixel space
   of the modality currently on screen, inverted through `baseScale * zoom` plus pan. Everything
   the overlay stores and re-renders is in this space, so the rect stays glued to image content
   while the user zooms and pans. The viewer's usable width subtracts `carouselOffset` — the
   carousel overlays the viewer element rather than shrinking it, so its bounding rect lies.
2. **Pixels → relative 0–1** (`handleCropImages`), dividing by the `srcWidth`/`srcHeight` the
   webview sent. This is the only resolution-independent form, and the only form that may cross
   between modalities.
3. **Relative → each modality's own pixels**, re-multiplying by that file's true dimensions from
   `getImageDimensions()`, then clamping to bounds. A rect that scales to nothing is skipped, not
   an error.

`srcWidth`/`srcHeight` come from the decoded image, not from disk: `handleCropConfirm` sends
`currentImage.width/height`, which the webview took from `img.naturalWidth`/`naturalHeight`. For
browser-decodable formats the extension deliberately never ran Sharp on the visible load and sends
`0`/`0` for the dimensions (see `docs/image-backends.md`), which costs nothing because the webview
prefers the decoded image unconditionally — `img.naturalWidth || message.width`, the wire dims being
only the fallback — and `naturalWidth` also already accounts for EXIF orientation. The extension does not trust these numbers for the extraction itself: it re-reads
true dimensions per modality via Sharp/Jimp. The webview's numbers only ever serve as the
denominator that makes the rect relative — including for the drawn-on modality itself. If the two
ever disagree (EXIF rotation being the live risk), the crop scales rather than shifts.

What is *not* preserved: aspect ratio. Rounding is per-modality and independent, so two modalities'
crops can differ by a pixel. That is intended — matching the region beats matching the size.

## One filename for all modalities

The output basename is the **tuple** name, not the source file's name, so every modality writes
`{tupleName}_cropNN.png` into its own directory, and `handleCropImages` routes each written file
straight through `handleFileCreated`, which re-matches them into a single new tuple — eagerly, not
via the watcher, which never fires on network mounts (`docs/file-watching.md`:
`self-writes-never-wait`). Using per-file basenames would scatter the crops across N tuples of one
image each.

The crop number is resolved once for all modalities: `getNextCropNumber` (= max existing + 1) runs
against the directory of every image *the tuple actually has* (`tuple.images` is sparse) in parallel,
and the highest wins, then that one number is reused
everywhere. This is what keeps the names identical, and taking the max rather than the first
directory's number is what stops a directory that is out of step — a cancelled crop leaves some
behind — from having an existing crop overwritten; the cost is a gap in the numbering of the ones
that were behind. There is still no locking — two crops confirmed in the same instant would race to
the same number.

`handleCropImages` then fans out across modalities with `Promise.all`, each modality one pooled task
at `EXPORT`. The per-modality cost is *two* full-resolution reads, not one: `getImageDimensions`
reads and parses the file for its true dimensions, then `cropImage` reads it again to extract (so a
`.ppmx` is parsed twice), before the single extract-and-encode. See `docs/loading-architecture.md`,
"Crop and PPTX export: pooled at `EXPORT`", for how they are scheduled and what they cost.

### `_cropNN` is a cross-file contract

`handleCropImages` writes `_crop${String(n).padStart(2, '0')}`. `fileService.ts` matches
`/_crop\d+$/` to **deprioritize** crop files as tuple-match references (`docs/tuple-matching.md: crop-never-beats-noncrop`), `handleExportPptx` uses `^…_crop\d+$` to pair crops with parents, and `getNextCropNumber` reads
the same format in-file to find the next free number.
The writer's format and those readers' patterns must keep agreeing. Break the agreement and nothing
throws: crops start winning matches away from originals, and tuples quietly bind the wrong files.
Zero-padding, by contrast, buys nothing inside this codebase: every sort that *orders* a `_cropNN`
name is natural (`naturalCompare` in `watcherLogic.ts`, `localeCompare(…, { numeric: true })`,
which `fileService.ts` imports as `naturalSort`) — the two
`tuple.images.sort` calls in `imageCompareProvider.ts` order by modality index and never look at the
name — and every reader parses `\d+`, so `_crop2` beside `_crop10` would still order and parse
correctly. (The
codebase does hold one *plain* `localeCompare` — `modalityInsertIndex` in `watcherLogic.ts`,
placing a new mode-1 modality column alphabetically — but it orders modality *directory* names, which
never carry a `_cropNN` suffix.) Keep writing it padded
anyway — it is what keeps the names in order for anything *outside* that sorts them plainly, and the
invariant below pins it.

## Crop metadata: written twice, read from either

Every crop carries the region it came from, so the exporter can draw the callout without
recomputing anything.

**Keyword** `ImageCompare:CropRect`, **value** `x,y,w,h,srcW,srcH` — comma-separated integers,
`x,y,w,h` in the *source* image's pixels, `srcW,srcH` that source's full dimensions. The writer
emits integers only; the readers are looser, and differently so. `parseCropMeta` (the `tEXt` side,
and the final parser on both paths) enforces exactly six comma-separated numeric fields — not
integer-ness. The EXIF-side marker scan (`parseExifDescription`) consumes only the `[\d,]` run after
the marker, stopping at the first other character, then feeds that run to `parseCropMeta`. It is a
wire format — the companion standalone HTML tool reads
and writes it too — so do not repurpose fields or append a seventh.

The Sharp path writes it twice — EXIF `ImageDescription` (as `ImageCompare:CropRect=<value>`) *and*
a PNG `tEXt` chunk. The Jimp path writes only the `tEXt` chunk, because Jimp cannot write EXIF at
all. Hence the rule (`metadata-written-twice` of `docs/image-backends.md`): the tEXt chunk is always present and
is the cross-tool contract; EXIF is a Sharp-path bonus, and readers must accept either.
`readCropMetadata` tries EXIF first and falls back to `tEXt`, so a crop written by either backend —
or by the HTML tool — reads back the same. Dropping the redundant tEXt write on the Sharp path
would break the HTML tool and Jimp-written crops in one go.

`pngInjectText`/`pngReadText` walk the real chunk structure (length/type/data/CRC) rather than
assuming offsets, and insert before `IEND`, so injection composes: a second chunk can be added to
an already-injected file and both remain readable (and Sharp still parses the result).

The EXIF reader is deliberately not an EXIF parser. `parseExifDescription` searches the raw EXIF
buffer for the literal `ImageCompare:CropRect=` marker and consumes the following `[\d,]` run. It
works because the value is ASCII digits and commas and the marker is unique; it would not survive a
value containing anything else.

`readCropMetadata` calls `sharp(buffer).metadata()` directly, bypassing `createSharpInstance()`.
That is a deliberate exception to `ppmx-through-helpers` of `docs/image-backends.md`, safe only because crops
are always written as PNG and PPMX therefore never reaches this call. Widen its inputs and it must
move behind the helper.

## PPTX: pairing parents with crops

The webview exports only voted tuples, and the exporter's job is to guess what the vote *meant*.
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

### Why the layout negotiates instead of fixing positions

A crop slide is the crop image plus a small full-image thumbnail bottom-right, with a red rectangle
marking the region — placed from the `CropRect` metadata scaled into the thumbnail (`thumbW / srcW`),
the exporter's only way to know what was cropped.

The callout must not sit on top of the crop. `computeCropLayout` does a contain-fit then negotiates:
shrink the main image leftward to clear the thumbnail; if that costs too much of its area, shrink the
thumbnail instead; if even that is too expensive, accept the overlap rather than ship an unreadably
small image. Keep the ordering (shrink main → shrink thumb → accept overlap) and the priority (main-image
legibility first); the thresholds are tuned, not derived — do not read the constants as meaningful.

Output is `comparison_NN.pptx` in the parent directory of the modality folders, numbered max+1 —
same "scan and increment" pattern as crops, and the same absence of locking; the completion
notification carries a Reveal in Explorer button. The deck is built to a single buffer and written once via
`workspace.fs`, and only then does the completion notification fire — a deck opened on the
notification must be the whole deck.

## Testing

`test/unit/pngTextChunk.test.ts` (Vitest) imports the real `pngText.ts` (the shared module the crop
code also uses), but only `crc32`, `pngInjectText` and `pngReadText`: it covers the `tEXt` round-trip
and the CRC. Its crop-format case checks the six-integer value by hand-splitting the string it injected, so
`encodeCropMeta`/`parseCropMeta` — the codec that actually produces and consumes that value — are
untested, as are the coordinate contract, the EXIF path, `readCropMetadata`, and all of PPTX export.

## Invariants

- **`deck-images-bounded`** — every image placed on a slide is downscale-capped (2560px longest side,
  never enlarged) and JPEG-recompressed at quality 85 by whichever backend is available — Sharp, or
  `ThumbnailService.capSlideImage` (Jimp) when Sharp is absent — never embedded at full resolution.
  The one exception is the no-backend last resort: when Sharp and Jimp both fail to load (already a
  hard-error state for thumbnails), original bytes pass through uncapped. Not a quality preference:
  pptxgenjs zips with jszip (3.10.1 installed), whose *read* path handles ZIP64 (`lib/signature.js`,
  `lib/zipEntries.js`) but whose `lib/generate/` write path contains no ZIP64 code at all, so a deck
  it writes whose media crosses the 4 GB zip offset limit is structurally corrupt — PowerPoint
  "repairs" it by dropping the trailing entries, which read as "images missing from the last
  slides". A slide is 10 inches wide; full resolution buys nothing.

- **`relative-coords-only`** — a crop rect only crosses modalities in relative (0–1) form. Pixel
  coordinates are valid only against the image whose dimensions produced them. This binds the webview
  too: the overlay's rect is stored in the drawn image's pixels, so switching modality under an open
  rect re-maps it relatively before drawing — without that, a same-aspect modality at another
  resolution renders the stale pixel rect at the wrong size.
- **`srcdims-are-denominator`** — `srcWidth`/`srcHeight` from the webview are a denominator, never an
  extraction size. True per-modality dimensions are always re-read from disk; the webview's come from
  the decoded image's `naturalWidth`/`naturalHeight`.
- **`shared-crop-filename`** — all modalities of one crop share one filename, built from the tuple
  name with a single crop number resolved once, so the watcher re-groups them into exactly one tuple.
- **`cropnn-writer-reader-match`** — the `_cropNN` writer format keeps matching every `_crop\d+`
  reader — `fileService.ts`'s reference deprioritization, the PPTX parent/crop pairing, and
  `getNextCropNumber`'s own scan for the next free number. Zero-padded, decimal, at the end of the
  basename.
- **`croprect-six-integers`** — the `CropRect` value stays `x,y,w,h,srcW,srcH`, six integers, in
  source-image pixels. Both the exporter and an external tool parse it. (That it is written to both
  EXIF and `tEXt`, and that `readCropMetadata` may use a bare `sharp()`, are `metadata-written-twice`
  and `ppmx-through-helpers` of `docs/image-backends.md`.)
- **`one-slide-per-region`** — a region never gets two slides. Crop slides and a full-image slide are
  mutually exclusive for the same parent, because the parent only emits crop slides when no child was
  voted. The vote does *not* by itself pick the slide type: a voted parent with unvoted crops yields
  crop slides (one per child), and a voted crop whose parent tuple is gone yields a plain solo slide —
  `findParentTuple` returns -1 and there is no image to draw the callout on. **A voted crop is never
  shown without its parent's context** whenever that parent still exists.
- **`callout-from-metadata`** — the callout thumbnail's red rectangle comes from metadata, not from
  re-deriving the region by comparing images.
- **`crop-needs-viewport`** — crop mode is never entered without a decoded current image. The two
  handlers that can create or resize a rect — `handleCropMouseDown` and `handleCropMouseMove` — bail
  on a null viewport, so entering anyway yields a mode that looks active (overlay up, button lit)
  while drags fall through to pan. (`handleCropMouseUp` and `handleCropKeyDown` carry no such guard
  and need none: with the other two bailing, no `cropRect` can exist for them to act on, so they are
  inert — bar `Escape`, which still leaves the mode.) The `missing` sentinel counts as no image: it is truthy
  but carries no dimensions, so it would map every rect to `NaN` and silently discard it. Enforced by
  the compiler — `enterCropMode`'s `viewport` parameter is required, so an unguarded call site fails
  the build rather than shipping a dead mode.
