# Loading Architecture

How ImageCompare gets pixels onto the screen, and the rules that keep it responsive.

Code: `workPool.ts` (scheduling), `transportBudget.ts` (bytes on the wire), `imageCompareProvider.ts` (`sendImage`, `generateAllThumbnails`,
prefetch, the existence sweep), `thumbnailService.ts` (`loadFullImage`, `getThumbnail` — the actual
reads and decodes; the provider only schedules them), `webview/main.ts` (`loadedTuples`, `render`).
Pinned by `test/unit/workPool.test.ts` (Vitest), which imports the real source.

## Why this exists

The viewer used to show sporadic ~10s spinners — not one bug but the absence of scheduling
discipline. Every kind of work (filesystem poll, the whole session's thumbnails, neighbour prefetch,
the on-screen image) ran eagerly and unbounded on one thread and one 4-thread libuv/Sharp pool, FIFO
with no priority; on a network/FUSE mount a *synchronous* existence sweep froze the event loop
outright. The request protocol was separately best-effort: some paths posted nothing on completion,
and the webview never re-asks for a tuple it holds — so a dropped reply = a stuck spinner.

## Principles

Bounded · Prioritized · Cancellable · Identity-checked · Guaranteed-response.

> Scope note on "identity-checked": *image* replies are not identity-*addressed*. No request id is
> echoed back, and `slotMatchesUri` guards only the *cache write*. Addressing is by slot: every image
> *reply* and every thumbnail delivery re-resolves its slot from the enqueued hint, falling back to
> the file's URI. A re-index redirects it, not misfiles it. Prefetch pushes are the
> exception: they post at the enqueued index, and `slotMatchesUri` drops them outright when the slot
> moved.
>
> The residual gap is no longer a misfile. The hint keys on the modality *name* and falls back to an
> exact-URI search, so any slot returned holds that file. What remains is ordering. Two
> in-flight loads for one slot are unordered, so a slower read of older bytes can land last and pin
> the stale frame in the cache. A request id, or a per-slot generation, is the fix if it ever bites.

## The work pool (`workPool.ts`)

One process-wide `WorkPool` (`sharedWorkPool()`) schedules every **display** read/decode: full
images, thumbnails, and the existence poll. The provider keeps it. `workPool.ts` has no node
imports, so the standalone adapter bundles it and runs its own instance (`docs/standalone.md`).
Its size comes from *usable* parallelism:
`availableParallelism <= 2 ? 1 : min(availableParallelism - 1, 4) + 2`, so 1 or 4..6. A 1-2 core
box keeps its single slot: it has no second core to overlap the JS round-trip onto. The ceiling is
libuv's, not the core count's (`pool-width-hides-latency` below). `imageCompare.maxConcurrentReads`
overrides it. Every comparison tab shares it, so N open tabs cannot multiply load.

- **Priorities** (`VISIBLE < SIBLING < EXPORT < PREFETCH < THUMBNAIL < THUMBNAIL_BULK < POLL < SIBLING_TAIL`).
  Ordering is strict: the image on screen never waits behind prefetch, the carousel, or the sweep.
  That holds only because the *request* is re-posted when a slot goes on screen after being asked
  for lower; a queued task is never promoted (`request-rank-upgrades`).

  Ordering governs only the queue; a running task is never interrupted. Speculative ranks
  (`PREFETCH` and below) are therefore capped at `concurrency - 1` running slots (`canStart`). One
  slot always stays clear of speculation. Above concurrency 1, speculative work alone can never
  delay a `VISIBLE` arrival: it finds a slot free unless work ranked above `PREFETCH` holds the rest
  of the pool. At concurrency 1 every reservation is waived, since it would starve a whole class.

  `SIBLING_TAIL` (the current tuple's modalities past the nearest two) is last *and* exempt from
  the fair-share pick below. It is admitted only when no other class has queued work
  (`sibling-tail-never-competes`): "below `PREFETCH`" alone would still outrank `THUMBNAIL_BULK`
  and take half the sweep's slots.

  The courtesy also runs downward, in two forms (`background-trickle` below). `SIBLING`/`EXPORT`
  leave one pool slot to lower classes while any have queued work. *Within* speculation, each freed
  slot goes to the queued class with the fewest running tasks (max-min fair share, ties to the
  higher priority). With two or more speculative slots, a prefetch wave with the sweep and the
  existence poll both queued splits the speculative budget roughly evenly, not freezing the sweep.
  With one, the tie-break degenerates to strict priority (`background-trickle` has the width
  regimes).

  `THUMBNAIL` is a targeted re-request (`sendThumbnails`, `regenerateThumbnail`); "Thumbnails"
  below lists what triggers each. Slot addressing on delivery is in the scope note under
  Principles. The `sendImage` cache-hit branch replies at the enqueued indices, because nothing
  loaded and so nothing moved.

  `THUMBNAIL_BULK` is the open-time sweep, ranked below `THUMBNAIL` so a small, freshly-invalidated
  batch can't queue behind thousands of sweep items. Nothing here is scroll-driven on the *loading*
  side: thumbnails load eagerly for the whole session via the sweep. The carousel DOM is
  virtualized: a recycled pool of ~35 absolutely-positioned rows over an arithmetic wall, so
  scroll, stepping and resize re-layout only what is visible. It is not a native scroll container:

  - stepping jumps exactly one row height with no animation (the grid reads as pixel-stationary;
    only tile content changes)
  - wheel and a custom scrollbar thumb apply the offset directly
  - every row repaint derives from the state maps (`thumbnailUrls`, `winners`); a recycled slot
    must be fully reconstructable from state, never from prior DOM

  No scroll or bind handler requests loading work. `requestThumbnails` is posted on tuple add (that
  row) and on modality add/remove (every row). It is not posted on visibility, nor on tuple delete,
  where the webview re-indexes its own thumbnail map and the extension re-sends nothing.
- **FIFO within a priority and group; round-robin between the groups of one priority.** The FIFO
  half is load-bearing. The sweep submits its slots in dispatch order (nearest row to the user
  first, modality-minor within a row; "The sweep is centre-out" below), so thumbnails *start* where
  the user is looking, below every foreground priority (only the existence sweep's `POLL` ranks
  lower).

  The rotation half keeps *two* panels' sweeps from starving one another ("Two panels sweeping at
  once" below). `submit`'s optional `group` is a fair-share bucket. Work that names no group shares
  one bucket, so a single-bucket class is plain FIFO, exactly the pre-rotation behaviour. Only the
  bulk sweep names a group today (the panel's `poolKey`); every other class is still one FIFO.

  It is FIFO *start* order. With concurrency above 1 and varying decode times, a later item can
  finish first, so the fill is approximate. The sweep's running-slot window bounds the skew:
  `concurrency - 1` (the speculative-rank cap above, waived at concurrency 1).
- **`cancel(key)`** drops queued (not-yet-started) tasks; running tasks always finish. Keys scope
  work per panel (`state.poolKey`) and per prefetch wave (`state.prefetchWaveKey`). Matching is
  exact string equality, so both keys must be cancelled explicitly.
- **Panel keys must be unique for the process lifetime**, hence `nextPanelKey()`'s counter is a
  module global in `workPool.ts`, not per-provider state. The pool outlives any panel. A reused key
  lets a new panel's `cancel(poolKey)` drop an older panel's queued tasks, stranding *its* spinners
  with no error.
- **No aging.** A continuous stream of high-priority work would starve low priority forever. That is
  safe only because every producer here is finite; see the note in `workPool.ts`.

`workPool.test.ts` pins:

- the concurrency cap
- priority + FIFO/seq ordering
- cancellation semantics (keyed items dropped, survivors ordered, running untouched)
- sync-throwing tasks, re-entrancy, and error propagation

### Crop and PPTX export: pooled at `EXPORT`

Both are user-triggered, so they rank above speculation (`PREFETCH` and below) and below what is on
screen. Neither can fan out without bound, as they used to, nor queue ahead of a visible load.
`EXPORT` does *not* buy preemption, and it buys less exclusion than it looks.

A PPTX export is a strictly sequential producer: it awaits each pooled task before submitting the
next. The awaiter resumes one microtask *before* the `.finally` that decrements `active` and pumps.
The export's next task is therefore already queued, at `EXPORT`, when the slot frees. That excludes
others only while consecutive submits sit in the same async function. `addCropSlide`'s return adds
a hop, the pool pumps in that gap, and queued speculation takes the slot. And it holds only *one*
slot of the pool's 1..6, so above concurrency 1 the rest stay open regardless.

A one-off measurement illustrates the (structural) microtask gap; no test pins these sequences, so
they are not a maintained property of the current pool. At cap 1 a same-function loop yielded
`E E E E BULK`, and the same loop through `addCropSlide` yielded `E BULK E E E`. Cap 2 and cap 4
both yielded `E BULK E E E`.

Crop is the fan-out case: `Promise.all` submits one task per modality at once. A wide tuple fills
the foreground budget for a round: the whole pool, or one slot less while background work is
queued (`background-trickle`). The pool is process-global, so this crosses panels. It is bounded,
because every export producer is finite.

**Crop.** The shared `performCrop` flow (`cropFlow.ts`) still invokes every modality eagerly via
`Promise.all`. But each modality's work unit crosses the provider's `schedule` io as one pooled
task, so a wide tuple queues rather than launching every decode at once. Inside a task it is still
*two* full-res reads (`getImageDimensions` then `cropImage`, each re-reading the file) plus one
extract-and-encode. The pool bounds concurrency, not the per-image cost.

**PPTX export.** The deck's `io.loadImage` is pooled per placed image, and `readCropMetadata` once
per crop slide. A placed image costs a full-res decode plus a capped-and-recompressed JPEG re-encode
(`docs/crop-and-pptx.md: deck-images-bounded`): at least once per voted tuple × modality, twice on
crop slides (crop and parent). The worst branch is a voted parent with several unvoted crops: one
slide per crop *per modality*, so 2·N full-res loads per modality rather than one. Long-lived rather
than bursty.

The pool deliberately does **not** cover:

- the base64 of each result, which is synchronous (`docs/image-backends.md`, "Why the sync/base64
  work matters"); a large export is still felt on the extension-host thread
- the zip deflate at the end of an export (inside `pptx.write({ outputType: 'nodebuffer' })`), the
  single largest CPU event of a large export
- the directory listings on the crop and export paths: the pre-crop listings feeding
  `nextCropName` (once per modality, not per crop) and the export's single `readdir` of the output
  directory

The pool exists to bound image reads and decodes (memory, CPU and network round trips per *image*),
not metadata calls. The `fs.watch` probe's `access` 50ms after a rename event is unpooled for the
same reason. Adoption cuts the other way. Reached from the sweep, its `stat` and listings run
*inside* the sweep's own `POLL` task; reached from either watcher, they are unpooled. The sweep's
own `readDirectory` and `access` calls ride at `POLL` too, so they cannot outrank anything.

## Request path (the image on screen)

`webview loadTuple` → `requestImage` for the modality on screen → `sendImage` → pool @ `VISIBLE` →
`loadFullImage` → post `image`; the siblings follow ~150 ms later, if the user is still there.

- On this navigation path, only the **currently displayed** modality is submitted at `VISIBLE`.
  Siblings ride at `SIBLING` (nearest two) or `SIBLING_TAIL` (the rest). (Mutation/restore paths
  re-send the current tuple at `VISIBLE` too.) That priority split (not FIFO) guarantees the
  on-screen image the first slot, and stops tuple N's siblings queueing ahead of tuple N+1's
  visible image when stepping fast.
- **Arrival asks for one image, not the tuple** (`siblings-dwell-gated`). A field log caught the
  old request for all N modalities on arrival starving a 746×10 panel:
  - browsing queued 7 460 full-resolution loads
  - 15 of 16 pool slots carried images nobody was waiting for
  - the wire moved 3.5 GB
  - the carousel sweep delivered ~4 tiles/s for six minutes

  The webview now posts the on-screen modality immediately and arms a dwell timer for the
  siblings. Any navigation clears it, so a tuple scrolled past never *requests* its siblings;
  un-requested work needs no cancelling. The dwell is `LOAD_DEBOUNCE_MS`, deliberately the same
  150 ms constant as the leading-edge navigation debounce (`tupleLoadPlan.ts`): both answer "has
  the user settled here?".
- **Siblings are ordered by distance in the display order** (`sibling-order-by-display-distance`),
  hidden pills skipped, forward first on a tie: the modality `→` reaches must arrive first. Raw
  modality ids would mis-order both a rearranged column set and a hidden one.
- **The nearest two rank as `SIBLING`, the remainder as `SIBLING_TAIL`.** Ten modalities at
  ~2.25 MB is ~20 MB per lingered tuple. Nearest-first makes the first few load-bearing and the
  rest genuinely speculative, so the tail is the one class that must never take a slot the sweep
  could use.
  `NEAREST_SIBLINGS` (2, in `tupleLoadPlan.ts`) is **unmeasured on its benefit side and left alone
  deliberately**; read "What two nearest siblings cost" below before changing it.
- The accepted regression, knowingly: **flipping to a sibling inside the dwell window costs one
  `VISIBLE` load** instead of a cache hit. That is one image's latency, against the old scheme's N
  images per tuple passed. `render()` issues that load itself when the current slot is empty, so
  the flip is never a spinner nobody clears. A small `requestedSlots` map keeps a repaint from
  re-asking; it is cleared on every reply, on every index shift, and for the arriving tuple on
  each `loadTuple`.
- A flip *after* the dwell is the same case one rank down, and the reason `requestedSlots` maps
  rather than sets (`request-rank-upgrades`). The slot is already outstanding at `SIBLING` or
  `SIBLING_TAIL`. A plain "already asked" guard posts nothing, and the on-screen tile inherits the
  tail's admission rule: a spinner until the sweep drains. The re-post costs a duplicate: pool keys
  are per *tuple*, not per slot, so the stale low-rank task survives and that slot may decode twice.
  That is bounded at one extra decode per flip onto an undelivered slot; a duplicate `image` reply
  just overwrites the webview's cached frame and re-renders. Per-slot keys plus a pool bump would
  remove it and are not worth the surface.
- **Leaving a tuple cancels its queued loads** (`stale-tuple-loads-cancelled`). `sendImage` keys its
  pool task by tuple, like a prefetch wave, and `setCurrentTuple` cancels every key but the arriving
  one. Running tasks finish (pool semantics); queued ones die. Dispose cancels all of them: the
  per-tuple keys are not covered by `poolKey`, which `cancel` matches exactly.
- `sendImage` replies exactly once (`image`/`imageError`) unless the panel is gone or another file
  now occupies the enqueued slot (see `reply-exactly-once`). It replies at the file's live slot, or
  at the enqueued slot when that slot has been vacated. Delivery takes two liberties:
  - While the user is scrubbing tuples, payloads for off-screen tuples wait for a quiet moment
    (`held-payloads-always-flush` below). Past the parking map's 48-entry cap the oldest is dropped
    outright, recovered only because `loadTuple` re-requests uncached slots on revisit.
  - The post is *not* gated on `currentTupleIndex`. The request is authoritative (the webview only
    asks for what it shows), and the extension mutates its own `currentTupleIndex` on watcher
    events, so gating there stranded the very request the user awaited. A reply for a tuple the
    user has left is harmless: the webview caches it and renders only when current.
- The tuple is **range-guarded** before use; an out-of-range index previously threw before the
  `try` and produced no reply at all.

## Full-image loads bypass Sharp entirely (`loadFullImage`)

Browser-decodable formats (jpg/jpeg/png/gif/webp/bmp) pass through as original bytes, without even a
`metadata()` call; only TIFF/PPMX take the decode + PNG re-encode path. Scheduling is half of the
reason. The decode and PNG re-encode run *inside* the load's already-granted pool slot, so they can
never queue behind the sweep (`VISIBLE` outranks `THUMBNAIL_BULK`). But they would hold one of the
pool's few slots for the whole re-encode, stretching the visible load and pushing sibling and
prefetch work behind it. The payload half, and the rule, is
`docs/image-backends.md: passthrough-no-backend`.

So the extension sends no dimensions for these formats; the webview reads
`naturalWidth`/`naturalHeight` off the decoded image.

## Prefetch

Triggered by `tupleFullyLoaded`; loads `center ± prefetchCount` × the **column on screen and its
nearest two siblings** at `PREFETCH` priority (`prefetchPlan.ts`, from the strip the message
carries), pushing each into the webview cache so stepping to a neighbour is instant.

It used to be `center ± prefetchCount` × **all** modalities. Measured on the field's shape (10
modalities, `prefetchCount 3`, a 5-slot pool, 2.5 MB images at 740 ms of read+decode each), that
was wrong in both directions at once:

| | all columns | on-screen column + nearest two |
|---|---|---|
| one wave | 69 slots, 164.5 MB, 13.3 s | 20 slots, 47.7 MB, 3.7 s |
| pool held at 4 of 5 slots | 13.3 s after the user stops | 3.5 s |
| browsing five tuples | 97 images / 242.5 MB loaded, 10 MB displayed | 38 / 95.0 MB loaded, 10 MB displayed |
| step to the neighbour 1.2 s into the wave | cache **miss**, 1022 ms | cache **hit**, 0 ms |
| cold click elsewhere during the wave | 1222 ms (idle baseline 741 ms) | 1221 ms, but only for the wave's 3.5 s |

The cold-click row is *sampled*, not stable: repeats range 773-1161 ms with the wave's phase.

Two things in that table decide the design. The **breadth** is the byte cost: a browsing trace
displayed 4 % of what the wave read. The **order** is the latency cost, and the larger surprise.
Column-major fetches every neighbour's on-screen column before any sibling column. Tuple-major
buried the `+1` tuple's visible column behind the centre tuple's other nine, so the first step to a
neighbour missed the cache: prefetch was *slower than no prefetch at the one thing it exists for*.
`prefetchCount` still counts tuples, as its setting description says; only the columns narrowed.

The cold-click row is the one number the change does **not** improve, and it says where the
residual cost lives. The pool's `visible-never-starved` reservation always hands a `VISIBLE` load a
slot (measured `active=4/5` throughout a wave). With the host's read/decode parallelism modelled
away, the same probe costs 0 ms, so the pool is not what a navigation waits on.

A navigation waits on the resource *below* the pool. Four concurrent full-resolution reads occupy
libuv's four threads, and a running task is never preempted (`pool-width-hides-latency`), so a
navigation issued mid-wave pays up to one in-flight decode. Narrowing the wave cannot change that
per-navigation worst case. It shrinks the **window** in which a navigation can hit it, from ~13 s
to ~3.5 s.

Note what `siblings-dwell-gated` did to that trigger. A tuple is "fully loaded" only once its dwell
has expired *and* its `SIBLING_TAIL` slots have landed, and the tail waits for every other class.
On a cold, wide session, prefetch effectively does not start until the sweep drains. That is the
intent, not a regression: the wire budget already parked speculative pushes for the sweep's
duration (`speculation-yields-the-wire`). A revisit to a fully cached tuple still fires the
trigger from `loadTuple` directly.

- Each wave **supersedes the previous one** (`pool.cancel(prefetchWaveKey)`), so neighbours of where
  you *were* stop competing with where you *are*. The cancel runs before the visibility bail, so a
  hidden panel still drops its stale wave. The trigger is `tupleFullyLoaded`, the wave's only
  caller, not navigation itself. Stepping through tuples that never finish loading supersedes
  nothing, so a stale wave can keep running underneath fast navigation: bounded, not cancelled.
- A completed prefetch only posts if the tuple is **still nearby** and the panel is visible.
  Pushing multi-MB images for tuples you have left just delays the one you want.
- Skipped entirely for hidden panels.
- It **also evicts** (`evictDistantTuples`; bounds under "Two caches, two eviction bounds").
  Prefetch is the only driver of extension-side eviction, so eviction lives here, not on the
  navigation path: a wave is when the cache grows, so also when to trim it. It runs *synchronously
  at wave start*, in the same tick as the unawaited `loadImageToCache` calls. It trims around the
  **new** centre before any of this wave's bytes land, so it drops the previous wave's leftovers,
  never what this one is about to fetch.

### What two nearest siblings cost

`NEAREST_SIBLINGS = 2` was a starting point, not a measurement. Half of it can be measured: the
**cost**, which is larger than the constant's name suggests. The same number sets two things: the
dwell split (how many siblings rank `SIBLING` rather than `SIBLING_TAIL`) *and* the breadth of every
prefetch wave, which derives its columns from this plan
(`prefetch-scoped-to-the-visible-column`). At the field's shape (10 modalities, `prefetchCount 3`,
~2.25 MB per image), read off the real planners:

| | `SIBLING` / `SIBLING_TAIL` per lingered tuple | prefetch columns | wave slots | wave bytes |
|---|---|---|---|---|
| k = 1 | 1 / 8 | 2 | 14 | 31.5 MB |
| **k = 2 (shipped)** | **2 / 7** | **3** | **21** | **47.3 MB** |
| k = 3 | 3 / 6 | 4 | 28 | 63.0 MB |

(The k = 2 row is the real `prefetchWavePlan` output. It reproduces the measured 20 slots /
47.7 MB in the prefetch table above, which counts the already-cached on-screen slot out.) Each
extra nearest sibling costs a third more speculative bytes and slots per wave (15.7 MB per wave at
this shape), and one fewer modality on the tail's "only when nothing else is queued" rule.

The **benefit** is not measurable here. It depends on how far from the current pill the user's
modality flips land: a property of their browsing, not of this code. A synthetic distribution would
decide the constant by assuming its answer. The cost of moving it is known and the payoff is not,
so it stays at 2 until a real session says otherwise. If one does, collect the *distance
distribution of modality switches*: the fraction of flips within one, two or three display steps
of the pill the user arrived on.

### Two caches, two eviction bounds

`state.loadedImages` (extension) and `loadedTuples` (webview) are evicted independently, by distance
from the current tuple, at bounds that are deliberately *not* equal:

| Cache | Evicted by | Bound |
|---|---|---|
| `state.loadedImages` | `evictDistantTuples`, synchronously at the start of each prefetch wave | `prefetchCount + 2` |
| `loadedTuples` | `evictDistantWebviewTuples`, on every `loadTuple` | `prefetchCount + 3` |

The webview's band is one wider on purpose. It decides whether a navigation repaints instantly, so
it keeps recently visited tuples warm just outside the prefetch band. The extension's copy is only a
re-send buffer, and decoded bytes cost real memory per panel, so it trims sooner. Keep the webview's
bound ≥ the extension's. Invert them and the webview asks for a tuple the extension just dropped,
turning the "instant" navigation into a silent re-read.

## Thumbnails

`generateAllThumbnails` submits every *populated* slot at `THUMBNAIL_BULK`, nearest row to the user
first (below), reporting progress as they land. A slot with no file is answered immediately with
`thumbnailError` and counted straight into both progress terms. One terminal tick is posted when
there is nothing to enqueue at all: the per-item callback is the only other thing that reports, and
the webview hides the bar solely on `current >= total`.
It can never queue ahead of a `VISIBLE` load. The speculative reservation ("The work pool") bounds
the wait it can impose, and at concurrency 1 the one running sweep item can still impose one.

It is a one-shot fire from `sendInitData`, never *skipped* for a hidden panel, only paused while it
is hidden. Cancelling or skipping it leaves blank thumbnails until something re-requests them. Two
things re-request:

- `requestThumbnails`, which the webview posts on tuple add (that row) and on modality add/remove
  (every tuple)
- `regenerateThumbnail`, for a single slot. The watcher fires it when the slot's file changed, was
  restored, renamed, or newly placed. The existence sweep fires it for each image in a modality
  directory it adopts (`adoptNewModalityDir`), and for each unknown file its per-directory listing
  hands to `handleFileCreated`.

The second is the common one: an in-place overwrite on every training step refills that slot. A
skipped slot is not necessarily blank for the life of the panel.

### The sweep is centre-out, and fed to the pool in chunks

The centre is the tuple the user has **selected**, not where the carousel is scrolled to. Scrolling
somewhere unloaded prioritises nothing until a click lands there. That is a decision, not an
omission. The maintainer was offered a viewport-derived centre (the webview reporting its visible
row range) and declined it: *"click-first behavior will not annoy, scrolling alone should not alter
the behavior"*. Cancel-on-re-aim had by then cut post-click latency from ~13 s to ~1.6 s. Before
wiring a computed centre in, read `sweep-aims-once-per-pass`: a `centre()` returning a fresh value
on every call is the shape that used to livelock the pump.

Scanline order is fine at 90 slots and wrong at 7 460. A field log of a 746×10 session on remote
SSH over NFS:

- `[IC-SWEEP] start slots=7460 items=7398 missing=62`
- `[IC-POOL] sweeping 2022ms … queued=[0,0,0,0,0,7293,0,4]`
- `[IC-SWEEP] done 21184ms … pack=7398/34.4MB disk=0 generated=0`

Nothing was decoded (every tile came from the warm pack), and the sweep still took 21 s. At 7 398
slots that is ~11 ms each of pack read plus a 34.4 MB push across a serialized remote channel; the
log cannot say which half dominates. A *cold* pack over the same order adds ~7 398 decodes,
previously estimated at 13 minutes. Order, not throughput, is what the user feels: the row they were
looking at was delivered when the scanline reached it, however far that was from where they were.

So the sweep dispatches **outward from the tile the user is on** and re-aims when the user moves.
The aim is a grid position, not a row: a row shows every modality at once. A sweep ordered by row
distance alone drains one row's whole strip before touching the row beside it: at 30 columns, 30
tiles the user is not waiting for.

The structure is a cursor over the plan's items laid out as a grid of cells (`SweepCursor` in
`thumbnailPlan.ts`), plus a lazy **walk**. The walk is a generator that enumerates grid *positions*
in the order the aim implies, skipping cells already empty. `next(aim)` pulls positions until it
finds a filled one, empties that cell and returns it. The coverage argument is the cells, not the
walk. A cell is emptied before its slot is handed out, so nothing is dispatched twice. The
enumeration visits every position in `rows × columns` from any aim, so nothing is missed.

An aim change discards the walk and starts a new one; positions consumed under the old aim are now
empty cells, skipped rather than re-visited. `putBack` refills the cell and discards the walk too,
which is how a return rewinds *both* axes at once (no pointers are left to rewind by hand). The
price is that re-aiming costs one pass over the grid rather than `O(1)`: a fresh walk steps over the
emptied cells one at a time. At one re-aim per dwell that is a fraction of a millisecond even at
7 460 cells. It is one more reason a centre computed on every read is the wrong shape
(`sweep-aims-once-per-pass`): that shape would pay it per dispatch.

The order the walk enumerates has two phases:

1. the focused tile;
2. its **bounded cross**: the focused row's other columns and the focused column's other rows, one
   slot from each arm in turn, so neither axis waits for the other. The row arm takes the first
   turn, and an arm that runs out lets the other continue alone. Within an arm the rule is unchanged:
   forward first on a distance tie. Only the **column** arm is bounded, at a radius of about one screenful of
   carousel rows (below). The row arm always covers the whole strip, because the whole strip is on
   screen;
3. everything remaining, **row-major centre-out**: rows by distance from the focused row, forward
   first on a tie, each row's columns in the cross's rank order. That is the pre-round order, and
   not a fallback: it fills a viewport bounded in rows that shows every column, a wide rectangle
   rather than a diamond. A distance (taxicab) order was measured and rejected for that reason: it
   spends on rows outside the viewport to keep its radius round.

The remainder enumerates the **whole** grid, not just what lies outside the cross, so no cell's
coverage depends on the radius. A cell the cross already took is an empty position the walk steps
over. The radius is an ordering knob only, which makes it safe to change or to get wrong.

For the same reason, a walk that runs out with slots still in the cursor restarts once instead of
reporting the grid finished. This is belt and braces behind `putBack`'s rewind. The rewind decides
*when* a returned slot comes back (at the head of what is left, where the user is looking), not
*whether* it comes back. That safety net also hides the rewind from a coverage fuzz: removing the
rewind alone leaves the fuzz green, and only removing the restart too makes it fail. So the
deterministic boundary test pins the rewind; a mutation gating it on distance from the aim survives
every other test in the suite.

**The radius is the carousel's own screenful.** `tupleFullyLoaded` and `setCurrentModality` carry
`visibleRows`: the webview's `carouselEl.clientHeight / carouselRowHeight()`, the arithmetic the
virtual carousel already does to decide which rows to materialise. Both hosts pass it through as
the aim's `radius`. It is reported, not assumed, because a "screenful" spans an order of magnitude.
Tile size is the carousel width divided by the modality count, so a 3-modality session shows ~7
rows and a 30-modality one, at the tile floor, ~34.
A host that reports nothing gets `SWEEP_CROSS_RADIUS` (12), deliberately on the small side: an
under-estimate costs only reach along the column, an over-estimate costs the rectangle (the table
below). Zero and negative reports are floored at one row, so a collapsed carousel still gets a
cross.

Column distance is measured over the strip **as displayed**, not over original modality indices.
The aim carries `modalityOrder`, so a strip rearranged with `[` / `]` still sweeps the neighbour
next *on screen*. The aim's own column arrives as an original index and is un-permuted through that
order (`docs/tuple-matching.md: wire-index-is-original`). Hidden columns rank after every visible
one but are still swept. Hiding a pill greys it and stops keyboard cycling; it does not remove the
column from the carousel (`docs/session-files.md: hidden-is-presentation-only`), so skipping hidden
columns would leave visible tiles permanently blank.

The focused column keeps its place at the head even when hidden: a click or a digit jump lands
there. This is the sibling loads' rule (`sibling-order-by-display-distance`), reused rather than
restated.

The hosts supply only *where the user is*, and they supply it **raw**. Each forwards
`setCurrentTuple` and `tupleFullyLoaded` to its own `SweepAimPolicy` and passes
`() => policy.aim()` as the runner's centre. The dwell that settles a stream of keystrokes into a
tuple (below) and the un-permuting of the column both live in that shared module. The hosts
contribute a `setTimeout`/`clearTimeout` pair and nothing else
(`docs/standalone.md: host-supplies-data-not-policy`).
The column half comes from the two messages that carry `modalityOrder`, `currentDisplayIndex` and
`hiddenModalities`: `tupleFullyLoaded` and `setCurrentModality` (below). Both products forward both.

`tupleFullyLoaded` is not enough on its own, and the field case is why. It fires only when *every*
modality of the tuple has arrived. On a 265×136 grid that is a whole cold tuple away, and since an
arrival requests only the on-screen column and its nearest siblings, it may not happen at all. A tile
clicked in the 5th column of an un-arrived row left the aim on its old column: column 0, the
strip's first, what a host with no report gets. So **every route that picks a column reports it**,
in a `setCurrentModality` message carrying the same strip and nothing else, independent of any
load. Both hosts feed it to the same `noteStrip`.

The click half shipped first and left the keyboard open. The maintainer found the seam: after one
carousel click the sweep kept filling the clicked column while the arrows, the digits and
`[` / `]` moved the view elsewhere. (The *row* was never part of that. `ArrowUp`/`ArrowDown` post
`setCurrentTuple`, which the tuple dwell has always settled; a seemingly stuck row is that dwell, by
design.)

The keyboard is now reported too. The churn objection that kept it out is answered where it
arises, not absorbed downstream. A host does not coalesce reports: each one moves the aim and drops
what the sweep had queued (`sweep-cancels-on-reaim`), measured as eleven re-aims for eleven reports
in both products. So the **webview** gates the post:

- A click naming a column (a tile, a pill) is a settled destination by construction and reports at
  once.
- A move that can repeat (the arrows, the digits, a reorder from `[` / `]` or from the tools buttons
  calling the same function) waits out a trailing-edge dwell of `LOAD_DEBOUNCE_MS`. It reports the
  column the burst ended on, so a held arrow key is one report, not one per repeat.
- A pick cancels a dwell still waiting, rather than letting it land afterwards and aim back at the
  column the user left.
- The `Space` peek reports nothing, on purpose. It is held, not navigated to, and restores its
  original column on release; reporting it would buy two re-aims for a gesture ending where it
  started.

Gating at the source is available here, not for the row. `setCurrentTuple` has a second consumer
that must stay ungated (`cancelImageLoads`); `setCurrentModality` has exactly one. The coalescing
also keeps a held key off the wire. And only the webview can tell a pick from a burst: the policy
sees one message shape, whoever sent it. That gate is `ColumnReportGate`
(`src/webview/tupleLoadPlan.ts`), pure and unit-pinned rather than DOM-pinned. It cannot diverge
between the products, for the same reason the strip cannot: both ship the same webview bundle.

A column inserted or removed mid-sweep leaves the reported strip stale until the next report. That
can only *mis-order* what is left. The plan is fixed at open, and every settle re-addresses to the
file's live slot (`docs/tuple-matching.md: revalidate-slot-before-write`), so no slot is lost by
it. What any of it means for order lives in the shared module, so the products cannot diverge
(`docs/standalone.md: adapter-contains-no-logic`). Nothing is pushed at the sweep: the aim is read
once per pump pass, so a jump costs nothing when nobody navigates.

**What the cross buys, and what it costs.** Measured on the field shapes, focused mid-grid,
counting dispatches until a tile arrives. Old = row-major centre-out; new = bounded cross with the
radius each carousel actually reports (28 rows at 10 columns, 64 at 30):

| | 746×10 | 315×10 | 746×30 |
|---|---|---|---|
| the on-screen column of the row below | 11 → 3 | 11 → 3 | 31 → 3 |
| the on-screen column five rows away | 91 → 19 | 91 → 19 | 271 → 19 |
| the on-screen column twenty rows away | 391 → **49** | 391 → **49** | 1 171 → **69** |
| the last column of the focused row | 10 → 18 | 10 → 18 | 30 → 58 |
| **the whole visible rectangle** (a screenful of rows × every column) | **290 → 318** | **290 → 318** | **1 950 → 2 014** |
| the nearest 5 rows × every column | 50 → 102 | 50 → 102 | 150 → 274 |

The cost is exact, not empirical. Against row-major, the bounded cross pays **two dispatches per
row by which the radius overshoots the rectangle being measured**, and nothing else. At a radius of
one screenful and a rectangle a screenful tall that is `+2 × (screenful/2)`: the 290 → 318 above,
under 10 %. Halve the radius and the visible rectangle costs *exactly* what row-major costs
(290 → 290), with reach at twenty rows falling back to 391. That is the whole trade, and one number
to change.

The nearest-5-rows row is the same arithmetic against a smaller rectangle, hence its worse look. It
measures how far the cross reaches past a rectangle five rows tall, not a regression the user sees.

An **unbounded** cross was built first and rejected. Its column arm ran to the end of the grid
before the second phase began, and bought nothing on reach over the bounded arm. Two numbers, kept
apart because that build changed two things at once:

- Bounding the arm alone: the shipped cursor driven with `radius = rows` costs **791** dispatches
  on the 5-row rectangle at 746×10, against the bounded 102 (and row-major's 50). 791 is
  `1 + (C-1) + (rows-1) + 4(C-1)`: the whole column plus the focused row, then four rows of nine.
- The **847** measured at the time is that unbounded arm *plus* a taxicab remainder: the rejected
  build's combined figure, not the radius's cost. The remainder's ordering accounts for the other 56.

**The centre dwells; the cancellation does not.** `setCurrentTuple` is posted on every navigation,
ungated, because `cancelImageLoads` must kill the previous row's full-image loads the moment the
user leaves it. Feeding that same stream to the sweep re-aimed it on every keystroke of a held key.
On a genuinely cold 315×10 grid (~3 000 slots at ~8 thumbs/s), the maintainer saw roughly every
fifth thumb land at a row the cursor had already passed: a sparse trail instead of a front. Every
completed thumbnail runs a pump pass, and every pump pass read a centre that had moved again.

So the sweep aims at a *settled* tuple, kept by `SweepAimPolicy` and updated on a **trailing-edge**
dwell of `LOAD_DEBOUNCE_MS` (150 ms). That is the webview's navigation debounce, reused rather than
re-tuned: the same "has the user settled?" question, and small enough to be invisible. While the
key is held each message resets the timer, so no re-aim happens; exactly one fires a dwell after
the key comes up. It is trailing edge, not a literal `keyup`, because click, scroll and
carousel-drag navigation post the same message and deserve the same treatment.
Everything else keeps reading the raw `currentTupleIndex`: the scrub-burst window and held-payload
flush (`held-payloads-always-flush`), and the prefetch band. The re-aim itself is still the pump's
own decision (`sweep-aims-once-per-pass`): the dwell moves a field and pushes nothing at the sweep.

That dwell shipped in the *provider's* wiring first (ff11b92), and the standalone kept feeding the
raw index for two commits. The sweep's aim was injected per host, so a fix to one host was
invisible to the other. The policy is now one shared module both hosts import.
`test/unit/sweepHostEquivalence.test.ts` drives the same held-key burst through both real hosts and
requires the same trace out of each. `scripts/check-sidedness.mjs` fails the build if either host
hand-builds the aim again (`docs/standalone.md: host-supplies-data-not-policy`).

**Chunking.** Re-aiming is possible only if the pool has not already been handed the whole grid. A
queued task is never re-ordered or promoted, so 7 293 queued items *are* the order. The sweep keeps
at most `SWEEP_CHUNK` dispatches outstanding and refills on every settle. The size is 32, chosen
against the pool width (5 here, 1..6 in general):

- **Big enough that the pool never starves.** Refills happen per settle, not per batch, so the pool
  keeps queued items behind its running ones until the tail. That was 28 at the measured peak,
  dipping to ~12 at width 5 and ~3 at width 1 mid-run, never zero while work remains (measured: no
  idle-with-work turn at any width 1..6). Even if every running slot settles in the same turn, the
  queue cannot empty. Anything ≥ 2× the width would do; the margin costs nothing.
- **Not so big that a re-aim churns.** The re-centre lag no longer depends on the chunk (see
  "Cancelling on re-aim"). An oversized chunk costs the *cancel-and-re-dispatch* work of each jump.
  On the cold 115×9 harness below, one jump cancels `chunk - 5` slots: 3 at chunk 8, 27 at 32, 123
  at 128. None had started, so the cost is bookkeeping, not IO. 32 is ~7× the effective bulk width
  and was left alone on this evidence. Going lower buys nothing the anti-starvation bullet does not
  already spend.

Measured at 746×10 on a virtual-clock harness calibrated to the field log: 4.65 KB per tile on a
~2 MB/s channel, 11.45 ms per slot (21 184 ms × the pool's 4 effective bulk slots ÷ 7 398 items).
That reproduces the log's 21 184 ms wall to the millisecond. "Jump" = the user moves to row 500 two
seconds into the sweep:

| | before | after |
|---|---|---|
| current row ±1 delivered after the jump | 12 256 ms | 174 ms |
| current row ±1 delivered with no navigation | 64 ms | 64 ms |
| whole sweep delivered | 21 187 ms | 21 187 ms |
| peak queued `THUMBNAIL_BULK` | 7 394 | 28 |
| … same jump, cold pack (120 ms/slot) | 147 365 ms | 1 802 ms |
| … same jump, instant pack (2 ms/slot) | 9 451 ms | 7 333 ms |

Total time is unchanged by construction (same slots, same pool, only the order), and that is the
point. This buys latency for the row in front of the user, not throughput.

The last row is the honest limit of this round. A warm pack on a slow link produces tiles faster
than the channel drains them: 2 ms per slot against 2.3 ms per tile of wire. The backlog then moves
off the pool queue onto the *wire* queue, which nothing here re-orders. Thumbnail
posts go to `postMessage` FIFO, and the transport budget covers only speculative *image* pushes.
Re-centring still helps (9.5 s → 7.3 s) but cannot beat a queue it does not own. Pacing or
re-ordering the thumbnail wire is a separate lever, and a separate round.

Two things it deliberately does **not** do:

- It does not gate on *scroll* visibility. Every slot is still swept, including rows the user never
  looks at, which keeps the guarantee simple. (A hidden *panel* differs: it pauses, and resumes with
  the same slots owed; "Two panels sweeping at once".)
- It does not touch the prefetch band, a separate resource with a separate problem.

Chunking does not make a hung `makeThumbnail` worse. The pool's effective bulk width (4 here) is
narrower than the 32-slot chunk, so the same 4 hangs jam the chunked and un-chunked sweeps
identically. The idle watchdog protects the wire claim against that (`speculation-yields-the-wire`);
the tail is not protected, and never was.

### Cancelling on re-aim

Bounding the dispatches is not re-aiming them. Of the 32 outstanding, only the pool's effective
bulk width is *running*; the rest sit queued, and a queued task is frozen order. The field put a
number on that cost with genuinely cold tiles, on a 115×9 comparison generating thumbnails from
source:

```
+68135ms  [IC-POOL] sweeping … queued=[0,0,0,0,0,28,0,6] run=[0,0,0,0,0,4,0,0] wire thumbs=604/2.6MB
+110213ms [IC-POOL] sweeping … queued=[0,0,0,0,0,28,0,6] run=[0,0,0,0,0,4,0,0] wire thumbs=710/3.2MB
```

106 tiles in 42 s at 4 running = **1 586 ms per thumbnail**, so the 28 queued were ~13 s of tiles at
the row the user had *left*. The chunk had been sized against a 120 ms/slot "cold" model, 16× off
the real thing. The reported symptom was exactly the arithmetic: "scroll down, click — image
appears in the viewer, but tiles don't load immediately from that place."

So the sweep now **drops its own queued dispatches when the centre moves**. The decision is the
shared module's; each host supplies only the mechanism it already had (`docs/standalone.md:
adapter-contains-no-logic`). `pump()` compares the centre it last aimed at with the live one. On a
change it calls `io.dropQueued()`: `WorkPool.cancel(key)`, which drops queued-but-unstarted tasks
and leaves running ones alone. Each dropped task rejects with `TaskCancelled`. The host maps that
to `SWEEP_REQUEUE`, and the runner **returns the slot to the cursor** (`putBack`) instead of
counting it.

Three rules make that safe, and each fails silently if broken:

- **Return before settle.** The slot goes back into the cursor inside the `then`, before
  `outstanding` drops. The sweep can never observe `outstanding === 0 && remaining === 0` with a
  slot in the air.
- **Rewind the walk.** The cursor's coverage argument is "every position the walk has already
  enumerated is an empty cell". Re-filling a cell behind the walk breaks it, so `putBack` discards
  the walk and the next `next()` re-enumerates from the current aim. That rewinds both axes at once,
  since a returned slot may be behind the walk on the row axis, the column axis, or both. Without
  the rewind the returned cells are skipped forever: blank tiles for the life of the panel, the
  exact failure the cursor exists to prevent.
- **A requeued dispatch is not a delivery.** No `thumbnail` post, no progress tick, no `done++`.
  Work may be *attempted* more than once; a slot is delivered and counted exactly once
  (`sweep-covers-every-slot-once`).

Running work is never cancelled: the pool cannot interrupt it, and it is nearly finished anyway. The
floor on re-aim latency is one running batch, as the numbers show. Measured on the 115×9 field
calibration above (1 586 ms per thumbnail, pool width 5 → 4 bulk slots, 4.4 KB per tile on a
~2 MB/s channel), "jump" = the user moves to row 100, 20 s into the sweep:

| | before | after |
|---|---|---|
| first tile at the new row, after the jump | 12 690 ms | 1 590 ms |
| whole new row (9 tiles) delivered, after the jump | 15 862 ms | 4 762 ms |
| whole sweep delivered (1 035 tiles) | 410 774 ms | 410 774 ms |
| thumbnail reads performed | 1 035 | 1 035 |
| slots cancelled and re-dispatched, six-jump navigation | 0 | 162 |

The wall time and the read count are identical: cancelled work never started, so re-dispatching it
re-does nothing. The lag also stops depending on `SWEEP_CHUNK` (1 590 ms at chunk 8, 32, 64 and 128
alike). That is why the chunk's justification above is about starvation and churn, not lag.

The mechanism needs two scoping rules. First, the sweep submits under **its own cancellation key**
(`${poolKey}-sweep`): a re-aim must not drop the panel's queued export or poll work, which shares
`poolKey`. Panel dispose and standalone re-open therefore cancel that key too, or the sweep's queue
would outlive them. Second, the host must tell *its own* cancellation from a re-aim's.
`PanelState.disposed` (and the adapter's `closed`, set before the re-open cancel so the rejections
it delivers read it) means "settle silently"; anything else means "put it back". Get that backwards
and a dead panel's sweep re-dispatches forever.

### Stopping when the host is gone

Settling those slots silently kept the sweep *terminating*; it did not stop it *working*. Until the
early stop landed, `pump()` kept pulling from the cursor and dispatching after a dispose. The whole
remaining grid was read for a window nobody watched. On the maintainer's remote NFS sessions:

- 746×10, warm from the pack: ~34.4 MB and ~21 s of pool time after the close
- 115×9, genuinely cold, closed a minute in: ~5 more minutes of reads and decodes

That work competed with whatever the user opened next, which is usually why the first one was
closed.

So the runner takes a second host predicate beside `centre`: `abandoned()`. It is `state.disposed`
for the provider and `s.closed` for the adapter, the flags the `TaskCancelled` mapping already
reads. A `pump()` that sees it returns before dispatching, which stops the sweep at a **batch
boundary**, not mid-dispatch. Whatever the pool already started finishes and settles normally;
whatever the cursor still holds is never handed out.

That abandon path is the opposite of the re-aim path on the same `pool.cancel`. A re-aim *returns*
its dropped slots (`putBack`) and hands them out again; an abandon keeps them. The cursor's
consume-once property makes abandoning safe: an item handed out and never returned is gone. That is
right for a panel that no longer exists, and would be a permanently blank tile for one that does.

Termination is the whole trap, and three things have to stay true:

- The sweep must still **resolve**. `outstanding === 0` with slots left in the cursor is now an
  exit. A host already gone when the sweep starts dispatches nothing, so the initial `pump()`
  resolves it directly. Without that line no settle ever fires, and the promise hangs, taking
  `endSweep` with it.
- The wire claim must still be released exactly once. It is, because `endSweep` is reached as it
  always was, off the sweep promise (`speculation-yields-the-wire`).
- The grid is genuinely **not covered** after an early stop. The progress bar stops below `total`
  and no terminal tick is posted. That is correct: the panel is gone, and in the standalone a
  terminal tick would land on the *next* session's bar.

### Two panels sweeping at once

One pool serves every comparison tab. Until the group rotation landed, it served them through one
FIFO per priority. A tab that opens while another is sweeping has already lost. The first tab holds
`SWEEP_CHUNK` dispatches, so the second tab's first slot queues behind 28 of them, and every refill
it makes goes to the back again. Measured on the real pool and the real runner, two 746x10 tabs at
width 5 (4 bulk slots), the second tab joining mid-sweep:

| | one FIFO | group rotation |
|---|---|---|
| reads of the first tab before the second gets one | 28 | 0 |
| batches (4 reads each) before the second tab reads at all | 8 | 1 |
| second tab's share of the next 32 reads | 12.5 % | 50 % |

At the field's cold cost (1 586 ms per thumbnail, four bulk slots), those 28 reads are ~11 s in
which the tab the user just opened shows nothing, then a 50/50 split. The field report was stronger:
*"when one imagecompare tab is doing its loading, and I switch to or open another ic tab, the
indexing does not begin until the old tab is switched to and let finish, or closed"*. The rest of
the gap is this change's second half. The reported case always has the old tab *hidden*, and an
even split with an unwatched tab still halves the rate of the one in front for the whole grid. Same
two tabs, counted over the 20 batches after the switch:

| | sweeping while hidden | paused while hidden |
|---|---|---|
| hidden tab's reads | 40 | 0 |
| focused tab's reads | 40 | 80 |

**The fair-share key is the panel, not the sweep.** Today they are the same (a panel runs one
open-time sweep), so the choice is about what may not become a lever. A producer that can multiply
its key can take a larger share. Keying on the sweep would give any panel running two (a standalone
re-open, or any future re-sweep) two thirds of the pool against a panel with one. A panel cannot be
multiplied without the user opening a tab, and a tab the user opened *deserves* a share.

So the group is `state.poolKey`: already unique for the process lifetime
(`panel-keys-never-reused`), already on the state, and never reused after a close. The cancellation
key stays separate (`${poolKey}-sweep`). Cancellation scopes *what dies together*, the group scopes
*who takes turns*, and merging them would make a re-aim's drop a fairness event.

**A hidden tab pauses instead of sweeping.** Rotation splits the pool evenly between two tabs, but
it does not know which tab the user looks at. The maintainer's rule is that they are not equal:
*"if a user navigated away from a tab, it is ok to put all those jobs on hold and give way to the
tab in focus"*. So the runner takes a `paused()` predicate beside `centre()` and `abandoned()`, and
the provider feeds it `!state.visible`. A paused pump hands out nothing and returns its queued
dispatches to the cursor (`io.dropQueued`, the call a re-aim makes). The hidden tab is out of the
pool within one running batch rather than one chunk.

This is a *deferral*: the slots go back to the cursor, not into the bin, and the panel finishes its
grid when the user returns. The two halves are not substitutes. Rotation saves two tabs side by
side in split editor groups, where neither is hidden and neither may starve. Pausing saves the
common case of one tab in front and one behind. Neither covers the other's case.

Three things a pause must not break, and each hangs something if it does:

- **The sweep must still end.** A paused sweep with nothing outstanding has no settle left to run
  its exit. The runner hands the host a `repump` callback, and the host calls it whenever its own
  `paused`/`abandoned` answer changes:
  - on hide, or the pause never reaches the pump until the next slot settles
  - on show
  - on **dispose**, where it is the only exit

  Without that call the sweep
  promise never settles and `endSweep` never runs. The wire claim is then held for the life of the
  extension host (`speculation-yields-the-wire`), with the whole plan retained behind it.
- **A pause at sweep start is not an empty sweep.** The runner's start-time exit
  (`outstanding === 0` after the first pump) exists for a host already gone. A paused host reaches
  it too, with the entire grid still in the cursor, so the exit is taken only when the host is
  abandoned or not paused.
- **The idle watchdog releases the wire claim; the pause does not hold it.** A paused sweep settles
  nothing, so the existing 30 s idle watchdog ends it and unparks speculation. That degrades to "no
  rule 2", the pre-backpressure behaviour: cheap, and a hidden panel does not exercise it anyway (it
  issues no prefetch waves). `endSweep` is idempotent, so the resumed sweep's real completion
  changes nothing. The cost is the `[IC-SWEEP] done` rollup printing at the watchdog, not at the
  end of the grid.

**Does the fairness reach the user?** The pool orders work. The thumbnail *wire* is still FIFO and
`TransportBudget` does not govern it: it bounds speculative image pushes only, and the sweep's own
tiles are not speculative. That limit is real but does not eat this change. The wire sees the order
the pool produces, because tiles are posted one at a time as slots settle: interleaving the reads
interleaves the posts.

The rotation cannot create bandwidth. With two tabs sweeping over one serialized remote link, each
tab's grid takes about twice as long as alone, and no re-ordering changes that. What changes is that
the second tab fills immediately at half rate, instead of showing nothing for a chunk and then
filling at half rate. The pause goes further: full rate for the tab in focus, nothing for the one
behind it. Pacing or re-ordering the thumbnail wire itself remains a separate, un-taken lever (see
the last row of the centre-out table above).

### Thumbnails ship as bytes, and the webview owns their urls

A `thumbnail` message carries `{bytes, mime}`, exactly like `image`, not a
`data:image/jpeg;base64,…` string. Base64 cost the ×1.33 inflation and large-string churn the
full-image path shed years ago, on the payload that arrives ~1000 times per open instead of six.
Measured on this repo's photo fixtures at the production encode (8 977 B/tile), 1000 tiles cost
11.50 MB of data-URL messages against 8.64 MB of binary ones. Each was encoded synchronously on the
extension host and decoded again by the renderer's URL parser.

Nothing below the wire changed. The memory cache, the per-entry `.jpg` files and the packfile all
stored raw JPEG bytes before and still do. The conversion simply disappeared, so `getThumbnail` now
returns the bytes its tiers already held (`THUMBNAIL_MIME`, JPEG for both backends). The standalone
adapter encodes through `canvas.toBlob` instead of `canvas.toDataURL` and posts the same shape (PNG
for `.png` sources, JPEG otherwise).

The cost moves to the webview, where the bytes become `URL.createObjectURL(new Blob(...))`. An
object url is a document-lifetime GC root: forget to revoke one and its blob is pinned until the
panel closes. The carousel rebinds tiles constantly through the pooled rows. The full-image path can
revoke inside `img.onload` because its url is used exactly once. A thumbnail url is not: it is
*cached* in the webview's slot map and re-applied on every pooled-row rebind, on the blurry preview
canvas, and after every row/column splice re-keys the map.

So ownership sits with the map, not the tile. `webview/thumbUrlCache.ts` (pure, unit-pinned) revokes
a url exactly when its key stops pointing at it:

- superseded by a fresh delivery
- overwritten by the ✕ placeholder
- deleted on restore
- dropped by a re-key
- cleared on re-init

Nothing else revokes, so a recycled row can never blank a url another row is showing. Two details
are load-bearing. The successor is written into the map and onto the tile *before* the superseded
url is revoked (revoke-first kills a tile still loading it). The shared ✕ placeholder is a data url
the cache stores but must never revoke. The accepted residual case: a preview `<img>` still decoding
a url that this slot's newer delivery supersedes loses its blurry frame (the spinner stands in until
the full image lands).

## Transport backpressure (`transportBudget.ts`)

The pool orders **work**; this orders **bytes on the wire**. They are different resources, and for
most of this file's history only the first had a scheduler.

A Chrome renderer trace of a remote-SSH session (230 tiles, 71.8 s) found the webview main thread
0.7 % busy and no task over 50 ms: neither the renderer nor the host was the bottleneck. The
1.24 MB of thumbnails trickled over 35 s, of which **28.6 s was nine gaps longer than a second**.
**106 MB of the session's 115 MB of full-resolution images arrived inside those gaps**: one prefetch
wave against a 1.2 MB thumbnail sweep. That wave was `prefetchCount 3` → ~7 tuples × ~6 modalities ≈
44 images, largest 16.71 MB (the pre-scoping wave shape; the same session's wave is now ~7 × 3).
On a remote window the extension→webview channel is one serialized link, so this is textbook
head-of-line blocking. `visible-never-starved` and `background-trickle` hold on the pool and say
nothing about the wire.

The fix is scheduling, never fidelity. Zoom reads the original bytes (`docs/image-backends.md`:
`passthrough-no-backend`), so nothing here downscales, recompresses or chunks a payload. It only
decides *when* a speculative payload is handed to `postMessage`.

Three rules, in the order they are applied to an `image` push:

1. **User-facing pushes go now.** Every `sendImage` reply (the image on screen, its siblings, crop
   and export refreshes) is posted in the turn it is ready, whatever is in flight. The budget is
   never a reason a user waits.
2. **Speculation yields while a bulk sweep drains.** Between `generateAllThumbnails` and the sweep's
   completion, prefetch pushes are parked, not posted. That costs almost nothing: parking delays
   the *push*, not the *work*. The bytes are already in `state.loadedImages`, so a parked (or even
   dropped) push costs at most one on-demand transfer when the user navigates there, which is what
   a session with `prefetchCount: 0` pays.

   Sweeps are finite (one slot per grid cell, one sweep per open). The claim is released through a
   single exit (`endSweep`, idempotent) reached four ways:
   - the sweep's settle, which logs the `[IC-SWEEP] done` rollup
   - a synchronous throw out of the sweep's prologue
   - a 30 s stall watchdog
   - panel dispose

   The throw path is not hypothetical bookkeeping. `runThumbnailSweep` posts the plan-missing errors
   *before* it returns a promise, so a `postMessage` that throws there escapes before any `.finally`
   is attached. Raise the flag outside that guard and the panel spends its life with speculation
   parked, silently.

   The watchdog is **idle**, not total: every settled slot re-arms it. A sweep that is merely slow
   (thousands of tiles on a cold mount) is never cut short, while one read that never settles costs
   30 s of parked speculation instead of the panel's life. A paused sweep releases its claim the
   same way ("Two panels sweeping at once"). Releasing early is cheap (it degrades to "no rule 2",
   the pre-backpressure behaviour), so the timeout is sized to be obviously pathological, not tight.
3. **Outside a sweep, speculation is capped in bytes in flight**, not in messages. One 16 MB image
   is the unit of damage, so a message count would bound nothing. Default 8 MB
   (`imageCompare.prefetchTransportBudgetMB`): roughly one whale, or a handful of ordinary images
   pipelined, between a user-facing message and the link. A single push over the whole budget is
   still allowed when nothing is in flight, or an image larger than the budget could never be sent.

In flight means *posted but not acknowledged*. The release signal is the `Thenable` returned by
`webview.postMessage`, which on a remote window resolves only after a round trip through the same
link. Two honest limits follow:

- If a future VS Code resolved that promise eagerly, rule 3 would degenerate to a no-op. Rule 2,
  which needs no ack, would still hold, and rule 2 is what the trace indicts.
- If the promise never settles (a disposed webview mid-post), a 30 s watchdog releases the credit.
  A lost ack costs one stalled wave rather than a session with prefetch switched off.

Both watchdogs (the ack timers and the sweep's stall timer) are tracked on the panel and cleared in
`disposePanel`, so a timer does not retain a closed panel for half a minute.

Parked pushes are:

- keyed by slot
- capped at 64 entries (oldest dropped, like the scrub-burst park)
- re-checked against the prefetch band on release; a push for a tuple the user has left is dropped
  exactly as `loadImageToCache` would have dropped it at push time
- cleared on dispose

A parked entry usually holds a payload `state.loadedImages` already holds, so parking costs no
extra memory until eviction outruns the queue. The park and the scrub-burst hold are both keyed by
slot, so they re-index with `loadedImages` on every splice
(`docs/file-watching.md: reindex-in-lockstep`). Otherwise a park draining across a 35 s sweep is a
35 s window for a payload to land under another file's label. A training loop rewrites in place the
directories this extension is pointed at.

The policy is inert on local windows (`vscode.env.remoteName === undefined`). There is no serialized
link to fight over, `postMessage` acks land on the same machine, and throttling would only slow the
warm case. `undefined` is the API's own "not remote" answer; any remote kind (`ssh-remote`, `wsl`,
`dev-container`, a Codespace) is a string and gets the bound. The **standalone build has no
transport layer at all**. The adapter posts in-process, and `transportBudget.ts` is extension-only
by construction (`check-sidedness.mjs` classifies it), so there is nothing to no-op there.

Measured on the real provider against a simulated 5 MB/s serialized wire (`transportFairness.test.ts`:
120 thumbnails ≈ 703 KB, one 42-slot wave ≈ 59.6 MB with a 16 MB whale, wave issued mid-sweep):

| | budget off (pre-change, and every local session) | budget on (8 MB, remote) |
|---|---|---|
| last thumbnail on the wire | 12 648 ms | 749 ms |
| user-facing image requested mid-wave | 12 524 ms | 624 ms |
| speculative bytes queued ahead of it | 59.5 MB | 0 |
| peak speculative bytes in flight | 59.5 MB | 16.0 MB (the whale, alone) |
| `[IC-SWEEP] done … wire` | `images=43/59.6MB` | `images=1/2.9MB` |
| total time to move every byte | 12 649 ms | 12 649 ms |

The last row is the point: nothing is throttled away and no byte is dropped. The same traffic is
reordered, so the user-facing 3 MB and the 703 KB carousel stop queueing behind 59 MB of
speculation.

## Observability

None of the above is measurable from the outside. On a remote host the renderer trace shows an idle
webview and says nothing about where the seconds went. `imageCompare.debug` therefore instruments
the whole loading path into a single "ImageCompare" output channel (`debugLog.ts`; the how-to is in
docs/testing.md):

- which cache tier answered each `getThumbnail`
- the open-time sweep's wall time and tier histogram
- `WorkPool.stats()` snapshots every 2 s while a sweep drains
- outbound bytes per `thumbnail`/`image` message (both raw payload bytes since thumbnails went
  binary; the `(b64)` marker those figures used to carry is gone)
- prefetch-wave issuance and rollup

The channel, not the console, is the sink on purpose. VS Code forwards extension-host console
output into the renderer, so a matcher trace of a few thousand lines is itself renderer work, just
when the panel is trying to paint. `imageCompare.debugConsole` restores the mirror when wanted.

The instrumentation is *diagnostic*, so it must not become a cost of its own. Every site is behind a
cached flag and builds no string until it is on. The sweep's tier histogram is a diff of two
cumulative snapshots (`ThumbnailService.thumbTierStats()`), not a per-sweep reset, so a sweep cannot
zero counters another sweep is still using. But the service is one provider-wide instance, so two
panels sweeping at once still land in each other's deltas. Read a histogram as "thumbnails served
while this sweep ran", not "thumbnails served *for* this sweep".

### The open path: one rollup, `[IC-OPEN]`

Everything above measures work the pool does. The *open* is the part before any of it, and it used
to be dark. A 746x10 comparison left the window blank for ~20 s. The channel could only show a
6.96 s hole between `=== TUPLE MATCHING END ===` and `[IC-SWEEP] start` with `active=0/5`: no image
work at all, and no line attributing a millisecond of it.
The open therefore carries a trace (`OpenMarks` in `debugLog.ts`) whose marks are taken at the
boundaries the hole was made of. It emits one line when the thumbnail sweep starts, **and only
then**: an open that ends before the sweep prints nothing (see "When the line is absent" below).

Real output, captured from a run of the real open path (`openCompare` → `ready` → sweep) over a
synthetic 746x10 tree of empty files on a local tmpfs, thumbnail decode stubbed out. That is the
field case's grid at a local floor, so read the *shape*, not the magnitudes:

```
+366ms [IC-OPEN] open 238ms scan=214ms/7460f(match=26ms) watchers=8ms/11dirs boot=0ms init=6ms(sizing 2ms)/614.4KB grid=746x10 toSweep=6ms other=4ms
+366ms [IC-SWEEP] start slots=7460 items=7460 missing=0 grid=746x10 pool active=0/5 …
+428ms [IC-SWEEP] done 61ms items=7460 122295.1/s posted=116.6KB …
```

`open` is the **whole** open, scan included. The hole that motivated the line (matcher's last line to
`[IC-SWEEP] start`) is `open` *minus* `scan`, i.e. `watchers + boot + init + toSweep + other`: 24 ms
here, and the 6.96 s above is that same quantity. `boot=0ms` is an artefact of the capture, whose
stub answered `ready` synchronously; in a real window it is the renderer's startup and never zero.
Read the three lines together for the property the numbers rest on. `[IC-SWEEP] done 61ms` at
`+428ms` counts from `+367ms`, the instant the rollup above was printed (±1 ms of stamp rounding):
the two rollups abut, so no time hides between them.

One line, not one per span: a large open must not bury the rest of the channel. The terms:

- `scan=` the open's first mark to the scan's return (`scanForImages` plus the early-dispose
  subscription armed before it), the image files it handed the matcher, and, nested inside, the
  matcher's own time. Only the scan can split those two, so `ScanResult.stats` carries them back to
  the provider (absent entirely when debug is off).
- `watchers=` the watcher setup, and how many directories got one.
- `boot=` the html assignment until the webview's `ready` post: the renderer's own startup, which no
  extension-side timer can otherwise see. It ends where the `ready` handler *begins*, so the
  handler's own work (the pending-debug flush) belongs to `other`, not to the renderer.
- `init=` `sendInitData` from entry to the posted payload, with the serialized payload size.
  `sizing` is the part of that span that is *debug's own cost*: one extra `JSON.stringify` of the
  payload, paid only with debug on and reported rather than hidden, so nobody reads it as product
  time.
- `grid=` tuples x modalities, the size to read the other numbers against.
- `toSweep=` the hand-off: the posted payload to the sweep's *own clock*, config read and thumbnail
  plan included. It is the timestamp `[IC-SWEEP] done`'s ms counts from, so the two rollups meet
  with nothing between them. Taken any earlier it would be structurally ~0, and the plan's cost
  would fall inside neither line.
- `other=` everything the marked spans do not cover (`open-spans-account-for-the-whole-open`).

**When the line is absent.** The sweep consumes the trace, so an open that never reaches the sweep
never reports:

- the panel closed during the scan
- a scan that matched nothing
- a throw on the open path
- a webview that never posts `ready`

The channel simply ends after the matcher. That is itself the diagnosis (the open did not get as far
as thumbnails), but *no `[IC-OPEN]` line* is not *a fast open*. Deliberate: an abort emission would
have to invent an end mark for a span that never ended, and the case the line exists for reaches
the sweep.

Two things a reader has to be able to tell apart, and the log used to conflate both:

- **One shared wait vs. N slow operations.** Every thumbnail request that misses memory awaits the
  same `ensurePackLoaded()` promise, so charging each waiter its full wall wait multiplied one file
  read by the number of callers. The tiers report per-item work with that wait subtracted, and the
  shared read is reported once beside them as `packLoad=…/blocked=…`
  (`shared-waits-are-not-per-item-work`). `packLoad` is diffed across snapshots like the tiers, so
  only the sweep that paid for the read reports it. A second sweep in the same session shows
  `packLoad=0`, correctly stating that its pack cost nothing.
- **Nothing happening vs. nothing being said.** The poll's pool snapshot is emitted on change or on
  a busy pool, never on every idle cycle (`idle-poll-logs-nothing-new`).

## The webview's tuple cache (`loadedTuples`)

The webview keeps its own cache of decoded frames, keyed by tuple index: the authority for what is
on screen. Three rules keep it honest.

`render()` must re-derive frames from `loadedTuples.get(currentTupleIndex)`, never from the
module-level `images`. `images` holds the frames of the last tuple that finished loading; on a
tuple still loading, those belong to the *previous sample*. Switching modality there renders
another sample's image under the current label: a silent, plausible-looking wrong-image bug.
`loadTuple` also resets `images` on entry, so no stale frame survives the navigation.

Eviction is bounded by distance, not count: `evictDistantWebviewTuples` runs on every `loadTuple`,
dropping anything beyond `prefetchCount + 3` from the current index. "Two caches, two eviction
bounds" says why the webview's band is wider than the extension's.

The navigation debounce is leading-edge (`LOAD_DEBOUNCE_MS = 150`, in `webview/tupleLoadPlan.ts`,
guarded by `lastNavAt`). An isolated navigation loads with *zero* delay; only rapid stepping
coalesces. A trailing debounce would coalesce rapid stepping too, but tax every isolated navigation
(the common case) 150ms. The shape is the point, not the interval.

`decodeRetried` is cleared wholesale by **anything that shifts its keys**: tuple removal/insertion,
modality add/remove, and `init`. The set is index-keyed, so a shift leaves stale bits on unrelated
slots, robbing them of their one retry (`decode-retry-once`). Clearing beats re-indexing: a lost
retry bit costs a round-trip, a misapplied one a permanently "missing" image. Insertion joined the
list late; it had quietly kept the bug removal was already fixed for.

## Rendering: aspect ratio, zoom and pan

Rendering is "contain": `baseScale = min(vw/width, vh/height)`, and the drawn scale is
`baseScale * zoom`. Nothing is stretched, so images of different aspect ratios in the same tuple
legitimately render at different sizes.

Strip tiles are the exception. A square tile shows its thumbnail centre-cropped (`object-fit: cover`)
rather than letterboxed, so a row reads as a wall of image content at any aspect ratio.
Only the tile crops it, never the generated thumbnail.

`zoom` and `panX/panY` are session-global and are *not* reset when switching modality: you are
comparing the same region at the same magnification. But `baseScale` is per-image, so when the next
modality has a different aspect ratio the same `zoom`/`pan` maps to a slightly different region.
That is a consequence of preserving the view, not a bug to "fix" by resetting.

## Decode failures

A frame can fail to decode in the webview (a partial read while a training step rewrites the file).
`img.onerror` re-requests the slot **once** with `forceReload`, making the extension drop its cached
bytes first; otherwise the retry gets the same undecodable payload and can never succeed. The slot
is marked unavailable only if the retry also fails.

## When there is nothing left to draw

A comparison can become empty while the user looks at it, for example after `rm -rf` on its root.
Two detectors race, so the empty state has two shapes:

- The per-file sweep commits each removal in turn, and the last one takes the row and then the
  columns it emptied. The webview lands on **zero tuples**.
- The modality-dir watcher removes whole columns, and `removeModalityStep` strips every image but
  leaves the emptied rows behind. The webview lands on **zero modalities with rows still in place**.

Neither shape used to reach a rendered state. At zero tuples nothing called `render()`, and the last
drawn frame survived. At zero modalities `loadTuple` turned the spinner on, found the (vacuously)
complete cache and returned without a request, so nothing could turn the spinner off. Both are now
the same terminal notice, decided by `webview/emptyNotice.ts` and raised at the one site
(`applyEmptyNotice`) that hides the canvas.

Two facts, deliberately not one message. "Every image was deleted" is all the webview can know on
its own. "The folder no longer exists" only the host can establish, and to someone staring at an
experiment output directory they are different news. The host establishes it in mode 1 only (the
base directory is that mode's whole shape) and reports it as an edge
(`docs/file-watching.md: root-loss-reported-as-an-edge`). The standalone reaches the notice through
the same shared bundle, always with the generic wording: a File System Access root handle cannot
tell "gone" from "unreadable", and guessing would put a wrong fact on screen.

The notice is not a dead end: these directories are experiment outputs and they come back. The
base directory stays watched after its modalities are released
(`docs/file-watching.md: watchers-released-with-modality`), and re-adoption arrives as an ordinary
`modalityAdded` / `tupleAdded` pair. That works only because the adoption path was made reachable
from a *completely* emptied scan (`docs/file-watching.md: root-return-re-adopts`). Its guard used to
return before its first filesystem call, so the total-loss case, the reported repro, could never
recover.
Both handlers shift the cursor past the insertion point. That is right when there is a column or row
to be past, and off the end when there is not, so on the transition out of empty each re-aims at
the arriving content instead.

## Filesystem watching

Watchers are primary; the existence sweep is a fallback for mounts where they don't fire.
`docs/file-watching.md` covers which mechanism reports what, and what each event mutates. The
sweep's *scheduling* is here, and is deliberately cheap:

- **Fully async** (`fs.promises.access`). The old synchronous `fs.accessSync` sweep blocked the
  extension host for seconds per tick on a network mount (the ~10s spinners).
- Scheduled at **`POLL` priority** (yields to everything). Every part of the cycle goes through the
  pool:
  - the mode-1 new-modality-directory scan
  - one listing per watched leaf dir, which routes unknown image files to `handleFileCreated` (the
    only new-file detector on mounts whose watchers are silent) *and* names the deletion candidates
  - one existence check per candidate
- **One pooled task per watched directory, not per file.** A quiet cycle over a 746×10 comparison
  submits ~11 tasks, not 7 407 (`docs/file-watching.md: sweep-derives-deletions-from-listings`).
- The new-modality scan runs **first**. It is one `readDirectory`, so putting it ahead of the other
  listings bounds its latency at the interval, not the whole cycle's duration. Adoption can inject
  `THUMBNAIL`/`VISIBLE` work for the images it finds, which is the point. Steady state, it is one
  `readDirectory` plus one `stat` per base-dir *subdirectory* not already a modality (a plain file
  like `results.txt` costs nothing). A barren sibling is re-`stat`ed every cycle and skips only its
  *listing* (`docs/file-watching.md: barren-dirs-memoized`); a dot-directory costs nothing. An
  unseen directory costs that `stat` plus a listing, and an adopted one a second listing on top,
  retaken after the watcher is armed.
- **10s** interval, **non-overlapping**, and **skipped while the panel is hidden**.

## Lifecycle

`PanelState.disposed` stops all in-flight work. `visible` gates *starting* new background work (the
**existence sweep** and prefetch waves). Since cross-panel fairness landed, it also gates
*continuing* the open-time thumbnail sweep, which pauses while hidden and resumes on re-show (see
"Two panels sweeping at once"). That sweep is still a one-shot fire that must reach full coverage; a
pause defers it, and only a dispose ends it early.

Hiding a panel deliberately does not cancel its image or thumbnail work. The custom editor uses
`retainContextWhenHidden`, so a hidden webview keeps its DOM, cache and spinner, and nothing
re-requests on re-show: cancelling would strand it permanently. Queued background work is harmless
anyway (`THUMBNAIL_BULK`/`POLL` rank below any `VISIBLE` load).
Only the speculative prefetch wave is dropped on hide, and nothing restarts it on re-show. It
restarts on the next `tupleFullyLoaded` that arrives *while visible*. One arriving while still
hidden is consumed for nothing, because the wave-key bump happens before the visibility bail.

Nothing else about hide may change: a hidden panel's queued image loads, cached bytes and held
payloads stay where they were. `setPanelVisible` is a call, not only a flag write, and it must reach
the sweep's pump in **both** directions.

Closing a panel cancels everything (`poolKey`, the sweep's own `${poolKey}-sweep` **and**
`prefetchWaveKey`; `cancel` is exact-match; see `sweep-cancels-on-reaim` for why the sweep has a key
of its own).

### Setup ordering (three rules, each closing a real window)

Opening a panel is asynchronous, and step order is load-bearing:

1. **Message listener attached *before* `panel.webview.html` is set.** Setting the HTML starts the
   webview's JS, which immediately posts `ready`; attach afterwards and you race the init handshake,
   leaving a panel that never initialises.
2. **A dispose during the initial scan is probed explicitly** (`earlyDispose`). The real
   `onDidDispose` can only attach after the scan, so a close in that window would otherwise leak the
   panel's watchers and timers.
3. **Per-panel disposables go in `panelSubscriptions`, never the provider-wide `disposables`.** The
   provider outlives every panel, so registering there leaks one entry per open/close for the session.

## Invariants

- **`columns-virtualize-like-rows`** — a bound row materializes only the modality columns inside the
  horizontal viewport, from a per-row pool ring-mapped by display index (`slot = displayIndex % pool`),
  as the wall materializes only the tuple rows inside the vertical one. Both pools are sized from
  the *narrowest* item they can hold (14 px), so a resize never remaps the ring, and both write
  position only on change. `webview/columnWindow.ts` owns the arithmetic. Nothing else may compute a
  column's `left`: `selection-centres-on-navigation` reads the same pitch to centre a column, and the
  two drifting apart is a silent mis-scroll. Measured on the field grid (265 tuples x 136
  modalities) through an identical scroll burst, before and after:

  | | before | after |
  |---|---|---|
  | tiles in the DOM | 7 752 | **2 451** |
  | DOM nodes | 76 719 | **26 508** |
  | `Layerize` per occurrence | 34.3 ms | **4.1 ms** |
  | `Paint` | 1300 ms over 17 776 | **464 ms over 4 336** |
  | `Commit` per occurrence | 0.89 ms | **0.29 ms** |
  | `HitTest` per occurrence | 4.4 ms | **2.1 ms** |
  | DOM nodes | 78 764 | **27 293** |
  | JS event listeners | 15 690 | **5 089** |
  | JS heap | 11.3 MB | **6.7 MB** |

  The table does not measure blob and bitmap residency (an earlier, now-deleted plan *estimated* it
  at 1.48 GB), and this change does not touch it: `ThumbUrlCache` still retains one object URL per
  swept slot regardless of what is on screen (`dev_backlog/thumb-url-cache-unbounded.md`). What virtualization removes is DOM: nodes,
  listeners and the heap that holds them.

  The two axes **compound**, which is why this mattered more than the tile count suggests. More
  modalities means narrower tiles, narrower tiles mean shorter rows, and shorter rows mean *more
  rows* in the pool. The tile floor that keeps columns reachable is the constant that maximises the
  row count, so the axes reinforce rather than trade off. Virtualizing one axis breaks the product;
  **raising the floor attacks both at once**, so `MIN_TILE_PITCH` is one constant, not two.
  Doubling it from 14 to 26 (a 12 px tile to 24 px) cut the field grid from 2451 tiles to 910, and
  the worst frame of a medium scroll from 104.7 ms to 20.1 ms. The cost is columns on screen: the
  same strip shows 9 at the floor rather than 16, so a wide grid scrolls horizontally more.

  The tile count is bounded by the strip's width, so doubling the modalities costs nothing. That is
  the property `test/webview/column-virtualization.spec.ts` pins, rather than any of these numbers.
  It is the term three earlier constant-factor fixes on this path could not reach
  (`carousel-dom-never-searched`, `images-fill-progressively`, `rows-contain-their-own-paint`); each
  was real and measured, and none changed how many tiles exist.
- **`rows-contain-their-own-paint`** — every carousel row carries `contain: content`, so its layout,
  paint and hit-testing cannot escape its box. The reason is measured. A DevTools trace of a wide
  grid being scrolled spent roughly 2000 ms of 4000 in **Paint** (12 055 of them), **Layerize**
  (130 x 5.7 ms) and **HitTest** (363 x 1.9 ms), against **270 ms** of script. The cost of this
  carousel is the size of its DOM, not the work its code does. The wall is one promoted layer
  (`will-change: transform`) holding `rowPool x colPool` tiles; without containment a change
  anywhere in it invalidates paint across the whole thing. The same measurement keeps
  `CAROUSEL_OVERSCAN` small: every buffered row is DOM painted and hit-tested whether or not it is
  seen. It was briefly raised to 10 on a guess about blank rows that `images-fill-progressively` had
  already made moot. Profile before optimising anything here: three fixes on this path targeted
  script and image decode before a trace showed where the time goes.
- **`images-fill-progressively`** — a bind never pays for a thumbnail. While a wheel moves the wall,
  a bound tile takes the shared blank. When the gesture settles, a budgeted filler gives tiles their
  real image a few per frame, nearest row to the current one first. Both halves are measured, on the
  265 x 136 field grid through a medium scroll (~2 rows per frame):

  | | median frame | worst |
  |---|---|---|
  | images bound during the gesture | 215.9 ms | 423.1 ms |
  | the same with `decoding="async"` | 171.8 ms | 303.8 ms |
  | the same with 16x16 thumbnails | 106.2 ms | 150.5 ms |
  | **blank during, filled after** | **29.3 ms** | **100.5 ms** |

  The reason is the unit cost, the number to know before optimising anything here: **one
  `img.src = blobURL` costs 1-3 ms**. A blob URL is a *resource load*, not a memory read; the user's
  own trace showed thousands of `ThrottlingURLLoader::Start` events. Image size barely moves it
  (16x16 is only 2.4x cheaper than 200x150), so this is not a decode problem and
  `decoding="async"` does not rescue it. At ~2.9 ms per tile, a screenful of this grid (around 910
  tiles at the 24 px floor, 2451 before it was raised) is seconds of main-thread work *however* it is
  scheduled. The filler cannot beat that. It spreads the cost over frames instead of one, the
  difference between a wall that fills in and a viewer that freezes.

  **Which frames give up their images is a speed decision, not a blanket one.** Once
  `columns-virtualize-like-rows` and the raised tile floor cut a screenful from 2451 tiles to 910, a
  *slow* scroll became affordable: fully painted at 34.5 ms a frame, where it cost 215 ms before.
  Only a frame moving more than `CAROUSEL_FLYBY_ROWS` rows gives up its images; below that the wall
  stays populated and the gesture is visibly working. A flick still blanks, at 16.7 ms a frame, for
  tiles gone before they could be read.

  Two rules keep that honest. A tile already showing its own image is **kept**, flying or not:
  keeping costs no assignment, and blanking it throws away content the user is looking at, which
  made a gesture appear to wipe the wall. And a rebound row is blanked *explicitly* rather than left
  alone, so it can never show the previous tuple's image. Two things would actually move the
  ceiling, and neither is scheduling: fewer tiles on screen, or a tile that is a canvas blit rather
  than a URL load (`dev_backlog/tile-appropriate-thumbnails.md`). Only the wheel defers; a drag, a
  navigation or a resize is a landing, so `scrollCarouselToCurrentTuple` clears the flag and fills
  straight away.

- **`carousel-dom-never-searched`** — nothing on a per-tile or per-arrival path may search the
  carousel's DOM. The carousel holds `rowPool x colPool` tiles (thousands at a wide grid), so an
  attribute-selector search costs a subtree scan. The two places that did it ran *per item*:
  - `handleThumbnail`/`handleThumbnailError` (and the watcher's delete/restore) searched
    `.carousel-thumb[data-tuple=..][data-modality=..]` for **every arriving thumbnail**
  - `bindCarouselRow` ran a `querySelectorAll` per row plus a `querySelector` per tile for the vote
    circle

  A sweep re-aim delivers hundreds of thumbnails at once, which is how a re-aim bought a second of
  frozen scrolling. Both are index lookups now. Rows are ring-mapped (`slot = tupleIndex % pool`), so
  the row holding a tuple is arithmetic, and each row's tiles and circles are captured once at
  creation in `rowParts`. A tile is `parts.imgs[displayIndex % colPool]`, and only when
  `colBound[slot]` still holds that column. The ring mapping makes this possible at all, so a change
  to it must keep `carouselTileFor` honest. It verifies `carouselRowBound[slot] === tupleIndex`
  before returning; a slot bound to another tuple correctly returns null rather than the wrong
  tile. Since `columns-virtualize-like-rows`, the lookup also passes through the column ring: a
  column not on screen has no tile and correctly returns null, and the thumbnail waits in the url
  cache until it scrolls in. This removed a constant factor; the term was the tile count, which is
  that invariant's.
- **`wheel-coalesced-to-one-frame`** — the carousel's row axis is a virtualized wall: an offset
  change rebinds rows and repaints every tile in them. Before `columns-virtualize-like-rows` that
  was *every modality* of each bound row, so the work per apply scaled with the modality count. It
  is now bounded by the horizontal viewport, but a wheel can still deliver several events per frame.
  Applying each one did that work N times and painted only the last, so wheel deltas are summed and
  applied once per `requestAnimationFrame`. Navigation and drags are not coalesced, because they
  must settle synchronously for the next read to be true.

  The other half is the buffer. `CAROUSEL_OVERSCAN` rows are bound beyond the viewport each way, and
  a window that outruns its buffer shows blank rows until the next bind. It is sized for a fast
  flick rather than a slow drag. An Alt notch moves `ALT_SPEED` times as far
  (`selection-centres-on-navigation`), so the buffer and that multiplier must move together. The
  horizontal axis needs no *offset* coalescing: it is a native `overflow-x` scroller the compositor
  drives, which is why it felt smooth while the row axis did not. But its scroll events still move
  the column window, and that rebind is coalesced.
- **`selection-centres-on-navigation`** — every scrollable axis in the viewer obeys one rule, in
  `webview/axisScroll.ts`: *deliberate navigation centres the selection; a wheel never does.* The
  three axes are the carousel's rows, the carousel's columns, and the modality pill row. Centring is
  `centreOffset`: centre the item, optionally snap to the item pitch, clamp to the scrollable range.
  The snap makes an arrow step move the grid exactly one item or not at all. Pills omit the snap
  because their widths differ; the two carousel axes pass it.

  The rule has two directions, and both matter. **Navigation centres**: an arrow, a digit jump, a
  Space flip, a `[`/`]` reorder or a pill click re-centres its axis. That is why `←`/`→` now moves
  the carousel horizontally at all; it did not, so at 136 modalities the selected column sat
  off-screen while the row axis tracked correctly. **Render does not**: `render()` runs on every
  image arrival and every resize frame, so centring there would fight the user's own scroll and
  override the resize anchor. Hence `updateCarouselSelection` takes `centerOnCurrent` and `render()`
  passes `false`. A new centring call site belongs on a navigation path.

  The one paint-path exception is the carousel's `ResizeObserver`, which re-centres the row axis
  when `clientHeight` *changes*: the visible-row window is derived from it, and it is 0 until the
  viewer unhides. It is guarded to height only because a width drag must not re-centre; the resize
  anchor owns that. Any other paint-path centring is a bug.
  `ALT_SPEED` lives in the same module because it has the same one-meaning-everywhere property, and
  the two kinds of axis need different arithmetic to honour it. Scrolling is linear, so Alt
  multiplies the delta; zoom is multiplicative, so Alt *compounds* the step (`step ** ALT_SPEED`).
  Scaling the zoom step by 5 instead would make Alt mean a different amount of movement on the image
  than on the strips, the bug the shared module exists to prevent.
- **`empty-comparison-is-terminal`** — a comparison with no rows *or* no columns left renders a
  terminal notice:
  - the spinner off
  - **every** surface that can carry the last frame cleared: the canvas hidden *and* the floating
    panel's minimap (plus its viewport rect). The minimap is a second copy of the same image and was
    exactly the "preview of the very last image it saw" in the report.
  - no request issued: nothing would answer one, and the reply is what clears a spinner
    (`reply-exactly-once`)

  It is raised at one site, from a pure decision (`webview/emptyNotice.ts`), so both shapes and all
  three modes reach the identical state. It is terminal only for as long as the emptiness is. The
  same site clears it, the row and column add handlers re-aim the cursor at arriving content when
  they end the empty state, and the host side of that return is
  `docs/file-watching.md: root-return-re-adopts`. A notice that survives the folder's return is a
  worse bug than the spinner it replaced.
- **`reply-exactly-once`** — every `requestImage` yields exactly one terminal reply (`image` or
  `imageError`), re-addressed to the slot the file occupies at delivery. When the file has left the
  view, the reply still goes to the enqueued slot (even one that no longer exists, which the webview
  discards), unless another file has taken that slot. A taken slot is healthy, and marking it
  missing would blank it for good, since the webview never re-requests a filled slot.

  The only panel-alive silences are that occupied-slot case and the two ways an off-screen reply
  parked in the hold is discarded: the burst cap's eviction, and a column splice dropping the hold
  wholesale (`held-payloads-always-flush`). Both are discharged by the same `loadTuple` re-request on
  revisit, and the splice itself makes the webview re-run it. Nothing polls for a missing reply. A
  dropped one clears only when something re-enters `loadTuple(currentTupleIndex)` (navigating away
  and back, deleting some *other* tuple, or a modality add/remove), or when a watcher-driven
  `fileRestored` re-requests that slot. Clicking the current carousel row does not.

  The XOR half of the discipline (one terminal reply computed first, then posted exactly once) is
  owned by the shared `serveImage` orchestrator (`src/imageServe.ts`), which both products drive
  through IO. The provider's slot re-addressing, cache writes and burst holds are delivery-side IO
  around it. A pool cancellation is not a silence, because a cancelled serve never started (its flow
  is not live).
- **`held-payloads-always-flush`** — during a scrub burst (last `setCurrentTuple` younger than
  150ms), `image` payloads for *off-screen* tuples are parked instead of posted: a multi-MB message
  deserializing on the webview main thread measured 10-22ms, right in the scroll animation's frame
  budget. Two halves, both load-bearing. The current tuple's payloads are **never** held (holding one
  is a stuck spinner). Below the parking map's 48-entry cap, every parked payload is delivered.
  Landing on its tuple flushes it immediately. Otherwise the burst-end timer re-arms until the scrub
  quiets, then drains one payload per ~32ms tick (a bulk flush just moved the spike to scrub-end).

  Four paths discard:
  - panel dispose
  - the cap evicting the oldest payload
  - slot invalidation (`slot-invalidation-clears-the-wire`), the only one that discards for a slot
    which still *exists*, because its bytes no longer do
  - a *column* splice, which renames every slot key (`docs/file-watching.md: reindex-in-lockstep`)

  A *row* splice re-keys the hold instead, so a held payload is never flushed into another file's
  slot. The eviction is safe only because of two webview behaviours, which are therefore
  load-bearing. Spinners show solely for the current tuple, whose payloads are never held. And
  `loadTuple` re-requests every uncached slot on revisit (`requestMissing`); delete that re-request
  and a cap drop becomes a permanent hole instead of a deferred re-read.
- **`image-payload-normalized`** — the bytes handed to `postMessage` are a tight, plain `Uint8Array`
  (`normalizeImageBytes`, pinned by `wireFormat.test.ts`), on **both** payload paths, `image` and
  `thumbnail`, in both products. The thumbnail path is the sharper trap. A pack hit is a `Buffer`
  *slice* of the one shared packfile buffer (`thumbPack.ts`), so an un-normalized post ships the
  whole pack per tile. A `Buffer` subclass risks the serializer JSON-mangling it into
  `{type:"Buffer",data:[…]}`, which decodes to nothing and reads as "Image not available". Note that
  `Uint8Array.prototype.slice` on a Buffer returns another Buffer (species constructor), so a slice
  is not an escape. An offset view ships its whole backing allocation.
- **`user-pushes-never-withheld`** — the transport budget delays only speculative pushes. Every
  `sendImage` reply goes to `postMessage` in the turn it is ready, whatever the bytes in flight. This
  includes the visible image, its siblings, and crop and export refreshes (`postImage`'s
  speculative-only branch; `TransportBudget.canSend` short-circuits on the flag before it looks at
  anything else). User-facing bytes are still *counted* against the budget (`postImageNow`); that
  half makes speculation yield to them. Invert either half (gate a user push on the budget, or stop
  counting user bytes) and the pool's priority ladder is undone one layer higher, silently. Nothing
  errors and the viewer is just slow again, which is how this shipped unnoticed for months.
- **`speculation-yields-the-wire`** — no speculative full-image push is *admitted* to the channel
  while an open-time thumbnail sweep is draining. Outside a sweep, one is admitted only while at most
  `imageCompare.prefetchTransportBudgetMB` of counted bytes are in flight (a single over-budget push
  may go alone, or a 16 MB image could never be sent).

  The gate is **admission**. Once the budget has admitted a payload, the scrub-burst hold
  (`held-payloads-always-flush`) can park it, and **both** of the hold's exits reach the wire
  without re-checking `canSend`. `scheduleBurstFlush` trickles one payload per ~32 ms, and the
  arrival flush in `setCurrentTuple` empties *every* held payload for the arrived tuple in one turn.
  The second is the larger excursion. Its worst case is one whole tuple's images at once (six 16 MB
  modalities ≈ 96 MB against an 8 MB budget), so the bound holds on admission, not on instantaneous
  bytes in flight. Re-gating either flush is *not* the fix. It would either withhold user-facing
  held payloads (breaking `user-pushes-never-withheld`, since the hold does not record which pushes
  were speculative) or need a re-park loop around the one timer that keeps a scrub responsive.

  The sweep claim is raised in `generateAllThumbnails` and released only through `endSweep`: the
  sweep's settle, a synchronous throw out of its prologue, the idle stall watchdog, or panel
  dispose. A parked push is delivered when the budget frees, or dropped:
  - when the user has left its tuple
  - when the 64-entry park overflows
  - when a column splice renames its slot
  - when the slot is invalidated (`slot-invalidation-clears-the-wire`)
  - on dispose

  It is never leaked, and never at the cost of the *read*. The bytes are already in
  `state.loadedImages`, so the worst a drop can cost is one on-demand transfer the user would have
  paid for with prefetch off.
- **`slot-invalidation-clears-the-wire`** — invalidating a slot invalidates its *wire* copies, not
  just its bytes. `loadedImages`, the transport park and the scrub-burst hold are dropped together,
  through one funnel (`invalidateSlot`), by every path that invalidates a slot:
  - a delete when it is first seen, and again when the rename window commits it
  - a restore
  - a rename landing on the slot
  - an in-place rewrite
  - a `forceReload` retry

  The park makes this invariant-grade rather than tidiness. A payload parked while a sweep drains
  posts *minutes* after its file is gone and paints a ghost: an image under a slot that no longer
  has one. The hold does the same over ~180 ms. All three deletes are keyed by slot and idempotent,
  because the watcher, the poll and the sweep report the same removal
  (`docs/file-watching.md: duplicate-reports-idempotent`).

  The converse half is equally load-bearing: **eviction is not invalidation**. `evictDistantTuples`
  frees bytes for slots whose files are fine, so it must leave the park and the hold alone, and no
  invalidation may clear the park wholesale. The webview re-asks only for a tuple it navigates to.
  A payload dropped for a *live* slot is a transfer paid for twice, and a *held* one dropped that way
  is a reply the webview is still waiting on.
- **`wire-budget-remote-only`** — the bound applies only where there is a serialized link to share.
  `vscode.env.remoteName === undefined` (a local window) resolves to `Infinity`, which takes the
  un-instrumented path (no parking, no ack plumbing, no watchdog) whatever the setting says. That
  `undefined` is the VS Code API's own "not remote" answer, and the only cheap, honest signal
  available. Every remote kind (`ssh-remote`, `wsl`, `dev-container`, a Codespace) is a string and
  gets the bound. An explicit `0` means unlimited everywhere.
- **`visible-never-starved`** — the visible image is never starved by thumbnails, prefetch, or
  polling. Every image read/decode goes through the pool, crop and PPTX export included (at
  `EXPORT`), so nothing outranks the visible image. `VISIBLE` is exempt from the courtesy rule
  below: it takes any free slot.
- **`background-trickle`** — two rules, and a guarantee scoped to the speculative width
  (`concurrency - 1` slots). `SIBLING`/`EXPORT` leave one pool slot to lower classes while any have
  queued work. Within speculation, each freed slot goes to the queued class with the fewest running
  tasks (max-min, ties to the higher priority).

  With two or more speculative slots (`concurrency ≥ 3`), that pick bounds waits: contended classes
  converge to roughly even shares of the speculative budget. With one (`concurrency ≤ 2`), it
  degenerates to strict priority within speculation. That is a real configuration:
  `sharedWorkPool` gives a host with two or fewer usable cores exactly 1, and
  `imageCompare.maxConcurrentReads` can pin any host there. A speculative task is then admitted only
  when none is running, so every successful pick is an all-zero tie the higher-priority class wins,
  and a prefetch wave re-takes the lone slot on each completion until its queue drains.

  The one slot that idles by design is the foreground reservation: under speculation-only load one
  slot stays free for user-facing arrivals (workPool Test 11 pins it). Two weaker versions shipped
  first, and both starved the sweep measurably. Strict priority froze it for a wave's whole duration
  (15s dead progress bar). A one-slot courtesy left it 1-wide, where a single slow NFS read stalled
  the bar head-of-line. Breaking either rule re-introduces stall-then-burst.
- **`pool-width-hides-latency`** — the pool width is a *dispatch* width, and admission is not
  execution. Sharp holds one libuv thread per operation (`sharp.concurrency()` is 1 on a glibc build
  without jemalloc, by sharp's own rule; jemalloc would raise it and make over-dispatch worse). The
  real decode ceiling is therefore the extension host's libuv pool: 4 threads, which we cannot raise
  from inside the host. Setting `process.env.UV_THREADPOOL_SIZE` at runtime is measurably ignored;
  only the exec-time environment counts, and that one is VS Code's.

  Everything dispatched past that ceiling waits in a FIFO the priority ladder does not reach. At
  width 16 with 15 sweep tasks running, a `VISIBLE` decode took **2799 ms** (9.9× its 283 ms solo
  cost) and an unpooled `fs.stat` **2201 ms**. At width 4 the same workload gave **525 ms** and
  **0.4 ms**, for the same throughput (90 real images: 2764 ms at width 6, 2794 ms at 16). Width
  above the ceiling buys nothing and costs interaction latency.

  So `poolWidth` in `workPool.ts` is one slot at parallelism <= 2, else `min(parallelism - 1, 4)`
  saturating slots plus 2 of dispatch slack: 1, or 4..6. The floor is 1 on a 1-core box; the slack
  covers the JS round-trip that refills a freed libuv thread. `sharedWorkPool` feeds it
  `usableParallelism(os.availableParallelism(), os.cpus())`, never `os.cpus()` alone. On a cgroup-
  or affinity-limited host (SLURM, Docker `--cpus`), `os.cpus()` reported 256 logical cores for 4
  usable ones and turned the old `min(16, cpus - 1)` into width 16.
  `imageCompare.maxConcurrentReads`, read by `sharedWorkPool`, is the escape hatch for a host whose
  libuv pool really is bigger.

  Reads are the part width still hides. But warm reads are ~118–468 ms against ~3000 ms of decode
  over the same corpus, so hidden mount latency is a secondary effect, not the sizing rule (the
  earlier claim that Sharp "decodes on its own thread pool" was false). The `readDirectory` calls on
  the crop and export paths are not pooled and need not be. The sweep's own listing and existence
  checks are, at `POLL`, and so is adoption when the sweep triggers it.

  The rule is shared with the standalone build, which feeds `poolWidth`
  `navigator.hardwareConcurrency`. There the tasks are in-page canvas decodes with no libuv in the
  picture, so width buys decoder-competition fairness between priority classes, not hidden mount
  latency. The same shape applies, so neither product can quietly diverge.
- **`thumbnails-centre-out`** — the open-time sweep dispatches slots by distance from the **tile**
  the user is on (the tuple *and* the modality column), and re-aims as soon as either moves and the
  user settles there (`sweep-centre-dwells`). The remaining work is re-ordered, never finished in the
  old order first. What that distance means is `sweep-cross-then-row-major`. A host that supplies no
  aim gets the first tile of the plan, where its own order starts.

  Three sites: the ordering itself (`thumbnailPlan.ts`) and the aim each host feeds it
  (`imageCompareProvider.ts`, `standalone/adapter.ts`). A host that stops passing its live tuple
  silently restores the 746×10 pathology. One that stops passing its column silently sweeps the
  strip's first modality instead of the one on screen. Either way the sweep still works, in the
  order the user is least likely to want. The column half must be **un-permuted** before it becomes
  an aim (`modalityOrder[currentDisplayIndex]`, not the display position; `sweepAimPolicy.noteStrip`).
  A display index passed on as a modality index aims at whatever column sits at that original
  position: silently correct on an un-rearranged strip, silently wrong on a rearranged one
  (`docs/tuple-matching.md: wire-index-is-original`).
- **`picked-column-reports-itself`** — the aim's column is reported when the user *picks* it, not
  when its tuple finishes loading. **Every** route that picks one reports:
  - a carousel tile
  - a pill
  - the arrows
  - the digits
  - a `[`/`]` reorder, which moves no column but re-permutes the strip the aim ranks neighbours over

  `tupleFullyLoaded` fires only once every modality of a tuple has arrived. On a wide cold session
  it is far away or never comes, and until then the aim keeps its last column: the strip's first
  (column 0) when it never had one. Each route therefore posts `setCurrentModality` (the strip as
  displayed) unconditionally, even when the picked column is already on screen, because no report
  may have carried it yet.

  The routes differ only in *when*. A click that names a column is a settled destination and
  reports at once. A move that can repeat reports on a trailing-edge dwell of `LOAD_DEBOUNCE_MS`:
  exactly one report per settled keypress, exactly one per held burst. A pick cancels a burst still
  waiting rather than letting it land after the click and aim back at the column the user left. The
  `Space` peek is the one deliberate exclusion, described above.

  That dwell is the webview's rather than the policy's, and both halves of the reason are
  load-bearing. The policy cannot tell a pick from a burst (one message shape). And gating at the
  source is only *available* here because `setCurrentModality` has a single consumer, where
  `setCurrentTuple` has a second that must stay ungated (`sweep-centre-dwells`). **Both** hosts
  forward the report to the same `SweepAimPolicy.noteStrip`, which un-permutes it
  (`docs/tuple-matching.md: wire-index-is-original`).
  Four sites, each silently leaving the sweep filling a column nobody is looking at:
  - the gate that decides when a report goes out (`webview/tupleLoadPlan.ts`)
  - the post and the routes that drive it (`webview/main.ts`)
  - the two host handlers (`imageCompareProvider.ts`, `standalone/adapter.ts`)

  A host that drops the message reproduces the bug in that product alone, the asymmetry the shared
  policy was made to prevent (`docs/standalone.md: host-supplies-data-not-policy`). A route that
  reports through neither half of the gate reproduces it in both. The report claims nothing about
  loading, so it must not be `tupleFullyLoaded` with a lie in it: that message also drives prefetch
  (`prefetch-scoped-to-the-visible-column`).
- **`sweep-cross-then-row-major`** — the order from that aim, and every tie-break in it. First the
  focused tile, then its **cross** (the focused row's other columns and the focused column's other
  rows). The cross is taken **one slot from each arm in turn**, never one arm drained before the
  other (the whole point of the round), row arm first, each arm forward-first on a distance tie.
  The **column arm is bounded** at one screenful of carousel rows and the row arm is not. Past a
  screenful the column is no longer on the user's screen, while every column of the focused row
  always is. An unbounded arm is not a milder version of this rule but the defect it was measured
  against: it walks to the end of the grid before anything else is filled.

  Everything the cross did not reach then fills **row-major centre-out**: rows by distance, forward
  first on a tie, each row whole, columns in the cross's own rank order. That order fills a viewport
  bounded in rows and unbounded in columns. A taxicab remainder was measured and rejected, since it
  spends on rows outside the viewport. The remainder enumerates the *whole* grid, so coverage never
  depends on the radius; a wrong radius mis-orders and nothing more (`sweep-covers-every-slot-once`).

  The radius is the webview's reported `visibleRows` (`tupleFullyLoaded`, `setCurrentModality`),
  floored at one row, falling back to `SWEEP_CROSS_RADIUS` when a host reports none. It cannot be a
  constant alone, because a screenful ranges from ~7 rows to ~64 with the modality count. Column
  distance is display distance. The aim carries the strip (`modalityOrder`), and hidden columns rank
  after every visible one but are still swept, since the carousel keeps showing them
  (`docs/session-files.md: hidden-is-presentation-only`). The focused column keeps the head of the
  order even when hidden, because a click or digit jump lands there.
  Every one of those rules fails silently and differently:
  - drain an arm, and the adjacent row waits for the whole strip again
  - invert the arm order, and the tile beside the one on screen loses a turn
  - unbound the column arm, and the viewport fills last
  - make the remainder scanline instead of centre-out, and the row above the focus waits for the grid
  - ignore `modalityOrder`, and a rearranged strip sweeps the wrong neighbour
  - rank a hidden column like a visible one, and a column nobody looks at takes the front of the
    sweep

  Five sites: the ordering, the ranking and the radius floor (`thumbnailPlan.ts`), the screenful the
  webview measures (`webview/main.ts`) and the two hosts that carry it (`imageCompareProvider.ts`,
  `standalone/adapter.ts`).
- **`sweep-centre-dwells`** — the sweep's centre is a *settled* current tuple, never the raw
  `setCurrentTuple` stream. `SweepAimPolicy` (`src/sweepAimPolicy.ts`) holds a settled tuple
  assigned from the raw one on a trailing-edge dwell of `LOAD_DEBOUNCE_MS`, while
  `cancelImageLoads` stays on the raw message. One message, two consumers, opposite latency
  requirements. A stale full-image load must die at once, and a sweep that re-aims per keystroke
  chases the cursor instead of leading it (the field report above: a held Down over a cold 315×10
  grid delivered tiles at rows already passed). Any change that delays the cancellation to share
  one path is wrong in the other direction.

  The dwell is **shared, not per host**: the policy is one module both hosts import, and hosts may
  hand it data and timers only (`docs/standalone.md: host-supplies-data-not-policy`). Six sites,
  each failing silently and differently:
  - the dwell *and its reset*: a leading-edge or un-reset timer re-aims mid-burst, which is the bug
    at a coarser grain
  - the prime at sweep start: the sweep opens aimed at the row its host reports, because no
    navigation has happened, so no dwell has fired
  - the dispose: a dwell that outlives its panel or session fires against dead state and holds the
    host awake for its duration
  - the two hosts, each of which must feed the policy its raw reports and read its aim back rather
    than build one (`imageCompareProvider.ts`, `standalone/adapter.ts`)

  The dwell only decides *when the settled tuple moves*. The re-aim is still one-per-pump-pass
  (`sweep-aims-once-per-pass`), and coverage is untouched (`sweep-covers-every-slot-once`):
  re-centring is an ordering change whenever it happens.
- **`sweep-covers-every-slot-once`** — re-centring is an ordering change and nothing else. For a
  host that is still there, every planned slot is **delivered and counted exactly once**, however
  often and whenever the centre moves, and the tail is still swept when the user stops navigating.
  Coverage is conditional on that host, and on nothing else. Once it abandons the sweep
  (`sweep-stops-when-host-abandons`), the grid is deliberately left uncovered and the bar
  deliberately short of `total`: no slot is delivered twice, but the ones the cursor still held are
  never delivered. Nothing may weaken the guarantee for a *live* host.

  This is the property that made the sweep blind in the first place. Nothing re-enqueues a slot the
  sweep drops, so a lost slot is blank for the life of the panel. A duplicated one is a wasted
  decode plus a second post for a tile already shown. The cursor enforces it: the grid cell is
  emptied before its slot is dispatched, only a filled cell is ever emitted, and the walk enumerates
  every position from any aim. The progress denominator depends on it too. `total` counts each slot
  once, so a double dispatch overruns the bar and a lost one hangs it below `total` forever.

  The one dispatch that is *not* a delivery is a slot the host dropped before it started
  (`sweep-cancels-on-reaim`). It is returned to the cursor (`putBack`, before its settle) and handed
  out again. `putBack` refills its cell and discards the walk, so the re-enumeration reaches it
  again: a rewind of both axes, since the walk may have passed the cell on either. Both sites are
  load-bearing: the hand-out and the return.
- **`sweep-cancels-on-reaim`** — when the centre moves, the sweep drops the dispatches that have not
  started (`io.dropQueued` → `WorkPool.cancel`) instead of letting them deliver at the old row. At
  the field's cold cost (1 586 ms per thumbnail, 4 bulk slots) the queued 28 were ~13 s of stale
  tiles, and the floor is one running batch, ~1.6 s. Every piece is required. The drop is *keyed to
  the sweep alone* (`${poolKey}-sweep`), or a jump also cancels the panel's queued export and poll
  work. That key must therefore be cancelled on dispose/re-open as well, or the sweep's queue
  outlives its panel.

  A cancellation the host itself caused (`disposed`/`closed`) settles the slot silently, while any
  other one returns it to the cursor; invert that and a live panel loses every dropped slot. The
  dead-panel direction is now belt-and-braces: the early stop (`sweep-stops-when-host-abandons`)
  already prevents the re-dispatch loop that half existed for. Only the live direction is still
  observable, and only that half is mutation-pinned.
- **`sweep-stops-when-host-abandons`** — once the host reports the sweep abandoned (the provider's
  disposed panel, the adapter's re-opened root), the pump dispatches nothing more. The rest of the
  grid stays in the cursor instead of being read for a window that is gone, and the sweep ends at
  the batch boundary the pool is already past. Two halves, and each fails in its own direction.
  Without the stop it is pure waste: ~5 minutes of cold NFS reads behind a closed comparison,
  competing with whatever the user opened instead.

  Without the matching **exit** it is a hang. An abandoned sweep leaves `cursor.remaining > 0`
  forever, so `outstanding === 0` has to resolve it too. A host already gone at sweep start never
  dispatches at all, so the initial pump must resolve it directly. Otherwise `endSweep` never runs
  and the wire claim is held for the life of the extension host (`speculation-yields-the-wire`).
  Five sites: the stop and both exits in `thumbnailPlan.ts`, and the flag each host feeds it
  (`imageCompareProvider.ts`, `standalone/adapter.ts`). A host that stops feeding it silently
  restores the waste, since the sweep still works.
- **`sweep-aims-once-per-pass`** — one pump pass aims at one centre. A requeue uses the aim that it
  was dropped for, not a fresh reading. Both hosts pass a plain field today, so production cannot
  show either half. The rule guards the seam for a backlogged feature: a viewport-derived centre
  computed on each read (scroll offset → row).

  A centre that returns a different value on every call makes an in-loop read drop the slots the
  same pass just handed out. It makes every requeue-settle buy another drop, which produces more
  requeue-settles: a self-sustaining microtask cascade that never yields. Only the pool's running
  batch ever starts, and no timer ever fires again. Verified, not assumed: the hoist alone does not
  stop it; the requeue must decline to re-aim as well.
- **`sweep-dispatch-bounded`** — the sweep keeps at most `SWEEP_CHUNK` (32) dispatches outstanding
  and refills on every settle, rather than handing the pool the whole grid. Both halves are
  load-bearing. The bound keeps re-centring *cheap*: the pool never re-orders or promotes a queued
  task, so anything submitted is frozen order and must be dropped and re-dispatched to move
  (`sweep-cancels-on-reaim`). The per-settle refill keeps it from costing throughput: the pool's
  1..6 slots always have queued work behind them until the tail. A field log showed the un-bounded
  version: `queued=[0,0,0,0,0,7293,0,4]`.
- **`bulk-sweeps-share-the-pool`** — two panels sweeping at once take turns. Within one priority the
  pool serves its groups round-robin (`WorkPool.takeNext`), each group keeping its own FIFO. Work
  that names no group shares a single bucket, so an ungrouped class is byte-for-byte the old FIFO.
  Both halves are load-bearing and each fails silently. Drop the rotation, and the tab that opened
  first drains a whole chunk before the second reads anything (measured: 28 reads, ~11 s at the
  field's cold cost, then a 50/50 split anyway): the starvation the field reported. Drop the FIFO
  *inside* a bucket, and the sweep's centre-out submit order stops being its dispatch order, the
  whole of `thumbnails-centre-out` on the pool's side.

  The fair-share key is the **panel** (`state.poolKey`), never the sweep. A key a producer can
  multiply is a lever for taking a larger share, and a panel is the unit that earns one. A provider
  that stops naming its group silently rejoins the shared bucket and starves whoever is in it. The
  adapter names its session key for symmetry only: one page is one session with nothing to share
  the pool with, so only the provider half is observable.
- **`hidden-sweep-pauses-not-cancels`** — a hidden panel's open-time sweep is **suspended**, never
  cancelled. The pump hands out nothing and returns its queued dispatches to the cursor
  (`io.dropQueued`, the re-aim mechanism). The panel resumes owing exactly the slots it owed before,
  delivering each once (`sweep-covers-every-slot-once`). The failure directions are opposite, and
  every site below is one of them:
  - The pause itself (`thumbnailPlan.ts`, plus the `paused` predicate the provider feeds it) gives
    the tab in focus the whole bulk budget instead of half. A provider that stops feeding it
    silently restores the even split with an unwatched tab.
  - The **repump** keeps it from hanging. A paused sweep with nothing outstanding has no settle left
    to reach its exit, so the host must re-enter the pump whenever its `paused`/`abandoned` answer
    changes. On hide, or the pause waits for a settle that may never come. On show, or the grid is
    never finished. On dispose, or the promise never resolves, `endSweep` never runs and the wire
    claim is held for the life of the extension host (`speculation-yields-the-wire`).
  - The runner's start-time exit must decline to fire for a paused host, or a panel that opens
    hidden resolves its sweep instantly with a blank grid.

  The standalone passes neither predicate: a browser tab is the session, so it has nothing to pause
  for.
- **`no-sync-blocking`** — no unbounded synchronous CPU/FS work on the extension-host thread. The pool
  bounds *concurrency*, not event-loop time: PPTX export base64s every full-res image synchronously
  inside its pooled task, and deflates the zip outside it, so a large export is still felt on the
  host thread.
- **`hidden-keeps-work`** — hiding a panel must not cancel its image or thumbnail work; only the
  speculative prefetch wave may be dropped. "Free resources when hidden" looks obviously right and is
  the exact bug. The webview is retained across a hide and nothing re-requests on re-show, so a
  cancelled load is a spinner nobody ever clears. The one thing hiding may do is **defer**: the
  open-time sweep pauses and resumes with every owed slot still owed
  (`hidden-sweep-pauses-not-cancels`). That is the opposite of dropping work. No slot leaves the
  cursor, no request goes unanswered, and the panel's cached bytes, queued image loads and held
  payloads are untouched either way.
- **`debounce-leading-edge`** — the navigation debounce stays leading-edge; a trailing one still
  coalesces rapid stepping but taxes every isolated navigation 150ms.
- **`siblings-dwell-gated`** — a tuple arrival requests **only the modality on screen**. Every other
  modality waits for a dwell (`LOAD_DEBOUNCE_MS`, the navigation debounce reused) that the next
  navigation clears, so a tuple the user scrolls past never asks for its siblings. Three parts are
  load-bearing, and each fails silently:
  - the arrival plan itself (`tupleLoadPlan.ts`)
  - the timer's arming *and* its clearing on every `loadTuple` (`webview/main.ts`). An unarmed
    timer means siblings never load; an uncleared one restores the flood one tuple later.
  - the `VISIBLE` re-request `render()` issues for an empty current slot. It makes an in-dwell
    modality flip cost one image instead of a permanent spinner. Nothing else re-requests: the
    webview never re-asks for a filled slot, and `loadTuple` only runs on tuple change.

  The regression this trades for is deliberate; the pathology it removes is 10 full-resolution
  loads per tuple *passed*.
- **`request-rank-upgrades`** — a request for a slot whose outstanding request ranks **below** the
  rank now needed must be re-posted at the higher rank. `requestedSlots` therefore records the rank
  each unanswered request carries. The suppression guard in `requestSlot` fires only when the
  stored rank is at least as high as the one wanted. The `render()` empty-slot branch needs it,
  since a modality flip after the dwell lands on a slot already asked for at `SIBLING_TAIL`.

  Nothing else can save it. Both hosts map the wire rank to a pool priority once, at submit, and
  the pool has no bump. A suppressed re-ask leaves the on-screen tile under the tail's "only when
  nothing else is queued" admission rule: a spinner for the sweep's whole duration (measured on a
  746×10 session; the pre-`SIBLING_TAIL` code served the same flip at `SIBLING`). The accepted cost
  is one duplicate decode per flip onto an undelivered slot, described in the request-path section
  above.
- **`sibling-order-by-display-distance`** — siblings are ordered by distance in the **display** order
  (`modalityOrder`, user-rearrangeable), hidden pills skipped both as targets and as steps, forward
  before backward at equal distance. The one `→` reaches must arrive first. Raw modality ids
  mis-order a rearranged or partly hidden column set, and the failure is invisible: everything still
  loads, in the order the user is least likely to want.
- **`sibling-tail-never-competes`** — modalities past the nearest two ride `SIBLING_TAIL`, admitted
  only when **no other priority class has queued work** (`canStart`, exempt from both the
  concurrency-1 waiver and the speculative fair-share pick). A rank merely "below `PREFETCH`" would
  still outrank `THUMBNAIL_BULK`. Even at equal rank, the max-min share of `background-trickle`
  would hand the tail half the sweep's slots: the starvation this whole policy exists to end. Both
  hosts map the wire's `tail` flag onto it (provider and standalone adapter); dropping the flag on
  either side silently restores `SIBLING`.
- **`prefetch-scoped-to-the-visible-column`** — a prefetch wave speculates only on the modality
  column on screen plus the nearest siblings `sibling-order-by-display-distance` names, never a
  hidden column, and never the whole tuple. The breadth is *derived*, not restated. `prefetchPlan.ts`
  calls the current tuple's own `siblingLoadPlan` and keeps the entries it ranks `sibling`, so the
  two policies cannot drift into two ideas of "nearest".

  Both halves are load-bearing and each fails quietly. The webview must report the strip it is
  displaying with every `tupleFullyLoaded` (order, current display index, hidden set). The
  extension has none of it, and a wrong or missing report silently speculates on the wrong column.
  The provider must let the plan pick the slots rather than looping the modality array. The
  pathology it removes, measured at the field's shape: 69 slots and 164.5 MB per wave, of which a
  five-tuple browsing trace displayed 4 %.
- **`prefetch-visible-column-first`** — the wave is issued **column-major**: every tuple in the band
  at the on-screen column, then every tuple at the first sibling column, and so on. Tuple-major
  ordering made prefetch *slower than no prefetch* for the step it exists to serve. The `+1` tuple's
  visible column queued behind the centre tuple's other nine, so the first neighbour step was a
  cache miss at 1022 ms against a 741 ms idle cold load. Ordering is not a nicety here: a wave holds
  `concurrency - 1` slots for seconds, so what it issues *first* is the only part that lands before
  the user moves.

  Only `tupleFullyLoaded` re-scopes a wave, so a modality switch does not re-aim it. A neighbour's
  non-adjacent columns are never pre-warmed, and the first tuple-step after a column change pays one
  cold `VISIBLE` load (measured 740 ms against 0 ms before). That is bounded to a single image at top
  priority, and the dwell policy still warms the current tuple.
- **`stale-tuple-loads-cancelled`** — image loads are keyed by tuple (`<poolKey>-image-<tupleIndex>`),
  and leaving a tuple cancels its queued ones; running tasks finish, as everywhere. Prefetch waves
  were keyed and cancelled from the start and the current-tuple loads were not, so a panel
  accumulated one queued load per modality per tuple ever visited. Every site is a way to break it:
  the key at submit, the cancel on `setCurrentTuple`, and the cancel on dispose. `pool.cancel`
  matches exactly, so `poolKey` does not cover these keys, and a panel closed mid-browse would keep
  reading files for a view that is gone.
  It is not a silence under `reply-exactly-once`: a cancelled serve never started, and `loadTuple`
  re-requests every uncached slot on revisit. The standalone adapter carries the same wiring, for
  the same reason.
- **`decode-retry-once`** — a transient decode failure re-requests the slot once rather than marking
  it missing; no sticky "not available" for a file that is present. Carousel thumbnails obey the same
  rule: an undecodable thumb payload renders the designed ✕ placeholder (never the browser's
  broken-image glyph) and re-requests its tuple once, with the guard consumed-then-re-armed per
  delivery so a permanently corrupt file cannot drive an infinite request loop.
- **`thumb-url-owned-by-cache`** — a thumbnail object url is owned by the webview's slot map
  (`webview/thumbUrlCache.ts`), never by the `<img>` showing it. The map revokes a url exactly when
  its key stops pointing at it (superseded, placeholdered, deleted, dropped by a re-key, cleared on
  re-init), and nothing else revokes. A pooled row that revoked what it was recycling away from
  would blank a tile another row still shows. A map that revoked nothing would pin one blob per tile
  for the life of the panel.

  Two halves look incidental and are not. The successor reaches the map and the tile *before* the
  superseded url is revoked: revoke-first aborts a decode already in flight, which surfaces as the ✕
  placeholder. And the shared ✕ placeholder data url is stored like any value but never revoked.
- **`empty-tile-never-broken`** — a carousel tile whose slot has no thumbnail carries the shared
  transparent `BLANK_THUMB` data url (`webview/thumbUrlCache.ts`), never an absent `src`. Removing
  the `src` of an `<img>` that already loaded one leaves it in the browser's *broken* image state.
  Chromium paints its broken-image glyph there and fires no `error` event, so the ✕ fallback
  (`decode-retry-once`) never runs. Nothing in the DOM tells the tile apart from a blank one:
  `naturalWidth` is 0 and `complete` is true either way.

  Pooled rows are recycled from delivered rows onto not-yet-delivered ones on every scroll. The
  whole not-yet-loaded region below the sweep then fills with glyphs, interspersed with the
  correctly blank tiles of rows that never held an image. The blank must also *decode* (1×1, fully
  transparent): an undecodable one would fire `error` on every empty tile and drive the retry path
  instead.
- **`render-from-loaded-tuples`** — `render()` never trusts the module-level `images`; it re-derives
  from `loadedTuples` for the current index, or a *previous* sample's frames appear under the current
  sample's labels.
- **`panel-keys-never-reused`** — panel keys are never reused (`nextPanelKey()`'s counter is
  process-global), or one panel's cancellation silently strands another's.
- **`debug-off-costs-nothing`** — with `imageCompare.debug` off, every instrumentation site costs one
  cached-boolean read and nothing else. No message string is built (the sinks take a thunk, not a
  formatted line), no clock is read, no counter is updated, no snapshot timer exists. The flag is
  cached in `debugLog.ts` and refreshed from `onDidChangeConfiguration`, never read per call. The
  matcher alone calls its logger thousands of times per open, which made a per-call
  `getConfiguration` worth removing.

  This property rots silently. Instrumentation that is free today acquires an eager template string
  tomorrow and nobody notices, because the numbers still look right when it is on. The sites the
  rule binds:
  - the sink itself (`debugLog.ts`)
  - the matcher trace and the scan's own numbers (`fileService.ts`)
  - the per-thumbnail tier accounting (`thumbnailService.ts`)
  - the sweep, pool, wire, prefetch and open-trace instrumentation (`imageCompareProvider.ts`)

  The open trace is the sharpest case. Sizing the `init` payload costs a whole `JSON.stringify` of
  it, so the trace object must not exist at all with debug off. Its absence, not a flag re-read,
  gates every mark and the sizing pass.
- **`open-spans-account-for-the-whole-open`** — the `[IC-OPEN]` rollup's spans are differences
  between marks taken on the open path, and whatever time they do not cover is printed as `other`,
  never folded into a neighbouring span. That is the point of the line. The 6.96 s that motivated it
  was invisible because it belonged to no instrumented step, so a scheme reporting only the steps it
  knows about would have reported the same silence. A step added to the open without a mark grows
  `other`: visibly wrong rather than silently mis-attributed.

  Two corollaries the line lives or dies by. A mark must be taken *at* the boundary it names, since
  moving one silently migrates time between two spans that both stay plausible. And the last mark
  is the sweep's own clock, so the open rollup and `[IC-SWEEP]` are contiguous and no millisecond
  escapes between them. The sites are the formatter (`debugLog.ts`), the marks and the emission
  (`imageCompareProvider.ts`), and the scan's file count and nested matcher time, which only the
  scan can measure (`fileService.ts`).
- **`shared-waits-are-not-per-item-work`** — a tier's `ms` in the histogram counts only that item's
  own work. Time spent blocked on a wait *shared* with other in-flight calls — today exactly one, the
  one-off `thumbs.pack` read behind `ensurePackLoaded` — is subtracted from every waiter and reported
  once, as `packLoad=<n>x<ms>/<bytes> blocked=<callers>/<summed wait>`. A warm 9x10 open printed
  `pack=83/385.1KB/8118ms` for a sweep that finished in 658 ms wall: one ~600 ms NFS read, charged in
  full to each of the 83 callers awaiting the same promise, which reads as a slow tier when the tier
  is ~12x faster than stated. Memory hits are exempt by position (they return above the load); pack,
  disk and generated all sit behind it, so all three subtract. The sites are the subtraction and the
  one-off measurement (`thumbnailService.ts`), the formatter (`debugLog.ts`) and the sweep rollup
  (`imageCompareProvider.ts`). The general rule outlives the packfile: any future shared await must
  be measured where it happens and reported once, never N times through its waiters.
- **`idle-poll-logs-nothing-new`** — the existence poll prints its pool snapshot only when the pool is
  doing something, or when the snapshot changed since the last one printed. The poll runs every 10 s
  for the life of a visible panel. An unconditional line grew an idle remote session's channel
  forever with identical `active=0/16 run=[0,…] queued=[0,…]`, the shape a reader scrolls past to
  find the sweep. Silence here means "idle and unchanged". A busy pool still prints every cycle even
  when its numbers repeat, and nothing else the poll finds (deletions, arrivals, adoption) is gated.
