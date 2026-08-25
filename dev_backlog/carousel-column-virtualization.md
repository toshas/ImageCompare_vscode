# Backlog: the carousel virtualizes rows but not columns

**Status: not started.** Found 2026-08-25 while diagnosing a window crash on a 265 x 136 grid
(36,040 images: 265 tuples x 136 modality columns, from an experiment sweep).

## NOT the crash cause — read this first

The window crash that surfaced this was **VS Code's text search**, not ImageCompare: the Crashpad
minidumps carry a `v8-oom-stack` annotation pointing at `addMatch -> handleFindMatch ->
$handleFileMatch`, i.e. `findTextInFiles` results accumulating in the renderer. It has recurred ~30
times since 2026-08-16, long before this grid existed. Do not open this item expecting to fix a
crash.

What follows is a real defect found *while looking*, and it is a plausible **contributor** to heap
pressure in the same renderer — but it has never been shown to be the proximate cause of anything.
Fix it on its merits.

## The defect

`ensureVisibleCarouselRows` virtualizes **rows** from a pool. `bindCarouselRow` then materializes
**every modality** in each bound row. Columns are not virtualized at all. At 10 modalities nobody
notices; at 136 it is the dominant cost, and the sizing rules make it compound in the wrong
direction.

Measured on the field grid (`grid=265x136`, viewport ~900px):

| quantity | value | source |
|---|---|---|
| tile size | `availableWidth / numModalities` = 410/136 = 3.0px, floored to **12** | `webview/main.ts:1365-1368` |
| row height | = tile size = 12px (+2 gap = 14) | same |
| row pool | `ceil(viewH/14) + 2*OVERSCAN(3) + 2` = **73 rows** | `webview/main.ts:1527` |
| tiles materialized | 73 x 136 = **9,928 `<img>`** | product of the two above |
| thumbnail pixels | `thumbnailSize(100) * 2` = **200 x 200** | `imageCompareProvider.ts:1032` |
| decoded RGBA if all are live | 9,928 x 200 x 200 x 4 = **1.48 GB** | arithmetic |
| painted size of each tile | **12 x 12 px** | the floor above |
| overdraw | **278x** per tile | 200x200 / 12x12 |

**The compounding is the interesting part.** More modalities -> smaller tiles -> shorter rows ->
*more rows* in the pool -> more tiles materialized. The 12px floor that keeps narrow columns visible
is the same constant that maximises the row count, so the two axes reinforce instead of trading off.
The pool is deliberately sized for the smallest possible row (the comment at `:1526` explains why: a
pool-size change remaps the whole ring and rebinds every row, a visible hitch mid-resize), which is
correct in isolation and worst-case here.

Note the 1.48 GB figure is an upper bound — it assumes every materialized tile holds a decoded
bitmap simultaneously. Chromium discards decoded data under pressure and the tiles are tiny, so the
true resident cost is unknown and **must be measured before anyone claims a saving.**

## Directions, not a decision

1. **Virtualize columns too.** The honest fix and the largest change. A row would bind only the
   column range on screen, mirroring what the row pool already does.
2. **Decouple row height from tile width.** The floor is what maximises the row pool; a minimum row
   height independent of tile width breaks the compounding without touching column binding.
3. **Ask for a tile-appropriate thumbnail.** Decoding 200x200 to paint 12x12 is waste no matter how
   many tiles there are. The wire cost is already small (~3.2 KB/thumb measured); this is about
   decode and resident bitmap, not bandwidth.

(1) and (2) are alternatives; (3) is independent and probably the cheapest real win.

## Acceptance

- A grid with >=100 modalities materializes a tile count bounded by the **viewport**, not by the
  modality count.
- The bound is pinned by a test on the real sizing/binding logic, with the count derived from
  external literals rather than from the implementation.
- Resident renderer memory on the 265x136 grid is measured before and after, and the number is
  published in `docs/loading-architecture.md`. If the saving is not material, say so and close the
  item rather than shipping the change.
