# File Watching

How filesystem events mutate an open panel's view state: which mechanism reports an event, how a
delete+create is told apart from a rename, and what must be re-indexed when a tuple or modality
disappears.

Code: `imageCompareProvider.ts` (`setupFileWatcher`, `handleFileDeleted` / `handleFileCreated` /
`handleFileChanged`, `removeTuple`, `removeModality`, `handleNewFile`) and `watcherLogic.ts` (the
pure decision helpers). Pinned by `test/unit/watcherLogic.test.ts` (Vitest), which imports the real source.

Scheduling of the existence sweep (async, `POLL` priority, 10s, non-overlapping, visibility-gated)
belongs to the loading architecture — see `docs/loading-architecture.md`, "Filesystem watching".
This document is only about the *state mutations*.

## Three detection mechanisms

The primary use case is watching a training run write images while it trains, over whatever mount
the storage happens to be. No single mechanism is reliable there, so three overlap:

| Mechanism | Set up on | Reports |
|---|---|---|
| `vscode.FileSystemWatcher`, one per `watchedDirs` entry | any scheme | create, change, delete |
| Node `fs.watch`, one per *leaf* dir (dirs directly holding images) plus mode 1's base dir | `file` scheme only | delete (derived); directory create (derived, base dir only) |
| Existence sweep over every tracked URI, every watched leaf dir, plus the mode-1 base dir | `file` scheme only | delete; new file in a watched dir; new modality dir (mode 1) |

Why more than one: VS Code's `onDidDelete` does not fire on some platform/filesystem combinations, so
`fs.watch` backs it up. Its `rename` event says only "an entry appeared or vanished", so the handler
waits 50ms and then `access`es the path — gone means delete; present means a create the VS Code
watcher will report anyway, except on mode 1's base dir, where the present branch is detector 2 below
and routes the new directory to `adoptNewModalityDir`. The 50ms probe is async on purpose; a synchronous `stat` here runs on the
extension-host thread.

On FUSE and network mounts (Google Drive, NFS-backed run directories) *neither* watcher fires. The
sweep is the only thing that notices a deletion there — a fallback and nothing else; everything it
catches, the watchers catch faster on local disk.

Watchers are per-directory and non-recursive. Mode 2 directories are unrelated absolute paths with no
common ancestor, and a VS Code glob is relative to one base and cannot span them, so each gets its own
watcher. The pattern is `*`, never `**/*` — including mode 1's base dir, where recursion looks right:
every leaf directory already has its own watcher, so a recursive glob on the parent would report each
file *twice*. The non-recursive pattern is a deduplication guard, and it forces the mode-1 caveat below.

## The sweep must re-verify before reporting

A sweep observation is only meaningful at the instant it is made: tasks are queued at `POLL` priority
and picked up long after, and an in-place overwrite — which a training step does on every save — is
delete-then-create, so a batched "missing" would delete a file that is already back. `runDeleteSweep`
therefore `access`es a second time before reporting; if the file has returned it was a rewrite, not a
deletion. Watcher-sourced deletes don't need this because the create that follows an overwrite cancels
the pending delete (below).

## Rename detection

A rename is indistinguishable from a delete followed by an unrelated create, so deletion is
*deferred* rather than applied:

1. `handleFileDeleted` finds the slot, pushes a `DeletedFileInfo` onto `recentlyDeleted`
   (URI, tuple index, **global** modality index, timestamp), drops the cache entry, and arms a
   500ms timer. Nothing is removed yet. A URI already in `recentlyDeleted` is ignored, which is
   what de-duplicates the same delete arriving from watcher *and* sweep.
2. If a create lands inside the window, `handleFileCreated` claims the pending entry and the delete
   never happens.
3. Otherwise the timer fires and the image leaves the tuple — then one branch or the other, never
   both: a tuple that still holds images gets a `fileDeleted` to the webview, while one that just
   lost its last image is removed via `removeTuple` and the webview sees `tupleDeleted` instead.

Entries live at most 2s (`cleanupRecentlyDeleted`, run lazily whenever a delete or create is
processed). It is a ceiling, not the working window: committing a delete drops its own entry first,
so the 500ms timer normally disposes of the entry itself. The 2s bound only reaps entries whose timer
found nothing left to commit, and keeps a long-stale entry from claiming an unrelated later create.

The timer re-resolves *both* of its indices when it fires, because either can shift while it is armed:
it captures the tuple *object* and looks its index up (a create elsewhere can splice a tuple in ahead
of it), and it re-resolves the modality index from the modality *name*, bailing if that column is gone.
The entries in `recentlyDeleted` are re-indexed on modality add/remove but an already-armed closure is
not, so a captured column index would go stale and commit against the wrong modality.

### Claiming a pending delete

`handleFileCreated` tries, in order:

**Exact URI match** (`findExistingSlotByUri`) — the slot still exists, so this is a restore or an
in-place overwrite. This path must remove the pending delete for that exact URI, or the armed 500ms
timer fires afterwards and deletes the file that just came back.

**Rename match** (`findMatchingDeletedFile` → `matchDeletedFile`) — the URI is unknown, so it may be
the new name of a pending delete. The image's `uri`/`name` are updated in place, keeping the tuple
and its index, cache key, and winner intact; the webview is told `fileRestored`.

`matchDeletedFile` matches only when the answer is *unambiguous*:

- Exactly one pending delete in the same directory → that one.
- Two or more in the same directory → no match, deliberately. Nothing says which delete the new file
  renames from, and an arbitrary pick would hijack an unrelated tuple's slot to point at this file.
  Declining degrades to delete + new file, which is recoverable; a hijack is not.
- No same-dir candidate, multi-tuple mode only: a pending delete in a *sibling* directory under the
  same parent with the *identical filename*, if unique. Same-filename-across-modalities is the signal,
  and it means nothing in single-tuple mode.

**Neither** → `handleNewFile`, which places a genuinely new file (modes 1 and 2 only).

## Watcher-added files use a second, separate matcher

The trie matcher of `fileService.ts` (`docs/tuple-matching.md`) is a batch algorithm over a complete
scan and does not run here, where a watcher event delivers one file against an already-built tuple
list. So `handleNewFile` (`imageCompareProvider.ts`) implements its own placement heuristic — two
matchers, two rule sets, one filename convention; change the convention and both must move.

The heuristic scores every tuple and takes the longest match. A tuple scores its own name's length
when that name is a substring of the new file's basename (`String.includes`), because a longer tuple
name is the more specific one (`img001_crop01` beats `img001`). It scores the *maximum* — the whole
basename's length — if any image it already holds has exactly that basename: an identical filename in
a sibling modality is the strongest signal there is, so it outranks even a longer tuple name, and it
is what re-groups files whose tuple name is not a substring of them (a de-duplicated `name (2)`, or a
common-substring name trimmed down to something the filenames do not literally contain). Ties break
toward a tuple with that modality slot *free*. If the best match's slot is already taken, the file
becomes a new tuple — it never falls back to a less specific match, which would put two different
subjects in one row.

New tuples are inserted at their natural-sort position among the existing row *names*
(`tupleInsertIndex`, sharing the scan's comparator), so a crop lands right after its parent and a new
epoch file lands where a reopen would put it — wherever the user has navigated meanwhile, which
matters when the create arrives a whole sweep late. (The scan's
final order is by tuple name too — one rule on both paths, so a reopen reproduces the live order.) It
used to be `currentTupleIndex + 1`, which put a late-arriving crop beside whatever row the user had
moved on to. An insertion at or before the current row is what forces the index *up*-shift described
below. The new tuple's name is the file's basename, uniquified with the
same ` (2)`, ` (3)`… suffix the scan path uses (`docs/session-files.md: durable-vote-key`) — two
tuples sharing a name would make one results line vote for both.

## Re-indexing

Tuple index and global modality index are the identity of a slot: `loadedImages` keys are
`` `${tupleIndex}-${modalityIndex}` ``, `winners` maps tuple index → modality index, and
`recentlyDeleted` stores both. Splicing `scanResult.tuples` or `scanResult.modalities` invalidates
every one of them, so all of them are re-indexed **in the same operation** as the splice.

`shiftIndexAfterRemoval(index, removed)` (`watcherLogic.ts`) is the single rule: `null` if it *was*
the removed element (caller drops the entry), `index - 1` if it sat after it, unchanged otherwise.

- `removeTuple` splices the tuple, then re-indexes `loadedImages`, `winners` and `recentlyDeleted`,
  and clamps `currentTupleIndex`.
- `removeModality` splices the modality, strips its images from every tuple, **clears** `loadedImages`
  wholesale (every key past the removed column is wrong, and the column is gone anyway), and shifts
  the *modality* index in `winners` and `recentlyDeleted`.
- `addNewModality` and the new-tuple branch of `handleNewFile` are the mirror image: insertion shifts
  indices *up*, and `addNewModality` likewise clears `loadedImages`.

A user-initiated delete (`handleDeleteTuple`) deletes every one of the tuple's files *and* then calls
`removeTuple` itself, instead of deleting them and letting the watcher report it. The watcher may be
up to a sweep — 10s — away on a mount where only the sweep fires, and a row that lingers after you
deleted it reads as a broken command.

`removeTuple` calls `refreshCurrentTupleImages` after posting `tupleDeleted` (and before persisting
results), and is its **only** caller. A load in flight for the previously-current tuple was captured
against its old index, and the reply is re-addressed at delivery
(`docs/loading-architecture.md`: `reply-exactly-once`), so it lands on the row the file is in *now*
rather than under a neighbour's name. What re-sending fixes is the other half: the webview asked for
the old index and nothing fills it, so without the re-send the tuple now under the cursor can strand
on a spinner.
The webview's `tupleDeleted` handler *also* ends in `loadTuple`, making this belt-and-braces
— keep it anyway; the extension-side re-send must not depend on the webview handler staying that way.

The other mutating paths do not call it and do not need to — the webview re-requests for itself:

- `removeModality` / `addNewModality` → the webview's `modalityRemoved` / `modalityAdded` handlers
  re-index `loadedTuples` and the thumbnail map through the splice (they used to clear both, which
  blanked every on-screen thumbnail and prefetched neighbour on any modality event) and end with
  `loadTuple(currentTupleIndex)`, re-asking only for slots the re-indexed cache cannot serve. The
  *extension* still clears its own `loadedImages` on both paths; a webview re-request simply misses
  its cache and re-reads.
- the new-tuple branch of `handleNewFile` → inserts at the row's natural-sort position, which can be
  at or before the current tuple; both sides' `currentTupleIndex >= insertIndex` guards shift the
  current index with the splice so the view stays on the same row, and in-flight deliveries survive
  because every delivery re-resolves its slot (`docs/tuple-matching.md`: `revalidate-slot-before-write`).

## Events by mode

| Event | Mode 1 (base dir) | Mode 2 (dir per modality) | Mode 3 (files) |
|---|---|---|---|
| File deleted | yes | yes | yes |
| File created, exact URI | restores the slot | restores the slot | restores the slot |
| Rename (delete+create) | yes | yes | yes |
| File modified | reloads image + thumbnail | reloads | reloads |
| New file added | new or existing tuple | new or existing tuple | **no** |
| New modality dir | `addNewModality` (see caveat) | n/a — dirs fixed at open | n/a |
| Modality dir deleted | removes modality | removes modality | n/a |

Where this reflects a decision rather than an accident:

- Mode 3 ignores new files: it is an explicit list of files, with no directory structure to say what
  a new neighbour would even *be*. `handleNewFile` returns immediately when `scanResult.mode === 3` — the mode, never `isMultiTupleMode`
(`docs/session-files.md: mode-is-explicit`), so a directory comparison holding one row still accepts
new files.
- Mode 2 cannot gain a modality: the modality set *is* the user's selection, so an unselected
  directory is not a column. In mode 1 the subdirectories of `baseUri` are the modality set by
  definition, so a new one is a new column.
- Modality dir deleted is recognised in `handleFileDeleted` by comparing the deleted path against
  `baseUri`+name (mode 1) or the `modalityDirs` mapping (mode 2) *before* the per-file search. The
  same end state is reached from below by `checkModalityEmpty` once a modality's last file is gone.

Mode-1 new modality has **three** detectors, because the obvious one is the least reliable. The
base-dir glob is non-recursive (above), so a create of `base/newmod/img.png` matches no watcher
existing at that moment; the only event that can arrive is the directory entry `base/newmod`.

1. **VS Code watcher** — `handleFileCreated` routes a non-image create whose parent is the base dir
   to `adoptNewModalityDir`. Fastest, and silent on network and FUSE mounts.
2. **`fs.watch` on the base dir** — the base dir holds no images, so it is not a leaf; it is watched
   anyway precisely so directory creates have a second chance.
3. **The existence sweep** — `sweepForNewModalityDirs` reads the base dir on each sweep that runs and
   adopts any subdirectory that is not already a modality. The same cycle also re-lists every watched
   leaf dir and routes unknown image files to `handleFileCreated` — the arrival path for a file the
   silent watchers never report, including the tail of a copy that was still in flight when adoption
   took its second listing. This is the only detector that survives a
   filesystem whose watchers are silent, and on such a mount it is the one doing the work. It is the
   *most* gated of the three, though — `file` scheme only, and skipped while the panel is hidden — so
   pickup lags by at least one sweep interval, and indefinitely while the tab is hidden. It runs
   first in the cycle and inside the pool at `POLL`, so its latency is the interval rather than the
   duration of the existence pass ahead of it.

`adoptNewModalityDir` lists the directory, and if it holds images arms the watcher and then lists it
*again* before placing anything. Reading first is forced — an image-less directory must not be
watched — and the second listing is what closes the race: a file written during the first one is in
the second, and anything after the watcher exists arrives as an event. Only the second listing's
entries are dispatched, so the two cannot double-place anything; what the exact-URI branch absorbs is
a watcher event for a file created after the watcher was armed but still present in that listing. Only a directory that
already holds an image is watched — watching every image-less subdirectory would pin a watcher on
`.git`, `logs`, `checkpoints` for the life of the panel — so an empty one is simply re-examined on
later sweeps, and remembered by mtime so a large barren sibling is not re-listed every cycle —
though only for a bounded number of sweeps, since some mounts never advance a directory's mtime
(`barren-dirs-memoized`). Dot-directories are skipped in `adoptNewModalityDir` itself, where all
three detectors converge — putting the guard in the sweep alone would let the two watcher paths adopt
a `.git` created while the panel is open.

The three detectors race, so adoption is guarded by `adoptingDirs`, taken synchronously before the
first `await`. Without it two detectors interleave past the "already a modality" check and each run
the create path for the same file, producing a **second tuple holding the same image**: the first
pass suspends inside `addNewModality` while the second runs. `handleNewFile` re-checks for an existing
slot after that await, so the duplicate row is caught there too; `adoptingDirs` stops the duplicated
*work* before it starts. It is idempotent by
design — all three detectors may fire for the same directory, and a directory adopted while still
empty is re-scanned on later sweeps until it has images.

`addNewModality` is not mode-1-only: mode 2 reaches it too, when a file reappears in a directory
whose column was removed after emptying — `removeModality` never prunes `modalityDirs` and mode 2
keeps watching an emptied directory (`unwatchModalityDir` returns early without `baseUri`), so
`handleNewFile` still resolves the name and re-adds the column. Where the column lands is
`modalityInsertIndex` (`watcherLogic.ts`), and it differs by mode. A mode-2 re-add goes back to the
caller's position, derived from `modalityDirs` key order — that map preserves the order the user
listed the directories in, honouring `modality-order-is-callers` (`docs/tuple-matching.md`). Mode 1
inserts **alphabetically**, not at the end: subfolders have no caller-intended order, and
`scanDirectory` sorts them anyway. The mode-1 insert does not reproduce the scan's order, though —
it compares with a plain `localeCompare`, the scan with the natural (`{ numeric: true }`)
comparator — so with columns `[mod2, mod10]` a new `mod3` is appended last and then moves to second
on the next reopen. Cosmetic, and reopening is the fix.

## State tracking

- `baseUri` — set in mode 1 only.
- `modalityDirs` — modality name → directory URI; populated in mode 2 only.
- `watchedDirs` — every directory with a VS Code watcher: base dir (mode 1), each selected dir
  (mode 2), plus every directory directly containing an image in any mode. Grows when a mode-1
  modality directory is adopted, which creates that directory's watcher in the same step.
- `recentlyDeleted` — pending deletes; both a rename buffer and the watcher/sweep de-duplicator.

## What is pinned

`watcherLogic.test.ts` imports `watcherLogic.ts` directly and covers rename disambiguation
(`matchDeletedFile`), index re-shifting on removal (`shiftIndexAfterRemoval`), and the
insertion-position helpers (`tupleInsertIndex`, `modalityInsertIndex`). The provider-side glue
around it imports `vscode` and is therefore untested; exercise it
by hand per `docs/testing.md`, "Manual checks", with `imageCompare.debug` on to see `onDidCreate` /
`fs.watch` / `poll delete detected` in the webview console.

## Invariants

- **`rows-insert-in-order`** — a watcher-created row is inserted at its natural-sort position among
  row names, with the *same* comparator the scan sorts rows by — one function, `naturalCompare`,
  imported by both sides — so live additions keep the order a reopen would produce, and a crop sits
  beside its parent no matter how late its create event arrives or where the user is looking.
- **`self-writes-never-wait`** — a filesystem change the extension itself makes reaches the view
  eagerly, never by round-tripping through its own detectors: on network/FUSE mounts no watcher fires
  and the sweep is up to an interval away, which turns "instant on local disk" into "ten seconds or
  never" on exactly the mounts this extension exists for. The two self-writes are tuple delete
  (eager `removeTuple` after the `fs.delete` loop) and crop (each written `_cropNN` file routed
  straight through `handleFileCreated`); the detectors still see these writes later and are absorbed
  by the idempotent exact-URI branch.
- **`no-armed-delete-after-return`** — a pending delete is never left armed after the file comes back.
  Both create paths (exact-URI restore, rename match) remove the entry from `recentlyDeleted`.
- **`rename-never-guessed`** — an ambiguous rename is not guessed. `matchDeletedFile` returns -1
  rather than pick among ≥2 candidates; slots only ever move on a unique signal.
- **`reindex-in-lockstep`** — `loadedImages`, `winners` and `recentlyDeleted` are re-indexed in
  lockstep with `scanResult.tuples` / `.modalities`. No splice may land without them.
- **`modality-index-is-global`** — modality indices crossing a boundary are global (into
  `scanResult.modalities`), never a position in the sparse `tuple.images` array — a tuple missing an
  earlier modality would otherwise resolve to the wrong column.
- **`mutation-never-strands-view`** — a structural mutation cannot strand the current view, but only
  `removeTuple` discharges that from the extension side (`refreshCurrentTupleImages`, its only caller).
  `removeModality` / `addNewModality` rely on the webview's `modalityRemoved` / `modalityAdded`
  handlers re-running `loadTuple(currentTupleIndex)`; `handleNewFile`'s sorted insert can land at or
  before the current tuple, and discharges it by shifting `currentTupleIndex` with the splice on both
  sides (see the `handleNewFile` bullet above). A new path that shifts the current tuple's indices
  must re-send or be matched by a webview handler that does.
- **`sweep-reverifies-before-report`** — the sweep re-verifies before reporting a deletion. A batched
  "missing" observation is stale by the time it is acted on.
- **`duplicate-reports-idempotent`** — duplicate reports are idempotent. The same delete from watcher
  + `fs.watch` + sweep produces one state change.
- **`watched-dirs-have-watchers`** — every entry in `watchedDirs` has a live watcher behind it.
  Watcher setup runs once per panel, so a directory discovered later must create its own watcher at
  that moment or stay inert until the panel is reopened.
- **`new-modality-dir-adopted`** — a mode-1 modality directory created after open is adopted, and not
  only from the directory-create event: the VS Code watcher, the base dir's `fs.watch`, and the
  existence sweep all route to `adoptNewModalityDir`, because on a network or FUSE mount neither
  watcher fires and the sweep is the only detector left. Adoption is single-flight per directory
  (`adoptingDirs`) and re-lists the directory after arming its watcher, so a file written between the
  two listings is still placed and concurrent detectors cannot each create the tuple.
- **`barren-dirs-memoized`** — a base-dir child found to hold no images is remembered by mtime and not
  re-listed until it changes or a bounded number of sweeps has passed. The sweep runs every 10s and adoption reads the whole directory, so
  without this a large unrelated sibling — `checkpoints/`, `logs/` — is fully listed on every cycle,
  inside the pool's slot, on the mount least able to afford it. The memo is capped rather than
  absolute: object-store and SMB mounts can pin a directory's mtime, and treating that as proof of
  emptiness would hide a real modality forever on exactly the filesystems the sweep exists to serve.
- **`watchers-released-with-modality`** — removing a **mode-1** modality releases that directory's
  watchers and its `watchedDirs` entry. Mode 2 deliberately keeps both: nothing re-adopts a directory
  there, so releasing would leave the column permanently deaf if it came back. A pipeline that rotates output directories would otherwise accumulate one
  watcher pair per directory until the inotify limit breaks watching for the whole editor, and a
  directory that is deleted and recreated would keep a handle bound to the dead inode.
