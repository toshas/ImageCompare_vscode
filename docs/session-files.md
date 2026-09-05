# Session Files

`*.imagecompare` files are the single entry point to every comparison: what the format holds, why
the entry point is a file at all, and where votes get written.

Code: `sessionFile.ts` (`parseSessionFile`, `applyLabels`, `suggestSessionFileName`), `extension.ts`
(`openSelectionAsSession`, `openCustomDocument`/`resolveCustomEditor`, pruning),
`imageCompareProvider.ts` (`openCompare`, `getResultsTarget`), `fileService.ts` (`writeResultsFile`,
`readResultsFile`). Pinned by `test/unit/sessionFile.test.ts` (Vitest), which imports the real source.

Read this before adding an entry point, changing the file format, touching `getResultsTarget()`, or
"simplifying" the explorer command into a direct panel creation.

## Why a file at all

Two forces, both external:

1. **The remote `code` CLI opens files, but not URIs and not commands.** A comparison launched from a
   terminal or a script must therefore be *a file on disk that opens into a viewer*; any design passing
   a folder list to a command dies on remote/SSH windows.
2. **Custom editors get reload-restoration for free.** VSCode re-resolves an open custom editor
   after a window reload and lists it under Open Recent. A `WebviewPanel` created by a command
   would vanish. Making comparisons custom editors (`imageCompare.sessionFile`, `filenamePattern:
   *.imagecompare`, `package.json` → `contributes.customEditors`) buys persistence with no state
   machine of our own.

Consequence: `openCompare()` never creates a panel — `resolveCustomEditor()` hands it one, and even
the explorer command writes a file and calls `vscode.openWith`. Exactly one code path in.

## What the resolved paths mean (the three modes)

`sessionFile.ts` only resolves `paths` to absolute path strings (`resolveCustomEditor()` turns them
into URIs); `scanForImages()` (via `classifyUris()`) decides what they *mean*, purely from what the
paths are on disk.

| Selection | Mode | Meaning | `PanelState` |
|---|---|---|---|
| 1 directory (with 1+ image subdirs) | 1 | each **subdirectory** is a modality; images matched across them by filename | `baseUri` set, `modalityDirs` empty |
| 2+ directories | 2 | each **directory** is a modality (name = basename, extended leftward by `disambiguateDirectoryNames()` until unique) | `baseUri` unset; `modalityDirs` populated from `roots` |
| 2+ image files | 3 | one tuple; modality names derived from the filename differences | both unset |
| 1 directory of loose images (no image subdirs) | 3 | the same, on the images the directory holds | both unset |

Mixing files and directories is rejected, as is a lone image file; a single *directory* is never a
rejection for being one — it resolves to mode 1 or mode 3 by what it holds. A listed path that fails
to stat is dropped before the mode is decided, so two
listed directories of which one is missing resolve to mode 1 on the survivor — the mode follows what
the scan found, not what the caller asked for.

The last two rows are the same mode reached two ways, which is the point: dropping a folder of
images and selecting those same images produce one comparison, not two behaviours. `scanDirectory()`
prefers structure where there is any and falls back to the loose images, so the mode a directory
resolves to is a fact about its contents. Both directions of that fall-back used to be rejections —
a directory of only files threw "no subdirectory structure", and a directory holding a single
image subdir threw "must contain 2+ subdirectories". Neither refusal survived contact with what the
viewer can actually display: a comparison runs at one column, and empties only at zero.

The alternative considered and rejected was the **transpose**: a folder of images as N rows of one
column, which would have been a fourth mode. It reads well on paper and badly in use — the carousel
becomes the only way to see anything, `keepZoomOnTupleChange` has to be forced on for flipping
between images to mean anything, and every "the three modes" claim in the repo becomes four. Mode 3
already *is* "one row whose columns are unrelated files", which is what a folder of images is; the
only thing that was missing was reaching it from a directory. Voting, crop, PPTX and delete then
need no new answers — they get mode 3's, which is why `exports-land-beside-the-images` is a repair
to an existing hole rather than a new rule.

## Format

```json
{ "version": 1, "paths": ["/abs/dir", "../rel/dir"], "labels": ["a", "b"], "colors": ["#0f0", "#ff6600"] }
```

`parseSessionFile(text, baseDir)` in `sessionFile.ts` is pure (no `vscode` import) so it is
unit-testable standalone — `test/unit/sessionFile.test.ts` needs no `vscode` stub at all. Keep it
that way; that is why `applyLabels()` is structurally typed over `{ toString() }` instead of taking
`vscode.Uri`.

- `version` — optional, positive integer; absent means 1 (every pre-versioning file). The parser
  rejects a version above `CURRENT_SESSION_VERSION` outright — an old build must fail loudly on a
  future file, not open it minus the fields it doesn't know. Bump only for semantic changes; a new
  optional field costs nothing (unknown keys are ignored).
- `paths` — required, non-empty array of non-empty strings, **no two resolving to the same
  location**. **Relative paths resolve against the
  session file's directory** (`path.resolve(baseDir, p)`), so a session file can be committed
  next to the data it describes and stay portable.
- `labels` — optional, an array of non-empty strings, **aligned with `paths` (same length) and
  unique**. Uniqueness is
  not cosmetic: a modality name is the join key downstream (`findImageForModality()` looks up by
  name), so duplicates would silently merge modalities.
- `colors` — optional, aligned with `paths`, `#rgb` or `#rrggbb`. Overrides the `MODALITY_COLORS`
  palette cycle in `resolveModalityColor()`.

A modality pill shows that resolved path on hover; a plain click only selects the modality. Copying
and revealing go through the comparison's own context menu, which the webview builds and renders
(`webview/contextMenuModel.ts` decides the items, `webview/contextMenu.ts` draws them) — so the
standalone offers the same menu minus whatever its `HostCapabilities` disclaim
(`docs/standalone.md: affordances-rendered-by-the-webview`). Copy Image and Hide/Show Modality are
performed in the webview; Copy Path and Reveal in Explorer post `menuAction`, which each host
resolves back to a target its own way (the provider through `resolveMenuTarget`, the adapter inline
over its scan). Path writes use `vscode.env.clipboard` in the
extension, since a webview is not reliably granted `navigator.clipboard` for text, and
`navigator.clipboard.writeText` in the standalone, which has no such host. The tooltip is a webview
element, not a native `title=`: pill text is rewritten on every vote to restore win counts, and a
native tooltip dismissed by that rewrite does not return until the pointer leaves and re-enters —
which is what made it look intermittent.

Both `labels` and `colors` are keyed **by the URI of the listed path**. That means they only take
effect in mode 2, where the listed directories *are* the modalities. In mode 1 the listed path is
the parent and the modalities are its subdirs, so `scanDirectory()` is never handed the labels at
all — nothing can match. In mode 3
`modalityDirs` is empty, so `colors` never resolves.

A malformed or missing session file must never throw out of `resolveCustomEditor()` — that leaves
VSCode with an unresolved custom editor. Webview options are set *before* the parse so the error page
can always render into the panel. Generated sessions live in a pruned cache, so "file gone" is
normal, not exceptional. A session that parses but matches no images gets its own page
(`getEmptyScanHtml`) for the same reason: anything that can end in an empty panel renders its
explanation *into* the panel, because a toast fades and a blank tab does not.

## Why `labels` exist

Directories from different sources often share basenames. `disambiguateDirectoryNames()` resolves
collisions by walking leftward one segment at a time until names are unique — but directories that
diverge near the filesystem root get *names* the length of a full path. The pill never shows that
much: `pillLabel()` in `main.ts` cuts an auto-derived name to 19 chars plus an ellipsis — so the cost
is not an oversized pill but an uninformative one, since two names sharing a long leading run
truncate to the same string. The untruncated name is still what `results.txt`, the watchers and
`findImageForModality()` carry. `labels` let the caller name the modalities itself, and an explicit
label is exempt from the truncation.

They are injected at the naming source: `applyLabels()` wraps `disambiguateDirectoryNames()` in
*both* places names are produced — `scanForImages()` and `openCompare()`'s `modalityDirs`
construction. The labeled name is what watchers key on, what `results.txt` stores, what the modality
pills are *labelled* with (`btn.textContent`; a pill's tooltip is that modality's directory path, not
its name), and what `findImageForModality()` joins by. Label one call site but not the other and
`modalityDirs` misses every modality (`scanResult.modalities.includes(name)` fails), silently
disabling voting and the mode-2 new-file path (`handleNewFile` maps a created file to its modality
through `modalityDirs`, and bails when it is empty). The directories stay watched either way —
`watchedDirs` also collects every leaf dir holding an image.

## The two open paths

**Explorer command** (`imageCompare.openInCompare`) → `openSelectionAsSession()`: writes
`{"paths": [...]}` into `globalStorage/sessions/`, named by `suggestSessionFileName()`. Then
`vscode.openWith`.

- **Reuse before uniquify**: if a file with that name already holds byte-identical content, it is
  reopened — and because `supportsMultipleEditorsPerDocument: false`, VSCode focuses the existing
  tab instead of opening a duplicate. Re-selecting the same folders is idempotent.
- Same name, different content → numeric suffix (`base_2.imagecompare`).

**Directly**: a user-authored file in the workspace, `code session.imagecompare`, or a script.
Same custom editor, same code path.

### `suggestSessionFileName()` — two branches, not one rule

The single-selection case is **not** the multi-selection rule with N=1:

- **One path** (the usual mode-1 open — a parent directory of modality subdirs): its basename is
  taken *verbatim*, skipping **both** the ≥3-char and the not-generic tests. Selecting one folder
  named `images` yields `images.imagecompare`, not `compare_1`. That is deliberate — the user picked
  exactly one thing, so its name is the best label available, generic or not.
- **Two or more paths**: the common prefix of the basenames, but only if it is ≥3 chars and not
  generic (`GENERIC_NAMES` — `images`, `output`, `test`, …, matched after stripping separators and
  digits); otherwise `compare_N`, N being the selection size.

Either branch is then sanitized (non-`[\w.@+-]` runs → `_`), capped at 60 chars, and falls back to
`comparison` if under 2 characters survive.

### Pruning

Generated sessions older than 30 days are deleted on activation (best-effort), **skipping files
open in a custom-editor tab**. Two reasons, and both are needed:

- `vscode.window.tabGroups` catches sessions the user still has open — deleting one would break
  its reload-restoration. The scan keeps only `vscode.TabInputCustom` tabs, so the guard covers
  exactly the tabs that *are* comparisons; a `.imagecompare` opened in a plain text editor
  (`TabInputText`) is not protected and can be pruned out from under it.
- `openSessionUris` (populated in `openCustomDocument`, cleared on dispose) catches sessions
  *mid-restore*: on window reload a restoring editor may not yet appear in `tabGroups`. Prune is
  also deferred ~15s past activation for the same race. Do not "simplify" either guard away.

Only `globalStorage/sessions/` is pruned. User-authored session files elsewhere are never touched.

### Save Session As

The escape hatch from the pruned cache: the title-bar save icon (or Ctrl/Cmd+S, intercepted in the
webview — native save no-ops on a readonly custom editor) copies the session to a user-chosen
location. `saveSessionAs()` seeds the dialog with the mode's natural home — base dir (mode 1),
common parent (mode 2), the first image's directory otherwise — and writes via
`serializeSessionFile()`, which stamps `version` and relativizes paths **only when every compared
root lies inside the destination directory**; a single escapee keeps all paths absolute, because a
`..` in a session file breaks the moment the file moves. If votes live in a `<stem>.results.txt`
sidecar (the no-canonical-place case), the sidecar is copied alongside under the new stem;
folder-anchored `results.txt` needs no copy. It is a *copy*, not a move: the open panel stays on
its original file, and votes cast after the save land at the original's results target until the
user saves again.

## Tab titles

VSCode owns custom-editor tab titles (`filename-is-tab-title`), so the *filename* is the UI — which is
why `suggestSessionFileName()` aims for a meaningful common prefix rather than a UUID. Users can hide
the extension with `workbench.editor.customLabels.patterns`.

## Winner voting persistence

Voting is enabled iff the mode allows it (`votingAvailable()` in `modePolicy.ts` — mode 3 is one row
of unrelated files, with nothing to rank) **and** the host has somewhere to put the answer (the
provider: `baseUri !== undefined || modalityDirs.size > 0`; the standalone: a writable root). The
mode half is read from `ScanResult.mode`, not inferred from `baseUri`/`modalityDirs` both being unset
— which is the same thing, until it isn't (`mode-is-explicit`).

Votes are held in memory as `PanelState.winners: Map<tupleIndex, modalityIndex>` and persisted as
a human-editable text file (`writeResultsFile()` / `readResultsFile()` in `fileService.ts`, both
taking an optional filename). The on-disk key is `ImageTuple.name`; `mapWinnersToIndices()`
resolves it back to indices on load. The name is an emergent common substring of the cluster's
filenames, so changing cluster membership can change it and orphan votes
(`docs/tuple-matching.md`, "Why a reference modality"). Indices are volatile, re-shifted when
modalities are added or removed; nothing durable may depend on them.

Colliding names are de-duplicated with a ` (N)` suffix on **both** tuple-creation paths — the scan
(`scanDirectoriesAsModalities`) and the arrival planner (`planArrival` in `arrivalPlan.ts`) — so two tuples never share a vote
key. Both must keep doing it: `mapWinnersToIndices` looks the key up per tuple, so one duplicate name
makes a single results line vote for every row that carries it. The line format still has holes: a name starting with `#` reads back as a
comment, one containing `=` truncates at the first `=`, and the reader trims both the line and each
field, so leading or trailing whitespace never round-trips — `findCommonSubstring()` strips it from
scan-time names — except for its one raw return, a single-image tuple's basename, and for the
caller's `findCommonSubstring(names) || matched.key` fall-through to the reference basename, which
`findCommonSubstring()` never touches — and a watcher-created tuple takes the raw basename
unfiltered. A newline inside a filename splits the record outright.

### `getResultsTarget()` — where the file goes

| Case | Target | Filename |
|---|---|---|
| Mode 1 (`baseUri` set) | the selected root, next to the modality subdirs | `results.txt` |
| Mode 2, all dirs under the first dir's parent | that parent | `results.txt` |
| Mode 2, **no shared root**, opened from a session file | the session file's **directory** | `<session-stem>.results.txt` |
| Mode 2, no shared root, no session file | first dir's parent (legacy fallback) | `results.txt` |
| Mode 3 | none — voting disabled | — |

Directories gathered from unrelated trees (the third row) have no meaningful common ancestor; the
shared-root rule would bury `results.txt` in whatever the first-listed directory's parent happens to
be — unrelated to the comparison, and silently overwritten by a second comparison rooted in the same
place. Writing next to the session file puts votes where the comparison is *defined*, and the
per-session filename (`<stem>.results.txt`) keeps several session files in one directory from
colliding. Any change here must keep read (`sendInitData()`) and write (`saveResults()`) going
through the same `getResultsTarget()` — the only reason votes reload.

Writing zero winners deletes the file rather than leaving an empty stub.

A pill can be **hidden** from its context menu (Hide/Show Modality): grayed out, still clickable and
digit-jumpable, but skipped by arrow-key cycling and as a Space-flip target. The state is a webview
`Set` keyed by original modality index, and the menu label flips because `buildContextMenu` is
handed that state as `MenuContext.hidden`.

## Invariants

- **`tiny-tiles-never-vote`** — when carousel tiles are smaller than 3x the winner circle
  (`isVoteClickable`, pure and suite-pinned), the circle stops taking mouse clicks
  (`pointer-events: none` via the `tiny-tiles` class): at that size a tile click is a coin-flip
  between navigate and vote, and a mis-vote silently corrupts `results.txt`. Enter-voting is
  unaffected. All three sites — the rule, the class toggle, and the CSS guard — carry the citation.
  Note what changed under it: the tile floor used to be 12 px, below the 21 px threshold, so a grid
  dense enough to hit the floor was *always* unvotable by mouse. At the 24 px floor
  (`docs/loading-architecture.md: columns-virtualize-like-rows`) it no longer is, so a scrolled
  column window and a clickable vote circle now co-occur — which the rule allows, being about size
  and not about density, but nothing had exercised that combination before.
- **`hidden-is-presentation-only`** — hiding a modality changes pill styling, the context-menu label
  (`buildContextMenu` reads it as `MenuContext.hidden`),
  keyboard cycling, and the *order and scope of speculation* — nothing else. The carousel keeps
  showing the column, so nothing the user can still reach may be dropped for it: speculative work
  skips hidden columns (sibling loads and prefetch waves,
  `docs/loading-architecture.md: sibling-order-by-display-distance`) because a click or digit jump
  re-requests them on demand, while the open-time sweep only ranks them **last** and still sweeps
  every one (`docs/loading-architecture.md: sweep-cross-then-row-major`) — a skipped sweep slot would
  be a blank tile in a column that is still on screen. Voting, PPTX export,
  matching and reordering are oblivious, and the state dies with the panel — it is not persisted to
  the session file. The cycling itself is `nextVisibleModality` (`webview/modalityVisibility.ts`,
  pure, suite-pinned), non-wrapping like the arrow keys it serves.

- **`custom-editor-entry`** — every comparison opens through a `.imagecompare` custom editor.
  `openCompare()` receives a panel; it must never create one. A new entry point writes a session file.
- **`sessionfile-vscode-free`** — `sessionFile.ts` stays `vscode`-free; it is the unit-testable core
  (`test/unit/sessionFile.test.ts`).
- **`sessions-add-no-mode`** — resolved paths go through `scanForImages()` unchanged; mode detection
  is a function of the paths on disk only.
- **`relative-to-session-dir`** — relative paths resolve against the session file's directory, never
  the workspace root or cwd.
- **`version-gate-forward`** — a session file declaring a version above `CURRENT_SESSION_VERSION` is
  rejected with an "update the extension" error, never half-opened with unknown fields dropped; the
  version bumps only on semantic changes, since unknown keys are ignored anyway.
- **`saveas-relative-only-inside`** — Save Session As relativizes paths only when every compared
  root lies inside the destination directory; one path outside keeps all of them absolute. A saved
  file containing `..` would silently re-target if the user later moves it.
- **`unique-modality-names`** — no two modalities ever share a name or a URI. `paths` rejects a
  repeated location (two modalities on one URI would make every URI-keyed lookup resolve both to the
  first), and `disambiguateDirectoryNames` suffixes any tail collision its widening loop cannot
  separate. A duplicate name silently merges two columns downstream.
- **`aligned-unique-labels`** — `labels` and `colors` are aligned with `paths`, and `labels` are
  unique; duplicate modality names silently merge modalities.
- **`labels-all-or-none`** — labels are applied at every naming site or none:
  `applyLabels(disambiguateDirectoryNames(…))` in both `scanForImages()` and `openCompare()`, so
  watchers, `modalityDirs`, `results.txt`, and the pill labels all see the same names.
- **`resolve-never-throws`** — `resolveCustomEditor()` never throws and an empty panel is never left
  unexplained: configure the webview first, then render the error or empty-scan page into it.
- **`prune-double-guard`** — prune skips both open tabs and `openSessionUris`, and stays deferred.
  Either guard alone loses the reload race.
- **`filename-is-tab-title`** — generated session filenames come from `suggestSessionFileName()`. VS
  Code takes a custom editor's tab title from the document filename and ignores `panel.title`, so
  UUID names make tabs unreadable. Nothing sets the *panel's* title, so don't hunt for an enforcement
  site; the `.title` writes that do exist are on unrelated objects (the PPTX export, static button
  hints in the markup).
- **`single-results-target`** — reads and writes of results go through `getResultsTarget()`; a new
  placement rule is added there once, not duplicated at a call site.
- **`durable-vote-key`** — the durable vote key is `ImageTuple.name`, not the tuple key and never an
  index.
- **`mode-is-explicit`** — code asking "which selection shape is this?" reads `ScanResult.mode`, and
  what the scan *used* from `ScanResult.roots` — never the caller's raw URI list, which still holds
  paths that failed to stat. `isMultiTupleMode` means only "more than one row"; the `ScanResult`
  field has exactly one sanctioned reader, `findMatchingDeletedFile()`, where the row count is
  genuinely the question (sibling-directory rename matching means nothing in single-tuple mode). The
  webview's same-named module-local in `src/webview/main.ts` is not this field — it is recomputed
  there from `tuples.length > 1` as a row-count convenience for the UI, so a grep for the identifier
  finds readers this invariant does not cover. Using it as a mode test silently disabled voting and new-file
  pickup for any *single-tuple* multi-directory comparison; the deleted-path case broke separately,
  from reading the caller's raw URI list instead of `roots`.
- **`modality-path-always-real`** — every reachable path through the provider's `resolveModalityPath`
  and the adapter's `modalityPath` returns a real
  filesystem path, never the modality name standing in for one (the trailing `return modality` is a
  total-function fallback no caller can reach). Modes 1 and 2 have a directory to
  name; a file list does not, so it falls back to the first file carrying that modality. Every
  producer of that string — the init payload and `modalityAdded` — goes through its host's one
  resolver. Both hosts need marking: the adapter reached mode 3 only once a directory of loose
  images started resolving to it, and until then `<root>/<modality>` was true there by construction.

- **`subdir-structure-wins`** — a directory that holds any subdirectory with images opens on those
  subdirectories as columns, and only a directory with none falls back to its loose images. One
  subdir is enough: mode 1 *discovers* its columns, so finding one is an answer, not a user error.
  Mode 2 keeps the floor of two, because there the caller named the directories and one of them
  yielding nothing is worth reporting — which is why the floor is a function of the mode
  (`scanDirectoriesAsModalities`) rather than a constant.
- **`folder-of-images-is-a-file-list`** — a directory of loose images opens as mode 3 on exactly
  those images: the same comparison the user would get by selecting them. Enumeration drops
  `_cropNN` outputs, which are this app's own writes and would otherwise interleave with the
  parents they were cut from — unless dropping them would leave fewer than two images, in which case
  the unfiltered set opens, so a folder someone moved their crops into is not a dead end. The filter
  is enumeration-only: a hand-picked selection of files is respected as picked.
- **`mode-behaviour-is-a-table`** — everything the selection shape implies lives in one table,
  `MODES` in `modePolicy.ts`, and every site reads the **field** whose name is the question it is
  asking — `columnIsFile`, `grows`, `voting`, `cropsJoin` — never the mode number. The table is the
  executable form of the mode table above; adding a mode is a compile error at every site rather
  than a silent default, and a new consequence is a new field rather than another `mode === 3`
  scattered somewhere. This was not the original shape: the same questions were asked with a magic
  number at fourteen sites across five files, twice in two hosts that then answered them
  differently — the standalone grew a row per crop where the extension grew none, and resolved a
  column's path its own way. Two of those fields cross the wire: `deleteUnit` reaches the webview on
  `init`, so the webview never asks which mode it is in and the help modal cannot promise the wrong
  unit — the same host-states-data rule as `HostCapabilities`
  (`docs/standalone.md: affordances-rendered-by-the-webview`). A host may still add its own
  conjunct: voting also needs somewhere to write, which is the host's fact, not the shape's.
- **`exports-land-beside-the-images`** — a PPTX export writes into the base dir (mode 1), the
  modality dirs' parent (mode 2), or the first image's own directory (mode 3). Mode 3 had no third
  branch and `listExistingNames` threw "Cannot determine output directory", so export was broken
  for every file-list comparison; a directory opened as mode 3 makes that the common case, since the
  first image's directory *is* the directory the user opened.
