# Session Files

`*.imagecompare` files are the single entry point to every comparison: what the format holds, why
the entry point is a file at all, and where votes get written.

Code: `sessionFile.ts` (`parseSessionFile`, `applyLabels`, `suggestSessionFileName`), `extension.ts`
(`openSelectionAsSession`, `openCustomDocument`/`resolveCustomEditor`, pruning),
`imageCompareProvider.ts` (`openCompare`, `getResultsTarget`), `fileService.ts` (`writeResultsFile`,
`readResultsFile`). Pinned by `src/test/sessionFile.test.ts`, which imports the real source.

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
| 1 directory (with 2+ image subdirs) | 1 | each **subdirectory** is a modality; images matched across them by filename | `baseUri` set, `modalityDirs` empty |
| 2+ directories | 2 | each **directory** is a modality (name = basename, extended leftward by `disambiguateDirectoryNames()` until unique) | `baseUri` unset; `modalityDirs` populated from `roots` |
| 2+ image files | 3 | one tuple; modality names derived from the filename differences | both unset |

Mixing files and directories is rejected, as is a lone image file; a single *directory* is mode 1,
not a rejection. A listed path that fails to stat is dropped before the mode is decided, so two
listed directories of which one is missing resolve to mode 1 on the survivor — the mode follows what
the scan found, not what the caller asked for.

A single directory of only files is rejected: it has no second axis. Each file would become its own
"modality" — the same one-tuple shape mode 3 makes deliberately, but arrived at by accident.
`scanDirectory()` throws with the three valid alternatives rather than guess which the user meant.

## Format

```json
{ "version": 1, "paths": ["/abs/dir", "../rel/dir"], "labels": ["a", "b"], "colors": ["#0f0", "#ff6600"] }
```

`parseSessionFile(text, baseDir)` in `sessionFile.ts` is pure (no `vscode` import) so it is
unit-testable standalone — `src/test/sessionFile.test.ts` runs under plain `ts-node`. Keep it that
way; that is why `applyLabels()` is structurally typed over `{ toString() }` instead of taking
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
and revealing go through the native webview context menu — `data-vscode-context` attributes on the
pill and viewer, `contributes.menus."webview/context"` entries in `package.json`, and commands the
extension resolves back to a URI via `resolveMenuTarget`. Path writes use `vscode.env.clipboard` in
the extension, since a webview is not reliably granted `navigator.clipboard` for text; the image
write is the exception — no extension API accepts image bytes, so Copy Image round-trips to the
webview's `navigator.clipboard`. The tooltip is a webview element, not a native `title=`: pill text
is rewritten on every vote to restore win counts, and a native tooltip dismissed by that rewrite
does not return until the pointer leaves and re-enters — which is what made it look intermittent.

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

Voting is enabled iff the comparison is directory-based (`votingEnabled = baseUri !== undefined ||
modalityDirs.size > 0`) — mode 3 has a single tuple and nothing to rank.

Votes are held in memory as `PanelState.winners: Map<tupleIndex, modalityIndex>` and persisted as
a human-editable text file (`writeResultsFile()` / `readResultsFile()` in `fileService.ts`, both
taking an optional filename). The on-disk key is `ImageTuple.name`; `mapWinnersToIndices()`
resolves it back to indices on load. The name is an emergent common substring of the cluster's
filenames, so changing cluster membership can change it and orphan votes
(`docs/tuple-matching.md`, "Why a reference modality"). Indices are volatile, re-shifted when
modalities are added or removed; nothing durable may depend on them.

Colliding names are de-duplicated with a ` (N)` suffix on **both** tuple-creation paths — the scan
(`scanDirectoriesAsModalities`) and the watcher (`handleNewFile`) — so two tuples never share a vote
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
`Set` keyed by original modality index; the menu label flips via the `imageCompareHidden` context
value the pill stamps.

## Invariants

- **`hidden-is-presentation-only`** — hiding a modality changes pill styling, the context-menu label,
  and keyboard cycling; **nothing else reads the set**. Loading, prefetch, voting, PPTX export,
  matching and reordering are oblivious, and the state dies with the panel — it is not persisted to
  the session file. The cycling itself is `nextVisibleModality` (`webview/modalityVisibility.ts`,
  pure, suite-pinned), non-wrapping like the arrow keys it serves.

- **`custom-editor-entry`** — every comparison opens through a `.imagecompare` custom editor.
  `openCompare()` receives a panel; it must never create one. A new entry point writes a session file.
- **`sessionfile-vscode-free`** — `sessionFile.ts` stays `vscode`-free; it is the unit-testable core
  (`src/test/sessionFile.test.ts`).
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
- **`modality-path-always-real`** — every reachable path through `resolveModalityPath` returns a real
  filesystem path, never the modality name standing in for one (the trailing `return modality` is a
  total-function fallback no caller can reach). Modes 1 and 2 have a directory to
  name; a file list does not, so it falls back to the first file carrying that modality. Every
  producer of that string — the init payload and `modalityAdded` — goes through the one resolver.
