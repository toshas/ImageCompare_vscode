# Backlog: ThumbUrlCache is unbounded

**Status: not started.** Found 2026-08-25 alongside
the column-virtualization work (executed; `docs/loading-architecture.md: columns-virtualize-like-rows`), diagnosing a window crash
on a 265 x 136 grid (36,040 images).

## NOT the crash cause

Same caveat as its sibling: the crash was VS Code's text search OOM-ing the renderer
(`v8-oom-stack` -> `addMatch` / `$handleFileMatch`), recurring ~30 times since 2026-08-16. This is a
real defect found while looking, not the thing that killed the window.

## The defect

`src/webview/thumbUrlCache.ts` owns every carousel thumbnail's object URL and exists specifically to
prevent a blob leak — it tracks `liveCount` and revokes on replace and on delete, and the invariant
`thumb-url-owned-by-cache` covers that. What it has no notion of is **capacity**: the backing `Map`
grows once per distinct slot and is only ever shrunk by an explicit `delete`.

So a panel that sweeps N slots retains N blobs for the panel's lifetime, whether or not those tiles
are anywhere near the viewport. On the field grid:

- 36,040 slots x ~3.2 KB per thumbnail (measured: 8.4 MB posted for 2,671 thumbs) ~= **110 MB**
  of blob backing store, none of it reachable on screen, none of it releasable.
- The webview shell has no eviction trigger of any kind: not on scroll, not on re-aim, not on
  memory pressure.

This is bounded by the grid, so it is not a leak in the "grows without limit" sense — it is a
retention policy of "everything, forever", which happens to be indistinguishable from a leak once
the grid is large enough.

## What makes it non-trivial

The class exists to get revocation *right*, and the ordering is delicate: `set` deliberately points
the map and the tile at the successor **before** revoking the superseded url, because revoking first
briefly leaves a tile pointing at a dead blob. An eviction path has the same hazard with worse
timing — evicting a url whose `<img>` is still bound repaints that tile as broken, which is exactly
what `empty-tile-never-broken` and the `handleThumbDecodeFailure` placeholder exist to prevent.

So eviction must be driven by **what is bound**, not by insertion order alone. A naive LRU over
`Map` iteration order will evict tiles that are on screen during a fast scroll.

## Directions

1. **Evict on unbind.** The row pool already knows when a row stops being bound to a tuple
   (`carouselRowBound`). That is the natural signal and it cannot evict a bound tile by
   construction.
2. **LRU with a bound-set guard** — a capacity, plus a refusal to evict any key currently bound to a
   pooled row. More general, more moving parts.
3. **Do nothing, and say so.** 110 MB on a 36,040-slot grid may simply be acceptable. If so, the
   fix is one line of docs recording the retention policy as deliberate, plus a number, so the next
   person does not re-derive this.

(1) is the cheapest correct option and composes with column virtualization, which would make
unbinding far more frequent.

## Acceptance

- Retained blob count is bounded by something viewport-shaped, not by grid size — or the retention
  is explicitly documented as unbounded-by-design with the measured cost.
- `liveCount` (already exposed for exactly this purpose) is asserted in a test that fills more slots
  than the bound and checks the count settles.
- No tile is ever repainted broken by an eviction: pin it, because this is the failure mode the
  class was written to avoid and the one an eviction path reintroduces.
- Mutation entry if a bound is added — a silently raised or removed cap must fail something.
