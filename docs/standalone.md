# The standalone build

`image_compare.html` — a single self-contained page a user opens in a browser to compare image
folders — is a **build artifact of this repo**, not a second implementation. Historically it was an
independent ~4.4k-line hand-written file (`toshas/ImageCompare_standalone`), whose matcher, naming
and viewer drifted from the extension's. The build replaces all of it with the extension's own
code, so extension logic changes reach the standalone with zero standalone-side edits.

## Architecture

Three ingredients, composed by `scripts/build-standalone.mjs`:

1. **The real webview bundle** (`dist/webview.js`) plus the shared shell markup/styles from
   `src/webviewShell.ts` — the same composition `test/webview/harness.ts` uses, and for the same
   reason: the webview only talks `postMessage`, so anything that speaks the protocol can host it.
2. **Pure logic modules**, imported directly: `fileService` (`scanForImages`,
   `matchTuplesWithTrie` — driven through an FSA-backed `workspace.fs` shim so tuple assembly,
   naming and ordering are the extension's own), `modalityNames`, `sessionFile`, `pngText`,
   `ppmxParser`, `wireFormat`, `types` (the shared message contracts plus the runtime
   branded-index helpers and image-extension test both sides call),
   `watcherLogic`, `pollPlan` (the poll cycle's decisions: snapshot
   name/fingerprint diffing and same-cycle rename pairing, plus the provider-side barren-dir
   policy the adapter does not consume), `resultsFile` (format plus the persist flow:
   empty votes delete the file, else serialize-and-write through injected IO), `imageMime`,
   `workPool` (the extension's bounded priority scheduler plus the shared `poolWidth` rule — the
   adapter routes every read/decode through its own `WorkPool` instance. Note the rule's ceiling is
   derived from the *extension host's* libuv pool, which the browser does not have; the standalone
   inherits it unmeasured, so a wide browser machine gets 6 where it once got 15 — see
   `dev_backlog/pool-fairness-and-panels.md`),
   `cropPlan`, `cropFlow` (the whole crop sequence: one name, relative rect, per-modality
   dims/render/inject/write, arrivals, `cropComplete`, thumbnails — over injected render/write IO),
   `pptxDeck` (deck layout plus `exportDeck`, the export sequence: name, build, save, exactly one
   answer — over injected pptxgenjs/save IO),
   `thumbnailPlan` (the open-time sweep plan *and runner*: slot order, missing slots, progress
   ticks and the sweep's wire traffic, over an injected `makeThumbnail` that resolves the
   `{bytes, mime}` both products post — the adapter encodes through `canvas.toBlob`, never a data
   url, since a `thumbnail` message is binary like `image`), `wireFormat` (payload normalization,
   which both products apply to both payload kinds),
   `initPayload` (the `init` message: dense tuples, positional color defaults, winners record,
   and the product version the help modal shows — manifest version in VSCode, `__IC_VERSION__`
   in the standalone build),
   `debugLog` (the debug sink's flags, elapsed stamping and formatters — sink-injected and
   deliberately vscode-free, so the extension can back it with an output channel and the
   standalone with the console),
   `imageServe` (full-image serving: the passthrough-vs-convert branch, payload normalization
   and the single terminal reply, plus the current-tuple refresh loop),
   `arrivalPlan` (where a written crop file lands: slot-fill vs new tuple, shifts, wire payloads),
   `adoptionPlan` (modality-dir adoption: which root subdirs qualify, the imageful gate, the
   column-insert mutations and `modalityAdded` payload — the poll's adoption executor decides
   nothing itself)
   and `removalPlan` (the tuple-delete sequence: step order, emptied columns, re-save points,
   the per-slot removal commit `commitSlotRemoval`,
   and the whole delete flow — per-file disk deletes before the live-index re-plan).
3. **`standalone/adapter.ts`** (+ `standalone/fsBackends.ts`) — the IO backend: File System Access
   API directory handles (with a
   read-only fallback for Firefox/Safari, fed by the `webkitdirectory` picker *or* a drag-drop
   walked through `webkitGetAsEntry` — voting/crop/delete disabled, since
   nothing can be written), browser image decode (canvas; PPMX via the real parser; TIFF degrades
   to `imageError`), results.txt read/write over FSA, crop writes over FSA, pptxgenjs from CDN fed
   by the pure deck builder, and the external-change poll loop (+ optional `FileSystemObserver`
   accelerator) whose decisions come from `pollPlan` — see `docs/file-watching.md`, "The
   standalone poll".

The extension itself keeps thin vscode wrappers around the same pure modules; provider behavior is
unchanged by the extractions.

The shared list above is CI-verified, not hand-trusted: `scripts/check-sidedness.mjs` derives every
module's sidedness from the real runtime import graph (type-only imports are erased at runtime and
ignored) and fails if ingredient 2 names a module not actually reached from both the extension and
standalone roots, or omits one that is. The convention it parses: the backticked `src/` module
basenames inside list item 2 — exactly that item — are the shared list, so name a module there in
backticks or the gate fires. `node scripts/check-sidedness.mjs --print` is the authoritative
per-module table (extension-only / standalone-only / shared / webview); the extension-only set is
the complement and needs no doc list.

## Build

`npm run build:standalone` → `dist/standalone/image_compare.html`. The script
(`scripts/build-standalone.mjs`) type-checks `standalone/` via `tsconfig.standalone.json`, esbuild-bundles
the adapter with `vscode` and node `path` aliased to `standalone/shims/` (a minimal hand-rolled `Buffer`
subset is injected as the global; `process.platform` is defined to `linux` for `sessionFile`), runs
`npm run compile` if `dist/webview.js` is missing (rerun it yourself if the bundle is stale), and hands
everything to `standalone/compose.mjs`, which inlines shell + both bundles into the one page. The
version shown on the landing page is injected from `package.json` at build time. Crop metadata is
written as the PNG tEXt chunk only — the browser has no EXIF writer — which the extension's reader
still accepts (its tEXt fallback). The adapter schedules every image read/decode through the
extension's own `WorkPool` — width from `navigator.hardwareConcurrency` through the same
`poolWidth` rule the provider feeds `os.availableParallelism()` — at the provider's priority classes
(`VISIBLE`/`SIBLING`/`SIBLING_TAIL` for `requestImage`, mapped from the same wire flags the
provider reads, `THUMBNAIL_BULK` for the open-time sweep, `THUMBNAIL`
for re-requests, `EXPORT` for crop and deck IO). It keys image loads per tuple and cancels the
tuple left behind on `setCurrentTuple`, exactly as the provider does
(`docs/loading-architecture.md: stale-tuple-loads-cancelled`) — the webview bundle is shared, so the
dwell-gated arrival policy arrives here whether or not the host cooperates, and a host that ignored
the flags would keep the starvation the policy exists to end. On re-open it cancels the previous
root's queued work by its `nextPanelKey`-issued key *and* its live per-tuple keys (a re-open also
stops the old root's poll timer and observer). It answers `requestImage` on demand and does no
speculative prefetch pushes; local FSA reads make the provider's prefetch machinery unnecessary.
External changes on a writable root — file arrivals, removals, renames, and modality directories
appearing or vanishing under the root (a dir rename executes as remove-then-adopt) — reach the
view through the poll loop described in `docs/file-watching.md` ("The standalone poll");
read-only roots never poll.

Appending `?debug` (or `#debug`) to the page URL turns on the shared modules' debug logging — the
standalone counterpart of the `imageCompare.debug` setting. The adapter configures the shared
`debugLog` sink at module load; output lands in the browser devtools console, line-formatted exactly
as the extension's "ImageCompare" output channel (`?debug=verbose` adds the per-item lines).

Smoke coverage: `test/webview/standalone-build.spec.ts` builds the artifact, serves it, creates a
real directory tree in OPFS in-page, boots through the `window.__ic_standalone.open(dirHandle)` seam,
and pins matcher output plus a `results.txt` byte-for-byte round trip. It also pins the poll
(external add → granular `tupleAdded` with zoom/current-tuple intact, external deletes,
`results.txt` edits → `winnersReset`, a copied-in modality dir adopted as a `modalityAdded`
column at its sorted position, a dir rename executing as remove-then-adopt with view state
preserved, a re-open picking up a dir added meanwhile, and the two-root switch producing no
stale posts) with a
short injected `pollIntervalMs`, and the no-FSA drop walker through the `openDroppedEntry` seam —
a synthetic `DataTransfer` cannot carry `webkitGetAsEntry` entries in headless Chromium, so the
seam drives the drop handler's non-FSA branch directly.

## Publication

`.github/workflows/standalone.yml` rebuilds the page on every main push, uploads it as the
`standalone-html` run artifact, and — once the `STANDALONE_DEPLOY_KEY` secret holds a write-access
deploy key for `toshas/ImageCompare_standalone` — pushes it there together with
`standalone/README.artifact.md` as that repo's README (commits only when the bytes changed). The
Pages site serves the same page at `/standalone/`. The artifact repo is generated-only: it is never
edited by hand, and the README it receives says so.

## Invariants

- **`adapter-contains-no-logic`** — the adapter implements IO (list, read, write, decode, save
  dialogs) and protocol plumbing, and *decides nothing*: matching, naming, ordering, results
  format and persistence (`resultsFile`, `persistResults`), crop numbering/rect math, the whole
  crop sequence (`cropFlow`, `performCrop`), deck
  layout, the export sequence and its `comparison_NN` numbering (`pptxDeck`, `exportDeck`,
  `nextPptxName`), thumbnail-sweep planning *and running*, ordering, dispatch bound and the
  decision to drop queued work when the centre moves included — the adapter supplies only its live
  current tuple as the sweep's centre and the pool call that drop is made of (`thumbnailPlan`,
  `runThumbnailSweep`, `docs/loading-architecture.md: thumbnails-centre-out`,
  `docs/loading-architecture.md: sweep-cancels-on-reaim`),
  full-image serving (`imageServe`), init-payload assembly (`initPayload`), post-crop placement
  (`arrivalPlan`), the tuple-delete sequence and flow (`removalPlan`, `deleteTupleFlow`), the
  poll cycle's diff and rename pairing (`pollPlan`, `diffSnapshots`, `pairRenames`), the
  poll's removal commit (`removalPlan`, `commitSlotRemoval`), and modality-dir adoption
  (`adoptionPlan`: `newModalityDirCandidates`, `adoptableImages`, `applyModalityInsert`)
  are imports from the modules above. A feature
  whose logic lives only in `imageCompareProvider.ts` is not available to the standalone until
  extracted into a pure module — if the adapter starts growing standalone-only decision paths,
  stop and extract instead. An adapter that re-implements behavior recreates the drift this build
  exists to end. Pool scheduling is IO policy, not a decision path: the adapter instantiates the
  shared `workPool` and picks the provider's priority class per request kind, but the scheduler
  itself (admission, fairness, cancellation) is the imported one.
- **`results-format-shared`** — `results.txt` parse and serialize live only in
  `src/resultsFile.ts`; the extension's `fileService` wrappers and the standalone adapter both
  call them, so the two products can never disagree about the file format (it is user data both
  read and write).
- **`deck-layout-shared`** — PPTX slide selection, pairing and layout live only in
  `src/pptxDeck.ts`, parameterized over an IO interface (image loading, crop metadata); the
  provider and the adapter inject IO, never layout.
- **`crop-plan-shared`** — crop file naming (`_cropNN`, max across every modality directory) and
  rect scaling/clamping live only in `src/cropPlan.ts`; both products call it, so a crop written
  by one is numbered and dimensioned exactly as the other would.
- **`standalone-single-file`** — the built page is one `.html` with everything inlined; its only
  network dependency is the pptxgenjs CDN script, loaded lazily on first export. A build that
  emits sidecar files or adds network dependencies breaks the artifact's only deployment story
  (download one file, open it).
