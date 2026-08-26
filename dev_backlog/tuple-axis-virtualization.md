# Backlog: virtualize the tuple axis everywhere except the DOM

**Status: not started.** Raised 2026-08-26. Sibling of
[`carousel-column-virtualization.md`](carousel-column-virtualization.md), which covers the *modality*
axis; this one covers the *tuple* axis.

## Start here, because it is counter-intuitive

**The carousel's tuple axis is already virtualized in the DOM.** `ensureVisibleCarouselRows`
materializes rows from a pool sized `ceil(viewH / 14) + 2 * OVERSCAN + 2`, and rebinds them as you
scroll. That part is done and works.

**Everything else along the tuple axis is fully materialized**, and that is what this item is about:

| what | scale on the field grids |
|---|---|
| the `init` message payload | 5.2 MB for 265 x 136; 832 KB for 746 x 10 |
| `tuples` in the webview | one entry per tuple, always |
| the thumbnail plan | one slot per tuple x modality, planned up front — **36,040** on the 265 x 136 grid |
| `loadedTuples` image cache | grows with what you visit; no eviction |
| `ThumbUrlCache` | one blob per swept slot, forever — its own item |
| `winners` | one entry per vote, bounded by user action |

So opening a large comparison costs a multi-megabyte message, a full slot plan, and a full tuple
array before a single thumbnail is drawn. Measured open times on 265 x 136: `scan=8759ms`,
`init=371ms/5.2MB`, and a sweep of 36,040 slots that ran for over two minutes.

## What is actually worth fixing, in likely order

1. **The slot plan.** `planThumbnails` enumerates every slot at open. Nothing needs slots for tuple
   40,000 before the user has scrolled past tuple 100. A generator or a windowed plan would make open
   time independent of grid size — but the `sweep-covers-every-slot-once` invariant is fuzz-pinned
   and exists precisely because this enumeration is total. Any change here must keep that guarantee,
   and that is the hard part, not the plumbing.
2. **The `init` payload.** 5.2 MB of tuple metadata before first paint. Sending a window and
   streaming the rest would cut time-to-first-thumbnail. Check what the webview actually needs at
   open — the carousel wall is sized arithmetically, so it may need only a count and the visible
   band.
3. **`loadedTuples`.** An unbounded cache of decoded images, one entry per visited tuple. Same shape
   as the `ThumbUrlCache` problem and probably the same fix: evict on unbind.

## Measure before building any of it

The honest position is that we know the *sizes* and not the *costs*. Before changing anything:

- Where does open time actually go on 265 x 136? `scan` was 8.8 s of the 12 s open — that is disk
  traversal, not tuple materialization, and no amount of virtualization touches it.
- What does the renderer actually hold? The 1.48 GB figure in the column item is an upper bound,
  not a measurement.
- Does a user with 265 tuples suffer, or only one with 40,000? If the answer is "nobody has hit it",
  this item is a preparation for a problem we do not have, and saying so is a legitimate outcome.

## Traps

- **`sweep-covers-every-slot-once` is the constraint that makes (1) hard.** It is fuzz-pinned across
  thousands of seeds and has been rewritten twice. A windowed plan must still dispatch every slot
  exactly once as the window moves, including under re-aim and `putBack`.
- The row pool is sized for the *smallest possible* row height (14 px) deliberately — a pool-size
  change remaps the whole ring and rebinds every row, a visible hitch mid-resize
  (`webview/main.ts:1526`). Do not "optimize" that away while nearby.
- This interacts with the column item: fixing both at once means two axes of virtualization in one
  cursor. Do them separately and measure between.

## Acceptance

- Open time and time-to-first-thumbnail are measured before and after on 265 x 136 and 746 x 10, and
  published in `docs/loading-architecture.md`.
- Whatever becomes windowed keeps `sweep-covers-every-slot-once`, proven by the existing fuzz extended
  to a moving window.
- If the measurement says the current behaviour is fine at realistic sizes, the item is closed with
  the numbers recorded rather than implemented.
