# Backlog: ask for a thumbnail the size of the tile

**Status: not started.** Split out 2026-09-05 from the column-virtualization plan, which was
executed (`docs/loading-architecture.md: columns-virtualize-like-rows`) and deleted. That plan
listed this as its direction (3), *"independent and probably the cheapest real win"*, and it is the
only one of its three directions still open — so it survives here rather than dying with the file.

## The waste

`imageCompare.thumbnailSize` defaults to 100, and thumbnails are decoded at **2x** it — 200 px on
the longest side. On a wide grid the tile they are painted into is at its **12 px** floor
(`updateCarouselThumbSize`: available width divided by the modality count, `Math.max(12, …)`).

That is a 200x200 bitmap drawn into 12x12: **278x more decoded pixels than any of them can show**.
The cost is not the wire — a thumbnail measures ~3.2 KB — it is decode time and resident bitmap.
Column virtualization cut *how many* tiles decode at once; it did nothing about how big each one is.

## Why it is worth doing now rather than then

Before virtualization this was one of two compounding terms and the smaller one. Now it is the
remaining term on the same path: `images-fill-progressively` keeps a gesture cheap, but the fill it schedules still pays ~2.9 ms per
tile because a blob URL is a resource load; a 12x12 tile that is a canvas blit would not.

## The decision this needs

**Where the size is chosen.** The tile size is a *webview* fact (it falls out of the carousel width
and the modality count) and the thumbnail is produced by the *host* — which is exactly the shape
`docs/standalone.md: host-supplies-data-not-policy` governs. The webview already reports its strip
in `setCurrentModality`/`tupleFullyLoaded`; a tile-size hint belongs there, not in a new message and
not as a host guess.

**What invalidates a cached thumbnail.** `thumbPack.ts` and the disk cache are keyed today without a
size dimension. A resize that changes the tile size must not silently serve, or silently discard, a
whole cache. Decide whether size joins the key or whether one generous size is picked per session.

**Whether it is one size or a ladder.** A resize drag moves the tile size continuously; regenerating
on every frame is worse than the waste it fixes. Quantising to a small ladder (say 32/64/128/256) is
the obvious answer, and it should be stated rather than discovered.

## Traps

- The 2x factor exists for HiDPI. A tile-appropriate size must stay `2 x deviceing pixel ratio`-aware
  or crisp tiles become soft on exactly the displays that noticed.
- `docs/image-backends.md` fixes what the thumbnail pipeline produces; a second size is a change to
  its contract, not only to a call site.
- The full-image path must not be touched. This is about the carousel only.

## Acceptance

- The decoded pixel count for a screenful of tiles on the 265 x 136 grid is measured before and
  after, and published — the same way `columns-virtualize-like-rows` published its table.
- A resize that changes the tile size does not stall on regeneration, and does not serve a stale
  size indefinitely.
- If the saving is not material once virtualization has already cut the tile count, say so and close
  the item rather than shipping the change.
