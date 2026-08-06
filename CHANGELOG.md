# Changelog

All notable changes to the ImageCompare extension will be documented in this file.

## [Unreleased]

## [0.3.0] - 2026

### Added
- **Session files (CLI entry point)**: Two listed paths may not resolve to the same location (compared case-insensitively on Windows and macOS) — two modality columns on one directory would make every URI-keyed lookup ambiguous. Opening a `*.imagecompare` file (JSON `{"paths": [...], "labels"?: [...]}`) starts a comparison via a custom editor — enables scripted invocation (`code session.imagecompare`) and reopenable comparison artifacts. Relative paths resolve against the file's directory. A file that is missing, renamed or malformed renders an explanatory page in the tab rather than leaving an unresolved editor, as does one whose paths hold no comparable images; closing the tab while its directory is still being scanned tears down cleanly
- **Modality labels**: The optional `labels` array overrides modality display names in multi-directory mode (useful when compared directories share a basename, e.g. epoch dirs from different training runs). Explicit labels are shown untruncated; the exemption applies only where labels actually reach the modality names, so a mode-1 or file-list session carrying a stray `labels` array does not suppress truncation
- **CI test job**: The publish workflow now runs the standalone test suites before building platform packages
- **Context menus on the image and pills**: right-click the image for Copy Image / Copy Path / Reveal in Explorer; right-click a pill for Copy Path / Reveal in Explorer. A plain pill click only selects
- **Hide a modality from its pill**: right-click a pill → Hide Modality grays it out; arrow-key cycling and Space-flip skip it, while clicking it, digit jump, reordering, voting and export still work — right-click again → Show Modality. View-only state, per panel
- **Bounded priority work pool**: every image read and decode is scheduled through one process-wide pool, ordered `VISIBLE < SIBLING < EXPORT < PREFETCH < THUMBNAIL < THUMBNAIL_BULK < POLL`, FIFO within a rank, cancellable by key and capped at `max(1, min(4, cpus-1))` concurrent tasks. The image on screen can no longer queue behind a thumbnail sweep, a prefetch wave or the existence poll; speculative ranks (`PREFETCH` and below) are additionally capped at `concurrency - 1` running slots, so background reads already running cannot hold every slot against a navigation (waived at concurrency 1)
- **Agent skill ships with the extension**: `skills/imagecompare` is packaged into the VSIX so a coding agent can drive a comparison; maintainer-only tooling (`skills/verify-docs`, `docs/`, `scripts/`) is excluded
- **All comparisons are session-file backed**: The explorer command now saves the selection as a session file in extension storage and opens it via the custom editor. Comparisons survive window reloads, appear in Open Recent, and re-selecting the same folders focuses the existing tab. Generated session files are pruned after 30 days (user-authored files untouched), and the pruner never removes a session that a window reload is in the middle of restoring

### Changed
- **Much faster loading of large images**: full images in browser-native formats (JPEG, PNG, WebP, GIF, BMP) are now sent as their original bytes instead of being decoded and re-encoded to PNG. Re-encoding a 12MP JPEG produced a ~30–50MB base64 PNG that was slow to encode, transfer, and decode; the original JPEG is a fraction of that and the webview decodes it natively. Only TIFF/PPMX (not browser-displayable) are still converted.
- **Instant tuple navigation**: Prefetch now pushes neighbor images into the webview cache (not just the extension cache), so stepping up/down to a prefetched tuple renders immediately with no spinner. The full-image request is also leading-edge debounced — an isolated navigation loads at once; only rapid stepping/holding coalesces.
- Editor tab titles now show the session file name (VSCode controls custom editor tab labels); the explorer command derives it from the selection's common prefix. Use the `workbench.editor.customLabels.patterns` setting to hide the `.imagecompare` suffix
- **Modality order follows the order directories are provided**: For multiple selected directories (or a session file's `paths`), modalities now display in that given order instead of being sorted alphabetically — the caller controls the order. A single directory's subfolders are still sorted for a stable view. `classifyUris` also assembles results in input order so this is deterministic.
- **Per-pill colors via session files**: A `.imagecompare` file may include a `colors` array (aligned with `paths`, hex `#rgb`/`#rrggbb`) to override modality pill colors; unspecified sessions keep the default palette cycle.

### Fixed
- **File-watcher / async race hardening** (audit of the live-update subsystem):
  - In-place overwrites (delete+recreate of the same path — atomic saves, next-epoch writes) no longer get removed from the view: the restore path now cancels the pending 500 ms delete.
  - In-flight thumbnail loads revalidate their slot before posting, and image loads before caching, so a file deleted mid-load can no longer poison a re-indexed slot's cache (and the webview `img.onload` bounds-checks the tuple, fixing a crash).
  - `handleFileChanged`/`regenerateThumbnail` use the global modality index consistently, fixing wrong-slot updates on tuples that are missing a modality.
  - All watcher timers and handlers stop once the panel is disposed, and per-panel subscriptions are released on close — previously they accumulated in a provider-wide list across every panel open/close.
  - The delete-detection sweep no longer stats files synchronously on a 2 s interval: it runs every 10 s, only while the tab is visible, one sweep at a time, through the work pool at the lowest priority. Deletions on mounts where no watcher fires now surface in up to 10 s instead of 2, in exchange for no longer stalling the extension host.
  - Rename detection no longer hijacks an unrelated tuple when ≥2 files were deleted in one directory within the window (only unambiguous matches are treated as renames).
  - Reordering pills keeps the tooltip path attached to its modality; added-modality pill color fixed at ≥9 modalities.
  - **Stuck-spinner / stale-frame fixes** (root causes): `render()` and `loadTuple` always derive the displayed frame from the image cache keyed by the *current* tuple, so switching modality while a tuple is still loading can no longer reveal the previous sample's frames; `loadTuple` requests every not-yet-cached modality (previously a partially-cached tuple could leave a modality permanently unrequested); the extension's `sendImage` answers every request — at the file's live slot, or at the enqueued slot once that slot is vacated — and re-sends the current tuple's images after a tuple removal shifts indices; and the webview handles image **decode failures** (`img.onerror`, e.g. a partial read while a run rewrites the file). No watchdog polling for unanswered replies — the webview↔extension channel is reliable in-process messaging; the one retry is a single re-request after a decode failure.
  - New-file thumbnails use the global modality index (were using a sparse-array position, producing a wrong/blank thumbnail on tuples missing an earlier modality); pill Space-peek target stays attached to its modality across `[`/`]` reordering.
- **Modality pill path tooltip is reliable, and clicking a pill copies the path**: the tooltip was a native `title=`, which the browser dismisses when the pill's text is rewritten — win counts re-render on every vote — and does not restore until the pointer leaves and re-enters, so the path appeared only intermittently. It is now a webview tooltip that follows hover directly. The path itself was also not always a path: a file-list comparison (and a multi-folder one matching into a single row) had no modality directory, so the pill fell back to showing its own name, and a modality discovered after open was sent without a path at all. All modes now resolve a real filesystem path through one resolver. Clicking a pill selects the modality and copies that path.
- **PPTX export no longer produces corrupt decks on large sessions**: every slide image was embedded as a full-resolution PNG (a 12MP image is 30-50MB), so a big export could push the archive past the 4GB zip-offset limit that pptxgenjs's zip writer cannot exceed — PowerPoint then reports the file corrupt and drops the trailing images on repair. Slide images are now capped at 2560px and JPEG-recompressed (a slide is 10 inches wide; full resolution bought nothing), a zero-dimension crop callout can no longer write Infinity into the slide XML, and the deck is built to a single buffer written once before the completion notification fires
- **PPTX completion notification gains a Reveal in Explorer button**
- **Opening no longer stalls in bursts**: after a few thumbnails, the pool's every slot went to the first tuple's full-resolution sibling loads (a 5-10s freeze on network mounts), then to the prefetch wave — thumbnails only streamed once both finished. Foreground now leaves one slot to background work while any is queued, and within background no class may take a second slot while another waits with none — so thumbnails keep streaming through sibling bursts, prefetch waves and the existence poll alike; the visible image is exempt and no slot idles when only one class has work
- **Warm opens read one packfile instead of thousands of cache files**: the thumbnail disk cache is per-entry files, so reopening a large session cost one small network read per thumbnail. The memory cache (raw JPEG bytes, base64 per delivery) is now snapshotted into an atomically-renamed pack + index pair, lazily loaded on the first request — a warm open of a 2000-thumbnail session becomes one sequential read. Per-entry files stay the write path, so concurrent windows never contend, and a torn pack/index pair is rejected outright by a shared-uuid check rather than ever serving wrong bytes
- **Pool width raised from 4 to `min(16, cpus-1)` and speculative slots split max-min fair**: the width-4 cap was justified by "matching libuv", but the pool's tasks are file-service RPC reads and Sharp decodes on Sharp's own threads — latency-bound work where width is what hides a slow mount's round trips. At width 4, a prefetch wave saturated everything and the thumbnail sweep repeatedly stalled mid-open (measured at 2061/2261 and 1159/2261); with 16 slots and each freed speculative slot going to the queued class with the fewest running tasks, prefetch, thumbnails and the existence poll converge to even shares and the progress bar keeps moving. The sweep now also logs a one-line pool snapshot to the debug channel each cycle
- **Cropping inserts the new tuple on every mount**: the crop handler wrote its files and then waited for its own filesystem event to report them — instant on local disk, but on network/FUSE mounts no watcher fires, so the crop never appeared until reopen. Deleting already updated the view eagerly; crop now does the same, routing each written file through the create handler directly. New rows are also inserted at their natural-sort position instead of after the currently viewed row — a crop that arrives late (silent-watcher mounts) lands beside its parent, not beside wherever the user navigated meanwhile. Reopening reproduces that order: the scan now sorts rows by tuple name as well, where it previously sorted by reference-file key, which could put `x_crop01` ahead of a parent keyed `x_gt`
- **The crop rectangle survives a modality switch at any resolution**: with same-aspect modalities of different sizes, switching modality while a rect was open drew it in the old image's pixel coordinates — wrong size and position on the new image. The overlay now re-maps the rect relatively when the image under it changes, matching how the crop itself is applied
- **A closed tab now cancels an export**: closing the tab mid-export left the PowerPoint export decoding on a dead panel — it still wrote the .pptx, then threw posting the result. Crop had the same unguarded completion post, and a cancelled crop could leave a partial set that the next crop silently overwrote (the crop number is now the highest across all modality directories, not the first one's).
- **Crop no longer launches every modality's decode at once**: it fanned out one full-resolution decode per modality with no bound, so a wide tuple could contend with the image on screen. Crop and PowerPoint export are now scheduled through the work pool at `EXPORT` — above speculative prefetch, since the user asked for them, below the visible image. Each adopted modality directory also gets its own watcher pair, released when the modality is removed — base-directory mode only, since a folder comparison has no path that would re-adopt the directory — so a pipeline that rotates output directories cannot accumulate them toward the system's file-watcher limit.
- **Selected folders can no longer collapse into one column**: when the shortest-unique-tail naming ran out of path segments to compare (equal tails, one path shorter), it emitted the same name twice, and the two directories then shared one entry of the name-keyed modality map — silently merging into a single modality with three or more folders selected, and aborting the comparison outright ("Selected directories must each contain images with matching names") when only those two were. Repeats are now suffixed, probing for a free one rather than counting, so a generated ` (2)` cannot collide with a directory actually named that. The same probing rule now also names mode-3 modality columns and tuple rows, replacing a counting suffix a directory literally named `x (2)` could collide with — for tuple rows that collision made one `results.txt` line vote for two rows. The rule lives in a pure module the suite imports.
- **Thumbnails stay in memory again on large sessions**: the in-memory cache was capped at a size that fit only a few thousand entries, so a session larger than that evicted and re-read from disk on every revisit — and evicted in insertion order, dropping exactly the rows a user scrolls back to. The cap is now sized past a realistic session and evicts least-recently-used.
- **A file deleted while its image is loading no longer leaves a permanent spinner**: the reply was addressed to the row it was requested for, and when the file left the view mid-load nothing answered at all — the slot stayed blank forever, and because the tuple never finished loading, prefetch stalled at that position too.
- **Deleting a row no longer leaves stale pixels under a neighbour's name**: an image load in flight when a row was removed was posted at the index it was enqueued at, so the webview filed it against whatever row now sat there and rendered it under that row's name on the next step — and kept it, since nothing evicts or re-requests a slot it already holds. Image replies are now re-addressed at delivery, the same way thumbnails are.
- **A closed tab no longer throws while its thumbnails land**: every thumbnail still in flight resolved after disposal and posted to a torn-down webview, one unhandled rejection each. The three post primitives now check disposal, as does slot resolution.
- **Deleting a row while its files are still being removed no longer drops the wrong row**: the row index was captured before the per-file deletes and used afterwards, so a delete committing during them (or a new file arriving) shifted the rows and spliced a neighbour instead. The row is now re-found by identity.
- **Thumbnails survive a row being added or removed mid-load**: every thumbnail delivery was addressed by the row index it was enqueued at, so a tuple insert or delete during the open-time sweep misdelivered every queued result at or after the splice: each row from the splice on was painted with its neighbour's thumbnails and the tail row left gray — one crop during startup shifted a whole carousel a row out of step — while a stale *error* post could blank a healthy row for the life of the panel. Deliveries now re-resolve their slot as they land — the enqueued index first, falling back to finding the file by URI only when a splice actually moved it — so a re-index redirects the result instead of voiding it.
- **A session whose listed path has since been deleted now works properly**: paths that fail to stat are dropped before the mode is decided, but the panel still chose its shape from the original list — so two folders of which one had been removed resolved to a single-directory comparison with voting, `results.txt` and new-file pickup all silently off. The shape now follows what the scan actually found.
- **A modality directory added to a single-row comparison is now detected**: the new-file path was gated on `isMultiTupleMode`, which means "more than one row" — so a base-dir comparison that currently held exactly one row (the first tick of a run) silently ignored every new file. `ScanResult` now carries an explicit `mode`, and the mode-3 check asks for that.
- **A new modality directory now appears without reopening**: in base-directory mode the watcher on the base dir is non-recursive, so images written inside a newly created subdirectory were never reported and the modality stayed invisible until the comparison was reopened. Three detectors now cover it — the VS Code watcher, an `fs.watch` on the base dir (which holds no images and so was previously unwatched), and the existence sweep, which reads the base directory each cycle. The sweep matters most: on network and FUSE mounts neither watcher reports a directory create at all, so pickup there happens within one sweep interval rather than instantly. Adoption is single-flight per directory (the three detectors race), skips image-less and dot directories, remembers barren ones by mtime so a large unrelated sibling is not re-listed every cycle, and re-lists the directory once its watcher is armed so a file written during the first listing is not missed. A modality appearing (or one being removed) mid-session now re-indexes the already-loaded thumbnails and prefetched images through the splice instead of clearing them, so the carousel no longer goes gray and reloads on a modality event. The sweep also re-lists every watched directory and picks up files the silent watchers never reported — so copying a directory into the comparison no longer loses the files that landed after the copy was first noticed.
- **Winner results stored next to the session file when folders have no common root**: When comparing directories in different locations (e.g. epoch dirs from separate training runs), `results.txt` was written into the first folder's parent, burying votes in one arbitrary run. Such comparisons opened from a `.imagecompare` file now store results next to the session file as `<session>.results.txt` (named per-session to avoid collisions). Single-root comparisons are unchanged
- **PPMX images now render**: the `.ppmx` float32 depth format never displayed in any prior build — the parser required a `P7` magic/flags header that real files don't have. It now accepts either magic — the real `PPMX` header as well as the legacy `P7` — with the flags line optional under both (detected by size), and a guard so a pixel byte that looks like a newline can't be mistaken for the header.
- **Cropping no longer throws on older VSCode**: crop wrote PNG metadata via `zlib.crc32`, which only exists on Node 20.15+ (VSCode ≥ ~1.91), so every crop failed on older hosts. CRC-32 is now computed locally, so crop works across all supported VSCode versions.
- **PowerPoint export marks the correct winner after reordering columns**: the ✓ was placed using the on-screen column order instead of the original modality index, so any `[`/`]` reorder put it on the wrong slide.
- **Removing a modality removes the right one after reordering**: with columns reordered, deleting a modality could remove a *different* modality's images and mis-assign its vote; the display order is now un-permuted before the removal.
- **Changing the thumbnail size no longer serves stale-size thumbnails from cache**: thumbnails were cached by file + mtime only, so changing `imageCompare.thumbnailSize` kept serving the old size forever; the size is now part of the cache key. There is no config-change listener, so an open comparison keeps the thumbnails it already has; reopen it to re-render everything at the new size.
- **Colliding tuple names no longer share a vote**: two rows whose derived name collided wrote the same `results.txt` key, applying one vote to both; names are now de-duplicated with a ` (N)` suffix.
- **The documented `Del` shortcut now works**: the README shortcut list and the Tools-panel button tooltip both advertised `Del` for deleting the current tuple's files, but no key handler was wired up — only the button worked. `Del` (and `Backspace`) now delete, and are ignored while a text field has focus.
- **Right-click no longer shifts the image on the next click**: a right-click armed the drag-pan with its position, the context menu swallowed the mouse-up, and the stale anchor applied to the next mouse action — panning only starts on the left button now
- **Copy image to clipboard actually works**: the native webview context menu could not serialize the image, so right-click (or `Ctrl+C` with nothing selected) now copies the current image directly as PNG via the browser clipboard, with an "Image copied" toast; pasteable into Slack and friends
- **Mode-2 modality columns return to their original position**: a directory-modality whose column was removed after emptying was re-inserted alphabetically when a file reappeared; it now returns to the position implied by the order the directories were listed in (mode-1 alphabetical placement unchanged)

## [0.2.1] - 2026

### Added
- **PPTX smart parent/crop logic**: When parent and crop are both voted, parent shows as simple full-image slide (voted crops get their own slides). When only parent is voted with exactly one crop, presents as if the crop was voted (crop slide with callout)
- **PPTX non-overlapping crop layout**: Crop centerpiece and callout thumbnail no longer overlap — main image shifts left, thumbnail shrinks if needed
- **Crop scales to each modality's resolution**: Crop rect converted to relative coordinates (0–1) then scaled per-modality, fixing incorrect crops with different image sizes (e.g., 4K vs 1080p)
- **Crop metadata cross-compatibility**: Sharp path now also injects PNG tEXt chunk alongside EXIF, so crops are readable by the standalone HTML tool

### Fixed
- **PPTX crop centerpiece anchored to bottom**: When downsized to avoid overlap, the crop image stays flush with the bottom edge instead of floating mid-slide

## [0.2.0] - 2026

### Added
- **PowerPoint export**: Export voted tuples to `.pptx` files with caption bars (tuple name + modality), crop callout thumbnails, and auto-incremented naming
- **PPMX support in PPTX export**: Custom float32 grayscale images now export correctly to PowerPoint
- **Crop metadata via PNG tEXt chunks**: Jimp fallback path now embeds crop coordinates in PNG tEXt chunks (Sharp path uses EXIF), enabling crop callouts in PPTX for all backends
- **Robust tuple matching tie-breaking**: Crop references (`_cropNN`) are explicitly deprioritized in fuzzy matching, preventing long modality names from incorrectly matching crop files

### Fixed
- **PPTX caption bar rendering**: Replaced complex Sharp-rendered PNG captions with simple pptxgenjs text boxes — no more font metric issues or wrapping bugs
- **PPTX callout outline**: Removed visible outline artifacts from crop callout thumbnails
- **Floating panel violet dot**: Hidden `#thumb-viewport` element before any image is loaded
- **Floating panel initial size**: Canvas starts at 160x100 to prevent zero-height panel during loading

## [0.1.9] - 2026

### Added
- **Directory name disambiguation**: Directories with the same basename are differentiated by prepending parent path components (e.g., `a/results`, `b/results`)
- **Modality pill tooltips**: Hover over a modality pill to see the full directory path
- **Autohiding carousel scrollbar**: Scrollbar only appears on hover or while scrolling

### Fixed
- **Fuzzy matching blocked by exact matches**: Modalities with different filenames (e.g., `_pred` vs `_gt`) were silently dropped when another modality had identical filenames to the reference
- **Carousel resize**: Thumbnail containers now resize properly alongside thumbnails

### Changed
- **Modality pills**: Removed numeric prefix, long names truncated at 20 characters with ellipsis

## [0.1.8] - 2026

### Added
- **Crop snap to square**: Double-click a cardinal (N/S/E/W) crop handle to make the rectangle square by adjusting that edge

## [0.1.7] - 2026

### Added
- **Crop tool**: Draw a rectangle on the image to crop all modalities at the same coordinates, saved as `_cropNN.png` files
- **Delete button**: Delete all files for the current tuple from the Tools panel
- **Floating Tools panel**: Draggable, collapsible panel with minimap, crop, and delete controls (click header to collapse, drag to move)
- **Polling-based file deletion detection**: Reliably detects file deletions on all filesystems including Google Drive/FUSE
- **Debug logging setting**: `imageCompare.debug` enables file watcher diagnostics in webview console

### Fixed
- **Tuple matching with crop files**: Two-pass matching (exact then fuzzy) prevents crop files from stealing matches
- **Winner re-indexing on tuple add/delete**: Voting annotations no longer shift to wrong tuples after crop or delete
- **results.txt persistence on deletion**: Winners file updates immediately when tuples or files are deleted
- **Duplicate file watcher events**: Fixed overlapping watchers in single-directory mode

## [0.1.6] - 2026

### Fixed
- **Sharp load failure on older CPUs**: Extension no longer crashes when Sharp native binaries fail (e.g., "Unsupported CPU: Prebuilt binaries for linux-x64 require v2 microarchitecture")

### Added
- **Three-tier image processing fallback**: Sharp native → Sharp WASM → Jimp (pure JS)
  - `sharpLoader.ts`: dynamic loader that retries with WASM when native Sharp fails
  - Jimp fallback: bundled pure-JS image library as last resort (slower but guaranteed to work)
  - Warning notification shown when running on the Jimp fallback
- **Jimp dependency**: Pure JavaScript image processing library (~1.4MB bundled by webpack)

## [0.1.5] - 2026

### Fixed
- **Cross-platform Sharp binaries**: Fixed native module loading on all platforms (Windows, Linux, macOS)
  - Platform-specific packages now correctly include the appropriate Sharp/libvips binaries

### Added
- **Cursor IDE support**: Extension now available on Open VSX for Cursor users

## [0.1.1] - 2026

### Added
- **Winner voting**: Declare a winner for each tuple in directory-based modes
  - Press Enter or click the circle on thumbnails to toggle winner
  - Winners are persisted to `results.txt` alongside modality folders
  - Win counts shown in parentheses after modality names in status bar
  - Human-readable and editable results file format

### Changed
- **Tuple matching**: Replaced regex-based `extractMatchingKey()` with trie-based `matchTuplesWithTrie()` algorithm
  - Uses longest common prefix (LCP) for efficient matching via trie
  - Falls back to longest common subsequence (LCS) for tie-breaking

## [0.1.0] - 2026

### Added
- Multi-modality image comparison (compare 2+ images)
- Batch mode: select a folder with subdirectories, each becomes a modality
- Remote support: works with VSCode Remote
- Flip comparison: hold Space to flip between current and previous image
- Zoom and pan: mouse wheel to zoom, drag to pan
- Carousel navigation with visual thumbnail grid
- Background thumbnail generation with progress indicator
- Keyboard shortcuts for efficient navigation
- Configurable thumbnail size, prefetch count, and cache settings
