# Backlog: opening a comparison costs the whole grid, before anything is drawn

**Status: not started.** Raised 2026-08-26 as "tuple-axis-virtualization"; renamed 2026-09-05
because that title said the opposite of the item's own first paragraph and invited exactly the wrong
fix.

## Start here, because the old name was misleading

**The carousel's tuple axis is already virtualized in the DOM**, and so is its modality axis
(`docs/loading-architecture.md: columns-virtualize-like-rows`). `ensureVisibleCarouselRows`
materializes rows from a pool sized `ceil(viewH / MIN_TILE_PITCH) + 2 * OVERSCAN + 2` and rebinds
them as you scroll; each row materializes only the columns on screen. Both axes are done.

This item is about everything along the tuple axis that is **not** DOM, and none of it is windowed.

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
- What does the renderer actually hold? The 1.48 GB figure this used to defer to was an estimate in
  a plan that has since been executed and deleted. There is now a real measurement in
  `docs/loading-architecture.md: columns-virtualize-like-rows` — 27 293 DOM nodes and a 6.7 MB JS
  heap on 265 x 136 — and it is an order of magnitude below that estimate, because the estimate was
  about blob and bitmap residency (`dev_backlog/thumb-url-cache-unbounded.md`), which none of this
  touches.
- Does a user with 265 tuples suffer, or only one with 40,000? If the answer is "nobody has hit it",
  this item is a preparation for a problem we do not have, and saying so is a legitimate outcome.

**One data point already argues that way.** The 265 x 136 grid was profiled in September 2026 for a
scrolling complaint, and the renderer's main thread was spending its time in Paint, Layerize and
Commit — DOM cost — with script at 0.05 ms a call. Nothing in the table above appeared. That says
open cost and steady-state cost are different problems, and only the first is this item's.

## Traps

- **`sweep-covers-every-slot-once` is the constraint that makes (1) hard.** It is fuzz-pinned across
  thousands of seeds and has been rewritten twice. A windowed plan must still dispatch every slot
  exactly once as the window moves, including under re-aim and `putBack`.
- Both pools are sized for the *smallest possible* item (`MIN_TILE_PITCH`) deliberately — a
  pool-size change remaps the whole ring and rebinds everything, a visible hitch mid-resize
  (`ensureVisibleCarouselRows` and `columnPoolSize`). Do not "optimize" that away while nearby.
- The column axis is finished, so that interaction is gone — but its lesson stands: three
  constant-factor fixes landed there before a trace showed the cost was elsewhere. Nothing here
  should be built on the sizes in the table above alone.

## Acceptance

- Open time and time-to-first-thumbnail are measured before and after on 265 x 136 and 746 x 10, and
  published in `docs/loading-architecture.md`.
- Whatever becomes windowed keeps `sweep-covers-every-slot-once`, proven by the existing fuzz extended
  to a moving window.
- If the measurement says the current behaviour is fine at realistic sizes, the item is closed with
  the numbers recorded rather than implemented.
