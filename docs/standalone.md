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
   `modePolicy` (what the selection shape alone decides — whether voting is available, and whether
   Del removes a row or one image — read by both hosts so neither can answer it differently),
   `cropPlan`, `cropFlow` (the whole crop sequence: one name, relative rect, per-modality
   dims/render/inject/write, arrivals, `cropComplete`, thumbnails — over injected render/write IO),
   `pptxDeck` (deck layout plus `exportDeck`, the export sequence: name, build, save, exactly one
   answer — over injected pptxgenjs/save IO),
   `sweepAimPolicy` (where the sweep aims and when that moves: the raw `setCurrentTuple` stream
   trailing-edge dwelled into a settled tuple, the strip un-permuted into a column, and the aim the
   runner reads — over host-supplied timer primitives, so neither product can dwell differently),
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
   nothing can be written), a published comparison (an `imagecompare.json` beside the page, see
   "Publishing a comparison": the listed files read-only, the viewer's own votes and crops in a
   browser-local viewer layer), browser image decode (canvas; PPMX via the real parser; TIFF degrades
   to `imageError`), results.txt read/write over FSA, crop writes over FSA, pptxgenjs from CDN fed
   by the pure deck builder, and the external-change poll loop (+ optional `FileSystemObserver`
   accelerator) whose decisions come from `pollPlan` — see `docs/file-watching.md`, "The
   standalone poll".

The extension itself keeps thin vscode wrappers around the same pure modules; provider behavior is
unchanged by the extractions.

User-visible differences between the products are deliberate and few, and each is a capability the
browser genuinely lacks rather than a feature nobody ported. Three come from `HostCapabilities`
(`affordances-rendered-by-the-webview`): the standalone menu has no **Reveal in Explorer**, its
notices carry no reveal action, and its help modal has no **Ctrl/Cmd+S** row, because there is no
file tree to reveal into and no session file to copy. A published comparison states two more from
its hosting regime (see "Publishing a comparison"): no **PPTX** button where the host blocks every
download a page starts (`exportPptx`), and a **results.txt** button that copies the votes out
(`copyResults`). One more difference is a fact neither host may
invent: an emptied comparison reaches the same terminal notice here, through the same bundle
(`docs/loading-architecture.md: empty-comparison-is-terminal`), but only the extension can also say
*why* — a File System Access root handle cannot distinguish a deleted directory from an unreadable
one, so the standalone never sends the `rootMissing` edge the provider's base-dir sweep sends
(`docs/file-watching.md: root-loss-reported-as-an-edge`) and the notice keeps its generic wording.
`scripts/check-sidedness.mjs` gate (e) enforces that silence in both directions — it fails if
anything the standalone ships posts the message, and equally if the provider stops posting it, since
a rule guarding a message nobody sends guards nothing.

**How much is actually shared, and why not more.** One implementation of the UI (the real
`dist/webview.js` plus `src/webviewShell.ts`, ~3 700 lines) and one of the decisions (~3 500 lines of
pure `src/` modules, the list above) serve both products. What is *not* shared is host wiring —
`imageCompareProvider.ts` against `standalone/adapter.ts` — plus roughly a thousand lines that are
irreducibly platform-bound: Sharp/libvips and the thumbnail pack against canvas/`createImageBitmap`,
the vscode API (panels, watchers, settings, session files) against FSA handles and a poll loop, PPMX
decoding into a Node buffer against an `ImageData`. Forcing those into one implementation buys an
abstraction that costs more than the duplication, so the target is not "100% shared" — it is that
every *decision* is shared and each host only wires. `host-supplies-data-not-policy` is where that
line is drawn and gated.

The shared list above is CI-verified, not hand-trusted: `scripts/check-sidedness.mjs` derives every
module's sidedness from the real runtime import graph (type-only imports are erased at runtime and
ignored) and fails if ingredient 2 names a module not actually reached from both the extension and
standalone roots, or omits one that is. The convention it parses: the backticked `src/` module
basenames inside list item 2 — exactly that item — are the shared list, so name a module there in
backticks or the gate fires. The same script carries gate (c), `POLICY_SEAMS` — the curated list of
injected decisions a shared runner takes from its hosts (see `host-supplies-data-not-policy`); it
lives there because its precondition is precisely what the sidedness graph already computes, namely
that the module the hosts must delegate to is genuinely SHARED.
`node scripts/check-sidedness.mjs --print` is the authoritative
per-module table (extension-only / standalone-only / shared / webview); the extension-only set is
the complement and needs no doc list.

## Build

`npm run build:standalone` → `dist/standalone/image_compare.html`. The script
(`scripts/build-standalone.mjs`) type-checks `standalone/` via `tsconfig.standalone.json`, esbuild-bundles
the adapter with `vscode` and node `path` aliased to `standalone/shims/` (a minimal hand-rolled `Buffer`
subset is injected as the global; `process.platform` is defined to `linux` for `sessionFile`) — the
shims are minimal by design and `scripts/check-sidedness.mjs` gate (d) is what keeps "minimal" from
becoming "incomplete" (see `shim-covers-bundled-calls`) — runs
`npm run compile` if `dist/webview.js` is missing (rerun it yourself if the bundle is stale), and hands
everything to `standalone/compose.mjs`, which inlines shell + both bundles into the one page. The
version shown on the landing page is injected from `package.json` at build time. Crop metadata is
written as the PNG tEXt chunk only — the browser has no EXIF writer — which the extension's reader
still accepts (its tEXt fallback). The adapter schedules every image read/decode through the
extension's own `WorkPool` — width from `navigator.hardwareConcurrency` through the same
`poolWidth` rule the provider feeds `os.availableParallelism()`, a rule whose ceiling is the
extension host's libuv pool and which the browser has no libuv for (measured below) — at the
provider's priority classes
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
read-only roots never poll, and neither does a published comparison, writable though its viewer
layer is (nothing outside the page can change it; see "The viewer layer").

**Pool width in a browser.** The width the `poolWidth` rule produces here was measured once, and left
alone. In headless Chromium on a **4-vCPU** box (`navigator.hardwareConcurrency` 4, so the shipped
width is 5), 120 thumbnail units of a 3000x2000 JPEG through the real `WorkPool` —
`createImageBitmap`, `drawImage` to a scaled canvas, `toBlob`, i.e. the adapter's own
`thumbnailBytes` pipeline — with one full-resolution
`VISIBLE` decode injected 250 ms in, three runs:

| width | 1 | 2 | 3 | 4 | **5** | 6 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|---|---|---|
| sweep wall (ms) | 1 943 | 1 921 | 1 069 | 799 | **732** | 725 | 711 | 728 | 728 |
| foreground decode (ms) | 25 | 17 | 19 | 20 | **22** | 34 | 31 | 68 | 80 |

The shape is the same one the extension host showed, for a different reason: throughput plateaus at
about the core count (widths 5-12 are flat to within run-to-run noise — a rerun inverts their
order by a few per cent — and width 16 is no faster at all) while the
latency a user waits on grows past it — 22 ms at width 5 against 68-80 ms at 12-16 — because the
unit is only half off-thread (the decode is, the draw and the re-encode are not) and over-dispatch
just interleaves them. Width 5 sits at the knee, so nothing here justifies changing the rule.

The limit is explicit: this measures **one 4-vCPU machine**, which is the width regime where the
libuv-derived rule and the browser happen to agree. It says nothing about the case the rule was
questioned for — a wide browser machine, where `poolWidth` caps at 6 and the plateau may sit higher —
and no measurement taken here can. Measured on 4 vCPUs (where the rule gives 5), inconclusive for
wide machines, cap left at 6.

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
deploy key for `toshas/ImageCompare_standalone` — pushes it there (commits only when the bytes
changed). Four files are written: the page, `standalone/README.artifact.md` as that repo's README
with `__VERSION__`/`__COMMIT__` substituted, plus `LICENSE` and `CHANGELOG.md` copied verbatim so
neither can drift from this repo's. `CLAUDE.md` is deleted there: development instructions in a
repo whose README forbids development are worse than none, and the deploy is the only thing that
can remove them. The Pages site serves the same page at `/standalone/`. The artifact repo is
generated-only: it is never edited by hand, and the README it receives says so at the top.

## Publishing a comparison

The same page, uploaded unmodified next to an `imagecompare.json` and the files it lists (a Claude
artifact, GitHub Pages, any static host, `python3 -m http.server`), opens that comparison by itself
instead of the landing. A page with no manifest beside it (`file://`, the Pages copy, a 404) shows
the landing as before. `skills/imagecompare-artifact/SKILL.md` is the agent-facing recipe.

```json
{ "files": ["gt/scene_01.png", "pred/scene_01.png"],
  "host": "claude-artifact",
  "thumbs": ["imagecompare.thumbs.0.json"] }
```

- **`files`** is only a directory listing, paths relative to the page, standing in for the folder a
  user would otherwise drop: `createPublishedBackend` serves it, each listed image is fetched by
  relative URL on first read, and columns, matching, naming and order are the shared scanner's,
  exactly as for that dropped folder.
- **`host`** names the **hosting regime** — what the place the page is published to lets it do.
  Absent means `static`. One table, `standalone/hostRegimes.ts`, maps each regime to the capability
  flags the page states on `init` and to the limits the sharing script enforces
  (`host-regime-is-one-table`), so another way of sharing later — a new host, a peer-to-peer
  transport — is a new row, not a refactor.
- **`thumbs`** (optional) lists JSON files of prebuilt thumbnails:
  `{"format": "imagecompare-thumbs-1", "entries": {"<listed path>": {"mime": "image/png", "data": "<base64>"}}}`.
  Without them the open-time sweep fetches every full image to draw the strip. A packed entry
  replaces only that fetch, for a listed image; anything missing, malformed, unreachable or slower
  than 20 s to arrive falls back to the full-image path (`packed-thumbs-never-required`). A
  thumbnail waits for its thumbs file outside the work pool, so a pack still downloading holds no
  slot an image load needs. The format
  and the strip's thumbnail size are `standalone/packedThumbs.ts`'s, which the page and the sharing
  script both import.

| Regime | PPTX export | Votes leave the page by | Publish limits the sharing script checks |
|---|---|---|---|
| `static` (default) | yes | the **results.txt** copy button | none |
| `claude-artifact` | no | the **results.txt** copy button | image types `.png .jpg .jpeg .gif .webp` only; at most 511 files and 256 MB per artifact version (page, manifest and thumbs counted); at most 15 MB per image and 16 MB per text file; at most 255 files and 64 MB per publish call |

Why `claude-artifact` has no PPTX: a probe artifact (2026-10-28) measured that the artifact frame
blocks every download a page starts itself, pptxgenjs's `writeFile` included. The export would
report success with nothing saved. The platform's own save prompt exists only for signed-in members
of the owner's organization, never for a public-link visitor, so a comparison shared outside the
organization has no way to hand anyone a file. The clipboard works for every viewer, which is why
votes leave by copying. The same probe found that published files arrive byte-identical, including
paths with spaces and non-ASCII names, and PNG text chunks stay intact. `blob:`/`data:` images, canvas
decode and encode, keys, wheel, pinch and pointer capture all work for every viewer. The folder
picker is refused inside the frame, and ranged requests are honoured only for signed-in viewers.
Types outside the served list (`.tif`, `.ppmx`, any binary relabelled as text) are refused when
publishing. Those limits are the platform's published ones and can change; the table is where to
update them.

### The viewer layer

Published files cannot be written; the viewer's own work can. The published backend is wrapped in a
per-viewer layer kept in the browser (IndexedDB), and every write the shared flows make lands there:
`results.txt` from voting, so votes survive a reload, and crop files, numbered across both layers by
the shared crop plan. Reads prefer the layer and listings merge both. The layer is namespaced by the
comparison's URL directory, the directory `imagecompare.json` was fetched from, so two comparisons
served from one origin never mix (`viewer-layer-per-comparison`). Every page of a GitHub Pages site
shares one origin. If the browser refuses storage, as a private window may, the layer lives in memory
for the visit. When the stored layer cannot be read, nothing is written over it. When it can, a write
the browser refuses (a crop file over the storage quota) is lost on reload, and only that file: the
writes after it are still kept, so a crop can come back with one column's file missing.

Nothing in the layer leaves the browser on its own. Votes reach whoever published the comparison
only when the viewer presses **results.txt** in the Tools panel (`copyResults`), which puts the
file's text, as `resultsFile` serializes it, on the clipboard: through the async clipboard API in a
secure context (https, localhost), and through the browser's copy command elsewhere, so a plain-http
intranet host copies too. Copy Path on a published image or column copies its URL; a viewer's own crop
has none and copies its path in the comparison. Listed files are never written or deleted
(`published-originals-never-written`). Each listed image reaches the webview flagged `readOnly` on
`init`, so Delete is greyed out and Del does nothing for a target holding one, while a row of the
viewer's own crops deletes as usual. The same flag greys Delete on the read-only Firefox/Safari roots,
where it used to do nothing silently. A published comparison never polls: nothing outside the page
can change it.

### The sharing script

`node scripts/share-comparison.mjs <folder | session.imagecompare> --out <dir> [--host claude-artifact|static] [--title <name>]`
(default host `claude-artifact`) stages a folder ready to publish. Its decisions are
`standalone/sharePlan.ts`'s, over the node IO in `standalone/shareNodeIo.ts` (sharp makes the
thumbnails and touches nothing else); the script only parses arguments, builds the page and
prints. Those modules reach no `vscode` module: the script bundles them for node with no stand-in,
and a unit test bundles them the same way. It stages:

- the page (`dist/standalone/image_compare.html`, its `<title>` set to the comparison's name), built
  from the checkout on every run (`npm run compile`, then `npm run build:standalone`), never reused
  from an earlier build, which may predate the manifest it is staged beside;
- `imagecompare.json`;
- the images, byte for byte, at their layout paths;
- the thumbs files, split to fit the regime's text-file limit;
- `publish-plan.json`: batches within the per-publish caps, with the page, manifest and thumbs in the
  first. Every publish call sends the page as the artifact page, so each later batch starts with it
  again, counted within that batch's caps.

A session is laid out in the one-folder-per-column shape, so the page's scanner reproduces the
extension's columns. Mode 1 keeps its subdirectories. A mode-2 session's directories become columns
named as the extension names them, labels when given, and the page orders them by name, as it orders
any folder's. A file list is laid out flat, and a basename collision is refused. The page reads that
flat folder as a folder of loose images, whose enumeration sets `_cropNN` files aside
(`docs/session-files.md: folder-of-images-is-a-file-list`, shared as `enumeratedImages`); a file list
it would read back short is refused rather than published as a different comparison. So is a folder
whose only image is one loose file, which the page would not open, and a multi-directory session with
fewer than two image directories: the extension refuses that session, and staged, its columns would
open as a one-column folder. Only files the
extension counts as images are part of the comparison. Session `colors` are not carried; columns
take the positional palette. `results.txt` is never published, so a viewer starts with no votes.

Names are made safe, never refused for being awkward. Every segment of the layout, column folders
and file names alike, has each character that is unsafe in a file name on some OS or refused by the
page's listing rule replaced by one fixed lookalike (`/`→`∕`, `:`→`꞉`, `\`→`⧵`, `*`→`∗`, `?`→`？`,
`"`→`＂`, `<`→`‹`, `>`→`›`, `|`→`∣`). The table is applied identically everywhere, so names that matched
across columns still match. So the `a/pred` and `b/pred` the extension derives for two directories
sharing a tail stage as `a∕pred` and `b∕pred`, and a label `Model: A` as `Model꞉ A`. What no
substitution can make safe (a control character, an empty name, a trailing dot or space) is refused
naming the source and the label to change, as are two columns that would share a folder and two
files that would share a path. Names are compared ignoring case and Unicode normalization, because
macOS and Windows store `Pred` and `pred` as one folder. The deciding check is the page's own rule:
every staged path must pass `isPublishedPath` (`standalone/publishedPath.ts`, the one predicate
`parsePublishedManifest` applies) or the comparison is refused, so the page lists every path the
script stages.

The script checks the whole comparison against the regime's limits before staging anything, and
before building a single thumbnail; the thumbs files are then counted and weighed in a second pass.
On any violation it refuses: it names each exceeded limit with the measured value and the offending files,
and stages nothing (`pack-refuses-never-alters`). It never re-encodes, resizes, converts or drops a
file to make a comparison fit. Sharing a smaller selection instead is the sharer's decision.
Publishing through Claude's Artifact tool is then the recipe in the skill.

## Invariants

- **`adapter-contains-no-logic`** — the adapter implements IO (list, read, write, decode, save
  dialogs) and protocol plumbing, and *decides nothing*: matching, naming, ordering, results
  format and persistence (`resultsFile`, `persistResults`), crop numbering/rect math, the whole
  crop sequence (`cropFlow`, `performCrop`), deck
  layout, the export sequence and its `comparison_NN` numbering (`pptxDeck`, `exportDeck`,
  `nextPptxName`), thumbnail-sweep planning *and running*, ordering, dispatch bound and the
  decision to drop queued work when the centre moves included — the adapter forwards only the raw
  `setCurrentTuple`/`tupleFullyLoaded` reports to the shared aim policy (`sweepAimPolicy`, so the
  standalone gets the same bounded-cross-then-row-major order *and* the same re-aim dwell, not a
  row-only or un-dwelled variant) plus the pool call that drop is made of
  (`thumbnailPlan`,
  `runThumbnailSweep`, `docs/loading-architecture.md: thumbnails-centre-out`,
  `docs/loading-architecture.md: sweep-cancels-on-reaim`),
  full-image serving (`imageServe`), init-payload assembly (`initPayload`), post-crop placement
  (`arrivalPlan`), the delete sequences and flows (`removalPlan`, `deleteTupleFlow` for a row and
  `deleteSlotFlow` for one image), the
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
- **`affordances-rendered-by-the-webview`** — every affordance a user can reach from inside a
  comparison — which items a context menu offers, what they are called, when one is enabled, and the
  wording of what the user is told afterwards — is decided and rendered by the webview bundle both
  products ship. A host contributes capability **flags** (`HostCapabilities` on `init`) and the
  **implementation** of an action it was asked to serve, never an item, a label or an enablement
  rule. No shared code asks *which* product it is running in; it asks what this host can do.
  The rule exists because the context menu was, until this landed, contributed in `package.json`
  (`contributes.menus["webview/context"]`) and dispatched through five extension commands. That put
  a *decision* — the item set and its `when` clauses — outside the import graph, where
  `check-sidedness.mjs` structurally cannot see it, so neither gate (c) nor the shared-module list
  could notice. The standalone therefore had no menu at all: right-click fell through to the
  browser's own, and Hide/Show Modality — whose only trigger in either product was that menu — was
  unreachable for the life of the build, while the *shared* help modal advertised it. Rendering the
  menu in the webview makes it shared **by construction** rather than by a list somebody maintains.
  Gate: `scripts/check-sidedness.mjs` gate (f) fails the build if the manifest contributes a
  `webview/context` menu again, or if a menu item's label text appears anywhere in `src/`,
  `standalone/` or the manifest but the model — bare text, not just a quoted literal, because the
  regression it guards is a hardcoded help row inside `webviewShell.ts`'s markup template. Prose
  outside those trees (`README.md`, `docs/`) is not scanned and may name the items freely.
  Structure alone is not the proof: `test/unit/contextMenuModel.test.ts` pins both hosts' real
  capability records and requires the two menus to differ *only* by an item the host truthfully
  cannot serve, and `test/webview/standalone-build.spec.ts` opens the menu in the real standalone
  artifact.
- **`host-supplies-data-not-policy`** — a host may hand a shared runner **data** (where the user is,
  what the webview reported) and **primitives** (a timer, a pool, a post), never a **decision**. The
  distinction is not pedantry: `runThumbnailSweep` takes its aim as an injected callback, and for two
  commits that callback was hand-built in each host — so ff11b92's trailing-edge re-aim dwell landed
  in `imageCompareProvider.ts` and the standalone silently kept chasing the cursor
  (`docs/loading-architecture.md: sweep-centre-dwells`). Every such injected decision is named in
  `POLICY_SEAMS` in `scripts/check-sidedness.mjs`, which fails the build when a host stops importing
  the shared factory, hand-builds the injected value, or stops feeding the factory its raw reports;
  the list is curated rather than derived because the general form ("no callback may contain host
  logic") is unenforceable without false positives, and a gate people can read beats one they cannot.
  Two sites per seam — the two hosts (`imageCompareProvider.ts`, `standalone/adapter.ts`), which is
  exactly where the divergence can reappear. Structure alone is not the proof: `test/unit/sweepHostEquivalence.test.ts`
  drives the same burst through both real hosts and requires identical traces, and that test is what
  would have caught the original leak.
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
- **`shim-covers-bundled-calls`** — `standalone/shims/{buffer,path,vscode}.ts` must provide every
  member the modules in the standalone bundle actually call. A shared `src/` module typechecks
  against node's real `Buffer`/`path`/`vscode` **types** while the browser runs it against these
  hand-written shims, so a missing member compiles clean, passes every unit test (node's real
  `Buffer` is what a Vitest import gets) and throws only in a user's browser, mid-action, inside
  whatever `catch` happens to be around it. `Buffer.isBuffer` was missing from the day the shared
  crop flow landed and made standalone cropping fail on every image, reported only as
  "Failed to crop any images". `scripts/check-sidedness.mjs` gate (d) resolves every `Buffer.x`,
  `path.x` and `vscode.a.b` chain in the bundle's closure against the shim's real runtime surface
  (the shim is bundled and evaluated, never parsed). Presence is all a gate can prove; a shim member
  that exists and behaves differently from node's is a **test's** job — `test/unit/shimParity.test.ts`
  runs the real shared flow with `globalThis.Buffer` replaced by the real shim, which is the only
  layer that can see such a difference.
- **`standalone-single-file`** — the built page is one `.html` with everything inlined; its only
  network dependency is the pptxgenjs CDN script, loaded lazily on first export. A build that
  emits sidecar files or adds network dependencies breaks the artifact's only deployment story
  (download one file, open it). A published comparison's `imagecompare.json`, images and thumbs
  files are data the page reads from its own directory (`published-comparison-opens-itself`), never
  code it needs.
- **`published-comparison-opens-itself`** — on load the page makes exactly one request for
  `imagecompare.json` in its own directory. Absent or unreachable (any non-OK response, an HTML page
  in its place as from a host that rewrites every path to one page, or a throwing fetch as on
  `file://`), the landing is left exactly as it was. Present, it opens a comparison of exactly the
  listed files, each fetched by its relative URL, unless the user has already opened a folder, which
  wins. The manifest is reported on the landing rather than opened when `files` is not a non-empty
  list of relative paths inside the page's directory, when `thumbs` is present and is not such a
  list, or when `host` names no known regime. `files` is a listing, not a configuration: what the
  files mean (columns, tuples, names, order) is decided by the shared scanner the dropped-folder path
  uses, so a published comparison can never be laid out differently from the same folder opened
  locally. `host` and `thumbs` change what the page offers and how fast the strip fills, never what
  the files mean.
- **`host-regime-is-one-table`** — everything a hosting regime implies (the capability flags a
  published page states on `init`, and the publish limits the sharing script enforces) is one row
  of the table in `standalone/hostRegimes.ts`, keyed by the manifest's `host`. The adapter and the
  sharing script both read that row and restate none of it, so a new regime is a new row. An
  unknown `host` is reported on the landing, never defaulted to a row it did not name: a page that
  guessed would offer an export its host blocks, and report success with nothing saved.
- **`published-originals-never-written`** — in a published comparison the only write target is the
  viewer layer. A listed file is never written or deleted: the layer refuses both for a listed path,
  every listed image reaches the webview flagged `readOnly` on `init`, and the webview greys Delete
  and ignores Del for a target holding a `readOnly` image. Viewer-made files (crops, `results.txt`)
  are written and deleted normally. Breaking any one of the three sites either loses the viewer's
  own work, or offers a Delete that fails, or claims one that succeeded.
- **`viewer-layer-per-comparison`** — a published comparison's viewer layer is namespaced by the
  comparison's URL directory, so two comparisons served from one origin never read or overwrite
  each other's votes or crops. Nothing in the layer leaves the browser except by the viewer's own
  action: a copy to the clipboard (results.txt through `copyResults`, Copy Image), or a PPTX export
  where the regime offers one. The page sends it nowhere.
- **`packed-thumbs-never-required`** — a packed thumbnail replaces the full-image fetch for a
  listed image's thumbnail and nothing else. A missing, malformed or unreachable thumbs file, or a
  missing entry, falls back to decoding the full image, never to a failed slot or a stalled sweep.
  Waiting for a thumbs file holds no work-pool slot, so a slow pack never holds back an image load.
  Viewer-made files always decode.
- **`pack-refuses-never-alters`** — the sharing script publishes the comparison's bytes unchanged
  or refuses. It never re-encodes, resizes, converts or drops a file to fit a limit. A refusal
  names every exceeded limit with its measured value and the offending files, exits non-zero, and
  leaves nothing staged. A silently fitted comparison would be judged on pixels its author never
  produced.
