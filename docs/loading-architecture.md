# Loading Architecture

How ImageCompare gets pixels onto the screen, and the rules that keep it responsive.

Code: `workPool.ts` (scheduling), `imageCompareProvider.ts` (`sendImage`, `generateAllThumbnails`,
prefetch, the existence sweep), `thumbnailService.ts` (`loadFullImage`, `getThumbnail` — the actual
reads and decodes; the provider only schedules them), `webview/main.ts` (`loadedTuples`, `render`).
Pinned by `src/test/workPool.test.ts`, which imports the real source.

## Why this exists

The viewer used to show sporadic ~10s spinners — not one bug but the absence of scheduling
discipline. Every kind of work (filesystem poll, the whole session's thumbnails, neighbour prefetch,
the on-screen image) ran eagerly and unbounded on one thread and one 4-thread libuv/Sharp pool, FIFO
with no priority; on a network/FUSE mount a *synchronous* existence sweep froze the event loop
outright. The request protocol was separately best-effort: some paths posted nothing on completion,
and the webview never re-asks for a tuple it holds — so a dropped reply = a stuck spinner.

## Principles

Bounded · Prioritized · Cancellable · Identity-checked · Guaranteed-response.

> Scope note on "identity-checked": *image* replies are not identity-*addressed* — no request id is
> echoed back, and `slotMatchesUri` guards only the *cache write*. Addressing is by slot: every image *reply* and every thumbnail
> delivery re-resolves its slot from the enqueued hint, falling back to the file's URI, so a re-index
> redirects it rather than misfiling it. Prefetch pushes are the exception — they post at the enqueued
> index, and `slotMatchesUri` drops them outright when the slot moved.
> The residual gap is no longer a misfile — the hint keys on the modality *name* and falls back to an
> exact-URI search, so any slot returned genuinely holds that file. What remains is ordering: two
> in-flight loads for one slot are unordered, so a slower read of older bytes can land after a newer
> one and pin the stale frame in the cache. A request id, or a per-slot generation, is the fix if it
> ever bites.

## The work pool (`workPool.ts`)

One process-wide `WorkPool` (`sharedWorkPool()`) that every **display** read/decode goes through —
full images, thumbnails, and the existence poll. Sized `max(1, min(16, cpus-1))` (the floor matters on
a 1-core box; the 16 is deliberate width — see `pool-width-hides-latency` below). Every comparison tab shares it, so N open tabs cannot multiply load.

- **Priorities** (`VISIBLE < SIBLING < EXPORT < PREFETCH < THUMBNAIL < THUMBNAIL_BULK < POLL`). Strict
  ordering: the image on screen never waits behind prefetch, the carousel, or the sweep. Ordering
  governs only the queue, though — a running task is never interrupted — so speculative ranks
  (`PREFETCH` and below) are additionally capped at `concurrency - 1` running slots (`canStart`).
  One slot always stays clear of speculation, so above concurrency 1 speculative work on its own
  can never delay a `VISIBLE` arrival — it finds a slot free unless work ranked above `PREFETCH`
  holds the rest of the pool; at concurrency 1 every reservation is waived, since it would
  starve a whole class outright. The courtesy also runs downward, in two forms
  (`background-trickle` below): `SIBLING`/`EXPORT` leave one pool slot to lower classes while any
  have queued work, and *within* speculation each freed slot goes to the queued
  class with the fewest running tasks (max-min fair share, ties to the higher priority) — so a
  prefetch wave with the sweep and the existence poll both queued splits the speculative budget
  roughly evenly instead of freezing the sweep.
  `THUMBNAIL` is a targeted re-request — `sendThumbnails` (a `requestThumbnails` message) and
  `regenerateThumbnail` (one slot a watcher touched — changed, restored, renamed, or newly placed —
  or one the existence sweep placed while adopting a new modality directory). Every *thumbnail* delivery resolves its slot at the
  moment it lands (`resolveSlotForUri`; `docs/tuple-matching.md: revalidate-slot-before-write`), so a
  re-index between enqueue and delivery redirects the result rather than discarding it. Image loads do
  too — `sendImage` re-resolves before posting. Only prefetch still drops on a moved slot, since
  nobody is waiting on it.
  `THUMBNAIL_BULK` is the open-time sweep, ranked below
  it so a small, freshly-invalidated batch can't queue behind thousands of sweep items. Nothing here is
  scroll-driven: the carousel is built eagerly for every tuple and the only scroll listener is
  cosmetic. `requestThumbnails` is posted on tuple add (that row) and on modality add/remove (every
  row) — not on visibility, and not on tuple delete, where the webview re-indexes its own thumbnail
  map instead and the extension re-sends nothing.
- **FIFO within a priority** — load-bearing: the sweep is submitted in scanline order (tuple-major,
  then modality), so thumbnails *start* top-to-bottom (the intended UX), below every foreground
  priority (only the existence sweep's `POLL` ranks lower). It is
  FIFO *start* order — with any concurrency above 1 and varying decode times a later item can finish
  first, so the fill is approximate, skew bounded by the sweep's running-slot window: `concurrency - 1`
  (the speculative-rank cap above, waived at concurrency 1), where the pool's concurrency is `cpus-1`
  capped at 16.
- **`cancel(key)`** drops queued (not-yet-started) tasks; running tasks always finish. Keys scope
  work per panel (`state.poolKey`) and per prefetch wave (`state.prefetchWaveKey`). Matching is
  exact string equality, so both keys must be cancelled explicitly.
- **Panel keys must be unique for the process lifetime** — hence `nextPanelKey()`'s counter is a
  module global beside the shared pool, not per-provider state. The pool outlives any panel, so a
  reused key lets a new panel's `cancel(poolKey)` drop an older panel's queued tasks, stranding *its*
  spinners with no error.
- **No aging.** A continuous stream of high-priority work would starve low priority forever. That is
  safe only because every producer here is finite; see the note in `workPool.ts`.

`workPool.test.ts` pins the concurrency cap, priority + FIFO/seq ordering, cancellation semantics
(keyed items dropped, survivors ordered, running untouched), sync-throwing tasks, re-entrancy, and
error propagation.

### Crop and PPTX export: pooled at `EXPORT`

Both are user-triggered, so they rank above speculation (`PREFETCH` and below) and below what is on
screen. Neither can fan out without bound — which is what they used to do — and neither can queue
ahead of a visible load. What `EXPORT` does *not* buy is preemption, and it buys less
exclusion than it looks. A PPTX export is a strictly sequential producer — each pooled task is
awaited before the next is submitted. The awaiter resumes one microtask *before* the `.finally` that
decrements `active` and pumps, so the export's next task is already queued, at `EXPORT`, when the
slot frees. That only excludes anything while consecutive submits sit in the same async function:
`addCropSlide`'s return adds a hop, the pool pumps in that gap, and queued speculation takes the
slot. And it holds only *one* slot of `max(1, min(16, cpus-1))`, so above concurrency 1 the rest stay
open regardless. Measured against the real pool: at cap 1 a same-function loop yields
`E E E E BULK`, the same loop through `addCropSlide` yields `E BULK E E E`, and cap 2 and cap 4 both
yield `E BULK E E E`. Crop is the fan-out case: `Promise.all` submits one task per modality at once, so a wide tuple
fills the foreground budget for a round — the whole pool, or one slot less while background work is
queued (`background-trickle`). The pool is process-global, so this
crosses panels. Bounded, because every export producer is finite.

**Crop.** `handleCropImages` still calls `Promise.all(tuple.images.map(...))`, but each modality's work
is one pooled task, so a wide tuple queues rather than launching every decode at once. Inside a task
it is still *two* full-res reads (`getImageDimensions` then `cropImage`, each re-reading the file) plus
one extract-and-encode — the pool bounds concurrency, not the per-image cost.

**PPTX export.** `loadImageBase64` is pooled per placed image and `readCropMetadata` once per crop slide: a full-res decode
plus a capped-and-recompressed JPEG re-encode (`docs/crop-and-pptx.md: deck-images-bounded`), at least once per voted tuple × modality, twice on crop slides
(crop and parent). The worst branch is a voted parent with several unvoted crops — one slide per crop
*per modality*, so 2·N full-res loads per modality rather than one. Long-lived rather than bursty.

What the pool does **not** cover, deliberately: the base64 of each result is synchronous
(`docs/image-backends.md`, "Why the sync/base64 work matters"), so a large export is still felt on the
extension-host thread; the zip deflate at the end of an export (`pptx.writeFile`) is outside the pool
too, and is the single largest CPU event of a large export; and the directory listings on the crop
and export paths are not pooled — `getNextCropNumber`, which runs once per modality rather than once
per crop, and the export's single `readdir` of the output directory — because the pool exists to
bound image reads and decodes (memory, CPU and network round trips per *image*), not metadata calls.
The `fs.watch` probe's `access` 50ms after a rename event is unpooled for the same reason. Adoption cuts the other way: reached from the sweep, its
`stat` and listings run *inside* the sweep's own `POLL` task; reached from either watcher, they are
unpooled. The sweep's own `readDirectory` and `access` calls ride at `POLL` too, so they cannot
outrank anything.

## Request path (the image on screen)

`webview loadTuple` → `requestImage` per uncached modality → `sendImage` → pool @ `VISIBLE` →
`loadFullImage` → post `image`.

- On this navigation path, only the **currently displayed** modality is submitted at `VISIBLE`;
  siblings ride at `SIBLING`. (Mutation/restore paths re-send the current tuple at `VISIBLE` too.)
  That priority split (not FIFO) is what guarantees the on-screen image the first slot and stops
  tuple N's siblings queueing ahead of tuple N+1's visible image when stepping fast. The webview also
  sends the shown modality first, which only breaks ties within `VISIBLE`.
- `sendImage` replies exactly once (`image`/`imageError`) unless the panel is gone — at the file's live slot, or at the enqueued slot when that slot has been vacated — and the
  post is *not* gated on `currentTupleIndex`: the request is authoritative (the webview only asks for
  what it shows) and the extension mutates its own `currentTupleIndex` on watcher events, so gating
  there stranded the very request the user awaited. A reply for a tuple the user has left is harmless
  — the webview caches it and renders only when current.
- The tuple is **range-guarded** before use; an out-of-range index previously threw before the
  `try` and produced no reply at all.
- `slotMatchesUri` still guards the *cache write* (so a re-indexed slot can't be poisoned with the
  wrong bytes) but no longer suppresses the *reply*.

## Full-image loads bypass Sharp entirely (`loadFullImage`)

Browser-decodable formats (jpg/jpeg/png/gif/webp/bmp) pass through as original bytes, without even a
`metadata()` call; only TIFF/PPMX take the decode + PNG re-encode path. Scheduling half of the reason: the decode
and PNG re-encode run *inside* the load's already-granted pool slot — they can never queue behind the
sweep, since `VISIBLE` outranks `THUMBNAIL_BULK` — but they would hold one of the pool's few slots for
the whole re-encode, stretching the visible load and pushing sibling and prefetch work behind it. The payload half — and the rule —
is `docs/image-backends.md: passthrough-no-backend`.

So the extension sends no dimensions for these formats; the webview reads
`naturalWidth`/`naturalHeight` off the decoded image.

## Prefetch

Triggered by `tupleFullyLoaded`; loads `center ± prefetchCount` × all modalities at `PREFETCH`
priority and pushes each into the webview cache so stepping to a neighbour is instant.

- Each wave **supersedes the previous one** (`pool.cancel(prefetchWaveKey)`, done before the
  visibility bail, so a hidden panel still drops its stale wave), so neighbours of where you *were*
  stop competing with where you *are*. Note the
  trigger is `tupleFullyLoaded`, the wave's only caller — not navigation itself. Stepping through
  tuples that never finish loading never supersedes anything, so a stale wave can keep running
  underneath fast navigation; it is bounded, not cancelled.
- A completed prefetch only posts if the tuple is **still nearby** and the panel is visible —
  pushing multi-MB images for tuples you have left just delays the one you want.
- Skipped entirely for hidden panels.
- It **also evicts** (`evictDistantTuples`; bounds under "Two caches, two eviction bounds"). Prefetch is the only thing that
  drives extension-side eviction, which is why it lives here and not on the navigation path — a wave is
  exactly the moment the cache grows, so it is also the moment to trim it. It runs *synchronously at
  wave start*, in the same tick as the unawaited `loadImageToCache` calls — it trims around the **new**
  centre before any of this wave's bytes land, so what it drops is the previous wave's leftovers, never
  what this one is about to fetch.

### Two caches, two eviction bounds

`state.loadedImages` (extension) and `loadedTuples` (webview) are evicted independently, by distance
from the current tuple, at bounds that are deliberately *not* equal:

| Cache | Evicted by | Bound |
|---|---|---|
| `state.loadedImages` | `evictDistantTuples`, synchronously at the start of each prefetch wave | `prefetchCount + 2` |
| `loadedTuples` | `evictDistantWebviewTuples`, on every `loadTuple` | `prefetchCount + 3` |

The webview's band is one wider on purpose: it decides whether a navigation repaints instantly, so it
keeps recently visited tuples warm just outside the prefetch band. The extension's copy is only a
re-send buffer, and holding decoded bytes costs real memory per panel, so it trims sooner. Keep the
webview's bound ≥ the extension's — invert them and the webview asks for a tuple the extension just
dropped, turning the "instant" navigation into a silent re-read.

## Thumbnails

`generateAllThumbnails` submits every *populated* slot at `THUMBNAIL_BULK` in scanline order,
reporting progress as they land — a slot with no file is answered immediately with `thumbnailError`
and counted straight into both progress terms, plus one terminal tick when there is nothing to
enqueue at all, since the per-item
callback is the only other thing that reports and the webview hides the bar solely on `current >=
total`. It can never queue ahead of a `VISIBLE` load, and above concurrency 1 the speculative reservation
(see "The work pool") means the sweep on its own cannot delay one either — at most `concurrency - 1`
sweep items run, so a `VISIBLE` arrival finds a slot free unless other non-speculative work (anything
ranked above `PREFETCH`) holds the rest of the pool; only at concurrency 1, where the reservation is
waived, can the one running sweep item impose a wait by itself, since running tasks are never
preempted. It is *not* visibility-gated — a one-shot fire from
`sendInitData`, and cancelling or skipping it leaves blank thumbnails until something re-requests them.
Two things re-request: `requestThumbnails`, which the webview posts on tuple add (that row) and on
modality add/remove (every tuple); and `regenerateThumbnail`, which the watcher fires for a single slot
whose file changed, was restored, renamed, or newly placed — and which the existence sweep fires too,
via `adoptNewModalityDir`, for each image in a modality directory it adopts. The second is the common one — an
in-place overwrite on every training step refills that slot — so a skipped slot is not necessarily
blank for the life of the panel.

## The webview's tuple cache (`loadedTuples`)

The webview keeps its own cache of decoded frames, keyed by tuple index — the authority for what is
on screen. Three rules keep it honest.

`render()` must re-derive frames from `loadedTuples.get(currentTupleIndex)`, never the module-level
`images` — a leftover from the last tuple that finished loading, so on a still-loading tuple it holds
the *previous sample's* frames; switching modality there renders another sample's image under the
current label (a silent, plausible-looking wrong-image bug). `loadTuple` also resets `images` on entry
so no stale frame survives the navigation.

Eviction is bounded by distance, not count: `evictDistantWebviewTuples` runs on every `loadTuple`,
dropping anything beyond `prefetchCount + 3` from the current index — see "Two caches, two eviction
bounds" for why the webview's band is wider than the extension's.

The navigation debounce is leading-edge (`LOAD_DEBOUNCE_MS = 150`, guarded by `lastNavAt`): an
isolated navigation loads with *zero* delay, only rapid stepping coalesces. A trailing debounce would
coalesce rapid stepping too but tax every isolated navigation 150ms — the common case — so the shape
is the point, not the interval.

`decodeRetried` is cleared wholesale by **anything that shifts its keys** — tuple removal/insertion,
modality add/remove, and `init`. The set is index-keyed, so a shift leaves stale bits on unrelated
slots, robbing them of their one retry (`decode-retry-once`). Clearing beats re-indexing: a lost retry
bit costs a round-trip, a misapplied one a permanently "missing" image. Insertion joined the list late
— it had quietly kept the bug removal was already fixed for.

## Rendering: aspect ratio, zoom and pan

Rendering is "contain": `baseScale = min(vw/width, vh/height)`, and the drawn scale is
`baseScale * zoom`. Nothing is stretched, so images of different aspect ratios in the same tuple
legitimately render at different sizes.

`zoom` and `panX/panY` are session-global and are *not* reset when switching modality — that is the
point, you are comparing the same region at the same magnification. But `baseScale` is per-image, so
when the next modality has a different aspect ratio the same `zoom`/`pan` maps to a slightly
different region. That is a consequence of preserving the view, not a bug to "fix" by resetting.

## Decode failures

A frame can fail to decode in the webview (a partial read while a training step rewrites the file).
`img.onerror` re-requests the slot **once** with `forceReload`, making the extension drop its cached
bytes first — without that the retry gets the same undecodable payload and can never succeed. Only if
the retry also fails is the slot marked unavailable.

## Filesystem watching

Watchers are primary; the existence sweep is a fallback for mounts where they don't fire. Which
mechanism reports what, and what each event mutates, is `docs/file-watching.md`. The sweep's
*scheduling* is here, and is deliberately cheap:

- **Fully async** (`fs.promises.access`) — the old synchronous `fs.accessSync` sweep blocked the
  extension host for seconds per tick on a network mount (the ~10s spinners).
- Scheduled at **`POLL` priority** (yields to everything) — every part of the cycle goes through the
  pool: the per-file existence checks, the mode-1 new-modality-directory scan, and one listing per
  watched leaf dir that routes unknown image files to `handleFileCreated` (the only new-file detector
  on mounts whose watchers are silent).
- The new-modality scan runs **first**: it is one `readDirectory`, so putting it ahead of thousands of
  `access` calls bounds its latency at the interval instead of the duration of the existence pass.
  Adoption can inject `THUMBNAIL`/`VISIBLE` work for the images it finds, which is the point. It is
  one `readDirectory` in the steady state, plus one `stat` per base-dir *subdirectory* that is not
  already a modality (a plain file like `results.txt` costs nothing) — a barren sibling is re-`stat`ed every cycle and only skips its *listing*
  (`docs/file-watching.md: barren-dirs-memoized`); a dot-directory costs nothing. A directory it has
  not seen costs that `stat` plus a listing, and one it adopts a second listing on top, retaken after
  the watcher is armed.
- **10s** interval, **non-overlapping**, and **skipped while the panel is hidden**.

## Lifecycle

`PanelState.disposed` stops all in-flight work. `visible` gates *starting* new background work —
specifically the **existence sweep** and prefetch waves. It does **not** gate the open-time thumbnail
sweep, which is a one-shot fire and must run to completion (see "Thumbnails").

Hiding a panel deliberately does not cancel its image or thumbnail work. The custom editor uses
`retainContextWhenHidden`, so a hidden webview keeps its DOM, cache and spinner and nothing re-requests
on re-show — cancelling would strand it permanently. Queued background work is harmless anyway
(`THUMBNAIL_BULK`/`POLL` rank below any `VISIBLE` load). Only the speculative prefetch wave is dropped
on hide, and nothing restarts it on re-show: it restarts on the next `tupleFullyLoaded` that arrives
*while visible*. One arriving while still hidden is consumed for nothing, because the wave-key bump
happens before the visibility bail.

Closing a panel cancels everything (`poolKey` **and** `prefetchWaveKey` — `cancel` is exact-match).

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

- **`reply-exactly-once`** — every `requestImage` yields exactly one terminal reply (`image` or
  `imageError`), re-addressed to the slot the file occupies at delivery. When the file has left the
  view the reply still goes to the enqueued slot — but only if that slot is now *empty*: a slot
  another file has taken is healthy, and marking it missing would blank it for good, since the
  webview never re-requests a filled slot. Silence is only correct when neither slot exists. Nothing polls for a missing reply, so a
  dropped one clears only when something re-enters `loadTuple(currentTupleIndex)` — navigating away
  and back, deleting some *other* tuple, or a modality add/remove — or when a watcher-driven
  `fileRestored` re-requests that slot. Clicking the current carousel row does not.
- **`visible-never-starved`** — the visible image is never starved by thumbnails, prefetch, or
  polling. Every image read/decode goes through the pool — crop and PPTX export included, at
  `EXPORT` — so nothing outranks the visible image, and `VISIBLE` is exempt from the courtesy rule
  below: it takes any free slot.
- **`background-trickle`** — two rules, one guarantee: no queued class waits longer than one task
  completion for a slot, and contended classes converge to even shares. `SIBLING`/`EXPORT` leave one
  pool slot to lower classes while any have queued work; within speculation, each freed slot goes to
  the queued class with the fewest running tasks (max-min, ties to the higher priority). Both are
  work-conserving: no slot idles while only one class has work. Two weaker versions shipped first
  and both starved the sweep measurably — strict priority froze it for a wave's whole duration
  (15s dead progress bar), and a one-slot courtesy left it 1-wide, where a single slow NFS read
  stalled the bar head-of-line. Breaking either rule re-introduces stall-then-burst; breaking
  work-conservation idles slots.
- **`pool-width-hides-latency`** — the pool cap (16) is sized for *latency*, not CPU: its tasks are
  file-service RPC reads and Sharp decodes that run on Sharp's own thread pool, so extension-host
  CPU per task is small and width is what hides a slow mount's round trips. Capping it "to match
  libuv" was a category error — these tasks barely touch the extension host's libuv pool — and at
  width 4 a single wave saturated everything. Shrink it back and the stalls return. The `readDirectory` calls on the crop and export
  paths are not pooled and do not need to be; the sweep's own listing and existence checks
  are, at `POLL`, and so is adoption when the sweep is what triggers it.
- **`thumbnails-scanline-order`** — thumbnails fill in scanline order on open.
- **`no-sync-blocking`** — no unbounded synchronous CPU/FS work on the extension-host thread. The pool
  bounds *concurrency*, not event-loop time: PPTX export base64s every full-res image synchronously
  inside its pooled task, and deflates the zip outside it, so a large export is still felt on the
  host thread.
- **`hidden-keeps-work`** — hiding a panel must not cancel its image or thumbnail work; only the
  speculative prefetch wave may be dropped. "Free resources when hidden" looks obviously right and is
  the exact bug.
- **`debounce-leading-edge`** — the navigation debounce stays leading-edge; a trailing one still
  coalesces rapid stepping but taxes every isolated navigation 150ms.
- **`decode-retry-once`** — a transient decode failure re-requests the slot once rather than marking
  it missing; no sticky "not available" for a file that is present.
- **`render-from-loaded-tuples`** — `render()` never trusts the module-level `images`; it re-derives
  from `loadedTuples` for the current index, or a *previous* sample's frames appear under the current
  sample's labels.
- **`panel-keys-never-reused`** — panel keys are never reused (`nextPanelKey()`'s counter is
  process-global), or one panel's cancellation silently strands another's.
