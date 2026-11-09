# The standalone build

`image_compare.html` — a single self-contained page a user opens in a browser to compare image
folders — is a **build artifact of this repo**, not a second implementation. Historically it was an
independent ~4.4k-line hand-written file (`toshas/ImageCompare_standalone`), whose matcher, naming
and viewer drifted from the extension's. The build replaces all of it with the extension's own
code, so extension logic changes reach the standalone with zero standalone-side edits.

## Architecture

`scripts/build-standalone.mjs` composes three ingredients:

1. **The real webview bundle** (`dist/webview.js`) plus the shared shell markup/styles from
   `src/webviewShell.ts`. `test/webview/harness.ts` uses the same composition, for the same reason:
   the webview only talks `postMessage`, so anything that speaks the protocol can host it.
2. **Pure logic modules**, imported directly:
   - `fileService`: `scanForImages` and `matchTuplesWithTrie`, driven through an FSA-backed
     `workspace.fs` shim, so tuple assembly, naming and ordering are the extension's own.
   - `modalityNames`
   - `sessionFile`
   - `pngText`
   - `ppmxParser`
   - `wireFormat`: payload normalization, applied by both products to both payload kinds.
   - `types`: the shared message contracts, plus the runtime branded-index helpers and
     image-extension test both sides call.
   - `watcherLogic`
   - `pollPlan`: the poll cycle's decisions (snapshot name/fingerprint diffing, same-cycle rename
     pairing), plus the provider-side barren-dir policy the adapter does not consume.
   - `resultsFile`: the format plus the persist flow. Empty votes delete the file; else it
     serializes and writes through injected IO.
   - `imageMime`
   - `workPool`: the bounded priority scheduler plus the shared `poolWidth` rule. The adapter
     routes every read and decode through its own `WorkPool` (see "Pool width in a browser").
   - `modePolicy`: what the selection shape alone decides, namely whether voting is available and
     whether Del removes a row or one image. Both hosts read it, so neither can answer differently.
   - `cropPlan`
   - `cropFlow`: the whole crop sequence over injected render/write IO. That is one name, relative
     rect, per-modality dims/render/inject/write, arrivals, `cropComplete`, thumbnails.
   - `pptxDeck`: deck layout plus `exportDeck`, the export sequence over injected pptxgenjs/save
     IO: name, build, save, exactly one answer.
   - `sweepAimPolicy`: where the sweep aims and when that moves, over host-supplied timer
     primitives, so neither product can dwell differently. It trailing-edge dwells the raw
     `setCurrentTuple` stream into a settled tuple, un-permutes the strip into a column, and holds
     the aim the runner reads.
   - `thumbnailPlan`: the open-time sweep plan *and runner* (slot order, missing slots, progress
     ticks, the sweep's wire traffic). It runs over an injected `makeThumbnail` that resolves the
     `{bytes, mime}` both products post. The adapter encodes through `canvas.toBlob`, never a data
     url, since a `thumbnail` message is binary like `image`.
   - `initPayload`: the `init` message. That is dense tuples, positional color defaults, winners
     record, and the product version the help modal shows (manifest version in VSCode,
     `__IC_VERSION__` in the standalone build).
   - `debugLog`: the debug sink's flags, elapsed stamping and formatters. The sink is injected and
     the module deliberately vscode-free, so the extension backs it with an output channel and the
     standalone with the console.
   - `imageServe`: full-image serving (the passthrough-vs-convert branch, payload normalization,
     the single terminal reply), plus the current-tuple refresh loop.
   - `arrivalPlan`: where a written crop file lands (slot-fill vs new tuple, shifts, wire payloads).
   - `adoptionPlan`: modality-dir adoption (which root subdirs qualify, the imageful gate, the
     column-insert mutations, the `modalityAdded` payload). The poll's adoption executor decides
     nothing itself.
   - `removalPlan`: the tuple-delete sequence (step order, emptied columns, re-save points), the
     per-slot removal commit `commitSlotRemoval`, and the whole delete flow: per-file disk deletes
     before the live-index re-plan.
3. **`standalone/adapter.ts`** (+ `standalone/fsBackends.ts`), the IO backend:
   - File System Access API directory handles. A read-only fallback serves Firefox/Safari, fed by
     the `webkitdirectory` picker *or* a drag-drop walked through `webkitGetAsEntry`; it disables
     voting/crop/delete, since nothing can be written.
   - A published comparison: an `imagecompare.json` beside the page (see "Publishing a
     comparison"). The listed files are read-only; the viewer's own votes and crops live in a
     browser-local viewer layer.
   - Browser image decode: canvas; PPMX via the real parser; TIFF degrades to `imageError`.
   - results.txt read/write and crop writes over FSA.
   - pptxgenjs from CDN, fed by the pure deck builder.
   - The external-change poll loop (+ optional `FileSystemObserver` accelerator), whose decisions
     come from `pollPlan` (see `docs/file-watching.md`, "The standalone poll").

The extension keeps thin vscode wrappers around the same pure modules; the extractions left
provider behavior unchanged.

User-visible differences between the products are deliberate and few. Each is a capability the
browser lacks, not a feature nobody ported. Three come from `HostCapabilities`
(`affordances-rendered-by-the-webview`), because there is no file tree to reveal into and no
session file to copy:

- The standalone menu has no **Reveal in Explorer**.
- Its notices carry no reveal action.
- Its help modal has no **Ctrl/Cmd+S** row.

A published comparison states two more from its hosting regime (see "Publishing a comparison"):

- no **PPTX** button where the host blocks every download a page starts (`exportPptx`);
- a **results.txt** button that copies the votes out (`copyResults`).

It also keeps the viewer's view across a reload (`restoresView`, "The view survives a reload"); the
extension does not.

One more difference is a fact neither host may invent. An emptied comparison reaches the same
terminal notice here, through the same bundle (`docs/loading-architecture.md: empty-comparison-is-terminal`),
but only the extension can also say *why*. A File System Access root handle cannot distinguish a
deleted directory from an unreadable one, so the standalone never sends the `rootMissing` edge the
provider's base-dir sweep sends (`docs/file-watching.md: root-loss-reported-as-an-edge`), and the
notice keeps its generic wording. `scripts/check-sidedness.mjs` gate (e) enforces that silence both
ways: it fails if anything the standalone ships posts the message, or if the provider stops posting
it, since a rule guarding a message nobody sends guards nothing.

**How much is actually shared, and why not more.** Both products run one implementation of the UI
(the real `dist/webview.js` plus `src/webviewShell.ts`, ~3 700 lines) and one of the decisions
(~3 500 lines of pure `src/` modules, the list above). Not shared is host wiring
(`imageCompareProvider.ts` against `standalone/adapter.ts`), plus roughly a thousand irreducibly
platform-bound lines:

- Sharp/libvips and the thumbnail pack against canvas/`createImageBitmap`.
- The vscode API (panels, watchers, settings, session files) against FSA handles and a poll loop.
- PPMX decoding into a Node buffer against an `ImageData`.

Forcing those into one implementation buys an abstraction that costs more than the duplication. The
target is not "100% shared": every *decision* is shared and each host only wires.
`host-supplies-data-not-policy` is where that line is drawn and gated.

CI verifies the shared list above. `scripts/check-sidedness.mjs` derives every module's sidedness
from the real runtime import graph, ignoring type-only imports (erased at runtime). It fails if
ingredient 2 names a module not reached from both the extension and standalone roots, or omits one
that is. The convention it parses: the backticked `src/` module basenames inside list item 2, exactly
that item, are the shared list. Name a module there in backticks or the gate fires.

The same script carries gate (c), `POLICY_SEAMS`: the curated list of injected decisions a shared
runner takes from its hosts (see `host-supplies-data-not-policy`). It lives there because its
precondition is what the sidedness graph already computes: the module the hosts must delegate to is
genuinely SHARED. `node scripts/check-sidedness.mjs --print` is the authoritative per-module table
(extension-only / standalone-only / shared / webview). The extension-only set is the complement and
needs no doc list.

## Build

`npm run build:standalone` → `dist/standalone/image_compare.html`. The script
(`scripts/build-standalone.mjs`):

1. Type-checks `standalone/` via `tsconfig.standalone.json`.
2. Runs `npm run compile` if `dist/webview.js` is missing (rerun it yourself if the bundle is stale).
3. Esbuild-bundles the adapter with `vscode` and node `path` aliased to `standalone/shims/`. A
   minimal hand-rolled `Buffer` subset is injected as the global; `process.platform` is defined to
   `linux` for `sessionFile`. The shims are minimal by design; `scripts/check-sidedness.mjs` gate
   (d) keeps "minimal" from becoming "incomplete" (see `shim-covers-bundled-calls`).
4. Hands everything to `standalone/compose.mjs`, which inlines shell + both bundles into the one page.

The landing page's version is injected from `package.json` at build time. Crop metadata is written
as the PNG tEXt chunk only, since the browser has no EXIF writer; the extension's reader still
accepts it (its tEXt fallback).

The adapter schedules every image read/decode through the extension's own `WorkPool`. Its width
comes from `navigator.hardwareConcurrency` through the same `poolWidth` rule the provider feeds
`os.availableParallelism()`. It uses the provider's priority classes:

- `VISIBLE`/`SIBLING`/`SIBLING_TAIL` for `requestImage`, mapped from the same wire flags the
  provider reads.
- `THUMBNAIL_BULK` for the open-time sweep.
- `THUMBNAIL` for re-requests.
- `EXPORT` for crop and deck IO.

It keys image loads per tuple and cancels the tuple left behind on `setCurrentTuple`, as the
provider does (`docs/loading-architecture.md: stale-tuple-loads-cancelled`). The webview bundle is
shared, so the dwell-gated arrival policy arrives here whether or not the host cooperates. A host
that ignored the flags would keep the starvation the policy exists to end.

On re-open it cancels the previous root's queued work by its `nextPanelKey`-issued key *and* its
live per-tuple keys, and stops the old root's poll timer and observer. It answers `requestImage` on
demand and pushes no speculative prefetch; local FSA reads make the provider's prefetch machinery
unnecessary.

External changes on a writable root reach the view through the poll loop in `docs/file-watching.md`
("The standalone poll"):

- file arrivals, removals and renames;
- modality directories appearing or vanishing under the root (a dir rename executes as
  remove-then-adopt).

Read-only roots never poll. Neither does a published comparison, writable though its viewer layer
is: nothing outside the page can change it (see "The viewer layer").

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
and no measurement taken here can.

Appending `?debug` (or `#debug`) to the page URL turns on the shared modules' debug logging — the
standalone counterpart of the `imageCompare.debug` setting. The adapter configures the shared
`debugLog` sink at module load; output lands in the browser devtools console, line-formatted exactly
as the extension's "ImageCompare" output channel (`?debug=verbose` adds the per-item lines).

What `test/webview/standalone-build.spec.ts` pins is in `docs/testing.md`.

## Publication

On every main push, `.github/workflows/standalone.yml`:

- rebuilds the page;
- uploads it as the `standalone-html` run artifact;
- once the `STANDALONE_DEPLOY_KEY` secret holds a write-access deploy key for
  `toshas/ImageCompare_standalone`, pushes it there (commits only when the bytes changed).

Four files are written:

- the page;
- `standalone/README.artifact.md`, as that repo's README, with `__VERSION__`/`__COMMIT__` substituted;
- `LICENSE` and `CHANGELOG.md`, copied verbatim so neither can drift from this repo's.

`CLAUDE.md` is deleted there. Development instructions in a repo whose README forbids development
are worse than none, and the deploy is the only thing that can remove them. The Pages site serves
the same page at `/standalone/`. The artifact repo is generated-only: never edited by hand, and its
README says so at the top.

## Publishing a comparison

The same page, uploaded unmodified next to an `imagecompare.json` and the files it lists, opens that
comparison by itself instead of the landing. Hosts include a Claude artifact, GitHub Pages, any
static host and `python3 -m http.server`. A page with no manifest beside it (`file://`, the Pages
copy, a 404) shows the landing as before. `skills/imagecompare-artifact/SKILL.md` is the
agent-facing recipe.

```json
{ "files": ["gt/scene_01.png", "pred/scene_01.png"],
  "host": "claude-artifact",
  "thumbs": ["imagecompare.thumbs.0.json"] }
```

- **`files`** is only a directory listing, paths relative to the page, standing in for the folder a
  user would otherwise drop. `createPublishedBackend` serves it, and each listed image is fetched by
  relative URL on first read. Columns, matching, naming and order are the shared scanner's, exactly
  as for that dropped folder.
- **`host`** names the **hosting regime**: what the place the page is published to lets it do.
  Absent means `static`. One table, `standalone/hostRegimes.ts`, maps each regime to the capability
  flags the page states on `init` and the limits the sharing script enforces
  (`host-regime-is-one-table`). Another way of sharing later (a new host, a peer-to-peer transport)
  is a new row, not a refactor.
- **`thumbs`** (optional) lists JSON files of prebuilt thumbnails:
  `{"format": "imagecompare-thumbs-1", "entries": {"<listed path>": {"mime": "image/png", "data": "<base64>"}}}`.
  Without them the open-time sweep fetches every full image to draw the strip. A packed entry
  replaces only that fetch, for a listed image. Anything missing, malformed, unreachable or slower
  than 20 s to arrive falls back to the full-image path (`packed-thumbs-never-required`). A
  thumbnail waits for its thumbs file outside the work pool, so a pack still downloading holds no
  slot an image load needs. The format and the strip's thumbnail size are
  `standalone/packedThumbs.ts`'s, which the page and the sharing script both import.

| Regime | PPTX export | Votes leave the page by | Publish limits the sharing script checks |
|---|---|---|---|
| `static` (default) | yes | the **results.txt** copy button | none |
| `claude-artifact` | no | the **results.txt** copy button | image types `.png .jpg .jpeg .gif .webp` only; at most 511 files and 256 MB per artifact version (page, manifest and thumbs counted); at most 15 MB per image and 16 MB per text file; at most 255 files and 64 MB per publish call |

Why `claude-artifact` has no PPTX: a probe artifact (2026-10-28) measured that the artifact frame
blocks every download a page starts itself, pptxgenjs's `writeFile` included. The export would
report success with nothing saved. The platform's own save prompt exists only for signed-in members
of the owner's organization, never for a public-link visitor. A comparison shared outside the
organization has no way to hand anyone a file. The clipboard works for every viewer, which is why
votes leave by copying.

The same probe found that published files arrive byte-identical, including paths with spaces and
non-ASCII names, and PNG text chunks stay intact. `blob:`/`data:` images, canvas decode and encode,
keys, wheel, pinch and pointer capture all work for every viewer.

The folder picker is refused inside the frame. Ranged requests are honoured only for signed-in
viewers. Types outside the served list (`.tif`, `.ppmx`, any binary relabelled as text) are refused
when publishing. Those limits are the platform's published ones and can change; the table is where
to update them.

### The viewer layer

Published files cannot be written; the viewer's own work can. A per-viewer layer kept in the browser
(IndexedDB) wraps the published backend, and every write the shared flows make lands there:

- `results.txt` from voting, so votes survive a reload;
- crop files, numbered across both layers by the shared crop plan.

Reads prefer the layer and listings merge both. The layer is namespaced by the comparison's URL
directory, the directory `imagecompare.json` was fetched from, so two comparisons served from one
origin never mix (`viewer-layer-per-comparison`). Every page of a GitHub Pages site shares one
origin.

If the browser refuses storage, as a private window may, the layer lives in memory for the visit.
When the stored layer cannot be read, nothing is written over it. When it can, a write the browser
refuses (a crop file over the storage quota) is lost on reload, and only that file. The writes after
it are still kept, so a crop can come back with one column's file missing.

Nothing in the layer leaves the browser on its own. Votes reach whoever published the comparison
only when the viewer presses **results.txt** in the Tools panel (`copyResults`). That puts the
file's text, as `resultsFile` serializes it, on the clipboard. A secure context (https, localhost)
uses the async clipboard API; elsewhere the browser's copy command does, so a plain-http intranet
host copies too.

Copy Path on a published image or column copies its URL; a viewer's own crop has none and copies its
path in the comparison. Listed files are never written or deleted
(`published-originals-never-written`). The `readOnly` flag also greys Delete on the read-only
Firefox/Safari roots, where it used to do nothing silently.

### The view survives a reload

A published page is reloaded under the viewer more often than a desktop tab. A phone browser or an
app's WebView discards a page in the background, and the Claude app reloads an artifact by itself.
The page keeps the view as well as the votes, in `localStorage` under the viewer layer's namespace
(`viewer-layer-per-comparison`):

- the column order;
- the hidden pills;
- the tuple and modality on screen;
- the zoom and pan.

It is written as the view changes, because a discarded page gets no unload event to save on.

The saved view names the tuple and the modalities; it holds no index (`view-restored-by-name`).
Display and original indices both shift when a listing changes. An index restored into a different
listing shows the wrong image without any error.

A restore reads the names against the comparison as it lists now. A name that is gone is skipped.
A modality the save never saw keeps its default place after the saved ones. An unmatched tuple or
modality leaves the view at its default.

Restoring is navigation. The order, hidden set, tuple, modality and zoom are applied once, at
first `init`, through the actions keys and drags take, so loading sees an ordinary navigation
(`view-restore-is-navigation`).

Only a host that states `restoresView` keeps a view (`view-kept-only-where-stated`). The published
page states it. The extension does not, so a reloaded panel opens as it always has. Neither does a
page opened through the folder picker, whose reload returns to the picker anyway.

### The sharing script

`node scripts/share-comparison.mjs <folder | session.imagecompare> --out <dir> [--host claude-artifact|static] [--title <name>]`
(default host `claude-artifact`) stages a folder ready to publish. Its decisions are
`standalone/sharePlan.ts`'s, over the node IO in `standalone/shareNodeIo.ts`, where sharp makes the
thumbnails and touches nothing else. The script only parses arguments, builds the page and prints.
Those modules reach no `vscode` module: the script bundles them for node with no stand-in, and a
unit test bundles them the same way. It stages:

- the page (`dist/standalone/image_compare.html`, its `<title>` set to the comparison's name). It
  is built from the checkout on every run (`npm run compile`, then `npm run build:standalone`). An
  earlier build is never reused: it may predate the manifest it is staged beside;
- `imagecompare.json`;
- the images, byte for byte, at their layout paths;
- the thumbs files, split to fit the regime's text-file limit;
- `publish-plan.json`: batches within the per-publish caps, with the page, manifest and thumbs in the
  first. Every publish call sends the page as the artifact page, so each later batch starts with it
  again, counted within that batch's caps.

A session is laid out in the one-folder-per-column shape, so the page's scanner reproduces the
extension's columns. Mode 1 keeps its subdirectories. A mode-2 session's directories become
columns, named as the extension names them, or by labels when given. The page orders them by name,
as it orders any folder's.

A file list is laid out flat, and a basename collision is refused. The page reads that flat folder
as a folder of loose images, whose enumeration sets `_cropNN` files aside
(`docs/session-files.md: folder-of-images-is-a-file-list`, shared as `enumeratedImages`). A file
list it would read back short is refused rather than published as a different comparison. Also
refused:

- a folder whose only image is one loose file, which the page would not open;
- a multi-directory session with fewer than two image directories: the extension refuses that
  session, and staged, its columns would open as a one-column folder.

Only files the extension counts as images are part of the comparison. Session `colors` are not
carried; columns take the positional palette. `results.txt` is never published, so a viewer starts
with no votes.

Names are made safe, never refused for being awkward. Every segment of the layout, column folders
and file names alike, gets each unsafe character replaced by one fixed lookalike. A character is
unsafe if some OS forbids it in a file name or the page's listing rule refuses it: `/`→`∕`,
`:`→`꞉`, `\`→`⧵`, `*`→`∗`, `?`→`？`, `"`→`＂`, `<`→`‹`, `>`→`›`, `|`→`∣`. The table is applied
identically everywhere, so names that matched across columns still match. The `a/pred` and `b/pred`
the extension derives for two directories sharing a tail stage as `a∕pred` and `b∕pred`, and a
label `Model: A` as `Model꞉ A`.

What no substitution can make safe (a control character, an empty name, a trailing dot or space) is
refused, naming the source and the label to change. So are two columns that would share a folder
and two files that would share a path. Names are compared ignoring case and Unicode normalization,
because macOS and Windows store `Pred` and `pred` as one folder.

The deciding check is the page's own rule. Every staged path must pass `isPublishedPath`
(`standalone/publishedPath.ts`, the one predicate `parsePublishedManifest` applies) or the
comparison is refused, so the page lists every path the script stages.

The script checks the whole comparison against the regime's limits before staging anything, and
before building a single thumbnail. The thumbs files are then counted and weighed in a second pass.
On any violation it refuses and stages nothing (`pack-refuses-never-alters`). Sharing a smaller
selection instead is the sharer's decision. Publishing through Claude's Artifact tool is then the
recipe in the skill.

## Invariants

- **`adapter-contains-no-logic`** — the adapter implements IO (list, read, write, decode, save
  dialogs) and protocol plumbing, and *decides nothing*. Every decision is an import from a module
  in "Architecture", ingredient 2. That includes thumbnail-sweep planning *and running*: ordering,
  the dispatch bound, and the decision to drop queued work when the centre moves
  (`docs/loading-architecture.md: thumbnails-centre-out`,
  `docs/loading-architecture.md: sweep-cancels-on-reaim`). The adapter forwards only the raw
  `setCurrentTuple`/`tupleFullyLoaded` reports to the shared aim policy, plus the pool call that
  drop is made of. The standalone gets the same bounded-cross-then-row-major order *and* the same
  re-aim dwell, not a row-only or un-dwelled variant. A feature whose logic lives only in
  `imageCompareProvider.ts` is not available to the standalone until extracted into a pure module.
  If the adapter starts growing standalone-only decision paths, stop and extract instead. An adapter
  that re-implements behavior recreates the drift this build exists to end. Pool scheduling is IO
  policy, not a decision path: the adapter instantiates the shared `workPool` and picks the
  provider's priority class per request kind. The scheduler itself (admission, fairness,
  cancellation) is the imported one.
- **`affordances-rendered-by-the-webview`** — every affordance a user can reach from inside a
  comparison is decided and rendered by the webview bundle both products ship. That is which items a
  context menu offers, what they are called, when one is enabled, and the wording of what the user
  is told afterwards. A host contributes capability **flags** (`HostCapabilities` on `init`) and the
  **implementation** of an action it was asked to serve, never an item, a label or an enablement
  rule. No shared code asks *which* product it is running in; it asks what this host can do.
  The rule exists because `package.json` once contributed the context menu
  (`contributes.menus["webview/context"]`), dispatched through five extension commands. That put a
  *decision*, the item set and its `when` clauses, outside the import graph, where
  `check-sidedness.mjs` structurally cannot see it, so neither gate (c) nor the shared-module list
  could notice. The standalone therefore had no menu at all: right-click fell through to the
  browser's own. Hide/Show Modality, whose only trigger in either product was that menu, was
  unreachable for the life of the build, while the *shared* help modal advertised it. Rendering the
  menu in the webview makes it shared **by construction**, not by a list somebody maintains.
  Gate: `scripts/check-sidedness.mjs` gate (f) fails the build if the manifest contributes a
  `webview/context` menu again. It also fails if a menu item's label text appears anywhere in
  `src/`, `standalone/` or the manifest but the model. It matches bare text, not just a quoted
  literal, because the regression it guards is a hardcoded help row inside `webviewShell.ts`'s
  markup template. Prose outside those trees (`README.md`, `docs/`) is not scanned and may name the items
  freely. Structure alone is not the proof: `test/unit/contextMenuModel.test.ts` pins both hosts'
  real capability records and requires the two menus to differ *only* by an item the host
  truthfully cannot serve. `test/webview/standalone-build.spec.ts` opens the menu in the real
  standalone artifact.
- **`host-supplies-data-not-policy`** — a host may hand a shared runner **data** (where the user is,
  what the webview reported) and **primitives** (a timer, a pool, a post), never a **decision**. The
  distinction is not pedantry. `runThumbnailSweep` takes its aim as an injected callback. For two
  commits each host hand-built that callback, so ff11b92's trailing-edge re-aim dwell landed in
  `imageCompareProvider.ts` and the standalone silently kept chasing the cursor
  (`docs/loading-architecture.md: sweep-centre-dwells`). `POLICY_SEAMS` in
  `scripts/check-sidedness.mjs` names every such injected decision. It fails the build when a host
  stops importing the shared factory, hand-builds the injected value, or stops feeding the factory
  its raw reports. The list is curated rather than derived because the general form ("no callback
  may contain host logic") is unenforceable without false positives, and a gate people can read
  beats one they cannot. Each seam has two sites, the two hosts (`imageCompareProvider.ts`,
  `standalone/adapter.ts`), exactly where the divergence can reappear. Structure alone is not the
  proof: `test/unit/sweepHostEquivalence.test.ts` drives the same burst through both real hosts and
  requires identical traces. That test would have caught the original leak.
- **`results-format-shared`** — `results.txt` parse and serialize live only in `src/resultsFile.ts`.
  The extension calls them through `fileService`'s `readResultsFile` and through `persistResults`,
  the adapter directly, so the two products never disagree about the file format (user data both
  read and write).
- **`deck-layout-shared`** — PPTX slide selection, pairing and layout live only in
  `src/pptxDeck.ts`, parameterized over an IO interface (image loading, crop metadata). The provider
  and the adapter inject IO, never layout.
- **`crop-plan-shared`** — crop file naming (`_cropNN`, max across every modality directory) and
  rect scaling/clamping live only in `src/cropPlan.ts`. Both products call it, so a crop written by
  one is numbered and dimensioned exactly as the other would.
- **`shim-covers-bundled-calls`** — `standalone/shims/{buffer,path,vscode}.ts` must provide every
  member the modules in the standalone bundle actually call. A shared `src/` module typechecks
  against node's real `Buffer`/`path`/`vscode` **types**, while the browser runs it against these
  hand-written shims. A missing member compiles clean and passes every unit test (a Vitest import
  gets node's real `Buffer`). It throws only in a user's browser, mid-action, inside whatever
  `catch` happens to be around it. `Buffer.isBuffer` was missing from the day the shared crop flow
  landed. It made standalone cropping fail on every image, reported only as
  "Failed to crop any images". `scripts/check-sidedness.mjs` gate (d) resolves every `Buffer.x`,
  `path.x` and `vscode.a.b` chain in the bundle's closure against the shim's real runtime surface
  (the shim is bundled and evaluated, never parsed). Presence is all a gate can prove. A shim member
  that exists and behaves differently from node's is a **test's** job:
  `test/unit/shimParity.test.ts` runs the real shared flow with `globalThis.Buffer` replaced by the
  real shim, the only layer that can see such a difference.
- **`standalone-single-file`** — the built page is one `.html` with everything inlined. Its only
  network dependency is the pptxgenjs CDN script, loaded lazily on first export. A build that emits
  sidecar files or adds network dependencies breaks the artifact's only deployment story (download
  one file, open it). A published comparison's `imagecompare.json`, images and thumbs files are data
  the page reads from its own directory (`published-comparison-opens-itself`), never code it needs.
- **`published-comparison-opens-itself`** — on load the page makes exactly one request for
  `imagecompare.json` in its own directory. Absent or unreachable, the landing is left exactly as it
  was. That covers any non-OK response, an HTML page in its place (as from a host that rewrites every
  path to one page), and a throwing fetch (as on `file://`). Present, it opens a comparison of
  exactly the listed files, each fetched by its relative URL, unless the user has already opened a
  folder, which wins. `files` is a listing, not a configuration: the dropped-folder path's
  shared scanner decides what the files mean (columns, tuples, names, order), so a published
  comparison can never be laid out differently from the same folder opened locally. `host`
  and `thumbs` change what the page offers and how fast the strip fills, never what the files mean.
  The manifest is reported on the landing rather than opened when:
  - `files` is not a non-empty list of relative paths inside the page's directory;
  - `thumbs` is present and is not such a list;
  - `host` names no known regime.
- **`host-regime-is-one-table`** — everything a hosting regime implies is one row of the table in
  `standalone/hostRegimes.ts`, keyed by the manifest's `host`. That row holds the capability flags a
  published page states on `init`, and the publish limits the sharing script enforces. The adapter
  and the sharing script both read that row and restate none of it, so a new regime is a new row. An
  unknown `host` is reported on the landing, never defaulted to a row it did not name. A page that
  guessed would offer an export its host blocks, and report success with nothing saved.
- **`published-originals-never-written`** — in a published comparison the only write target is the
  viewer layer. A listed file is never written or deleted. Viewer-made files (crops, `results.txt`)
  are written and deleted normally. Breaking any one of three sites either loses the viewer's own
  work, or offers a Delete that fails, or claims one that succeeded:
  - the layer refuses both for a listed path;
  - every listed image reaches the webview flagged `readOnly` on `init`;
  - the webview greys Delete and ignores Del for a target holding a `readOnly` image.
- **`viewer-layer-per-comparison`** — a published comparison's viewer layer and its saved view are
  namespaced by the comparison's URL directory. Two comparisons served from one origin never read or
  overwrite each other's votes, crops or view. Nothing in the layer leaves the browser except by the
  viewer's own action: a copy to the clipboard (results.txt through `copyResults`, Copy Image), or a
  PPTX export where the regime offers one. The page sends it nowhere.
- **`view-restored-by-name`** — a saved view identifies the tuple and the modalities by name only,
  never by index. A restore applies only names that still match and leaves the rest at its default.
- **`view-restore-is-navigation`** — restoring a saved view calls the actions navigation calls. No
  load, prefetch, sweep or column-report code knows that a view was restored.
- **`view-kept-only-where-stated`** — a view is saved and restored only when the host's
  `restoresView` capability says so. The extension never states it, so its behaviour is unchanged.
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
