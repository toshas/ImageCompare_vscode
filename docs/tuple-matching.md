# Tuple Matching

How files scattered across modality directories become the rows of a comparison, and the
rules that keep the resulting indices honest.

Code: `fileService.ts` (`scanForImages` → `scanDirectoriesAsModalities` → `matchTuplesWithTrie`).

Scan-time matcher only. A file appearing *after* open is placed by a separate heuristic in
`handleNewFile` (`imageCompareProvider.ts`) — the trie matcher is a batch algorithm over a complete
scan and never runs for watcher events (`docs/file-watching.md`, "Watcher-added files use a second,
separate matcher"). They do *not* share a filename contract: the trie matcher knows `_cropNN` (tie-break
rule 1 tests `/_crop\d+$/`, `docs/crop-and-pptx.md: cropnn-writer-reader-match`), while `handleNewFile`
matches by generic substring containment (`baseFilename.includes(tuple.name)`) and treats a crop as an
ordinary name. The other `_crop\d+` readers are `getNextCropNumber`, `findCropTuples` and
`findParentTuple` in `imageCompareProvider.ts`, all bound to the writer in `handleCropImages`.

Pinned by `test/unit/tupleMatching.test.ts` (Vitest), which imports the real `matchTuplesWithTrie`
and `scanForImages` from `fileService.ts` through the `vscode` mock alias — the suite once held pure
copies that could silently drift; the copy is gone (`docs/testing.md`, "The copy trap (historical)").

## The problem

A *modality* is a column (one directory, or one selected file); a *tuple* is a row (the same
subject across modalities). Nothing in the filesystem says which files belong together. The
names are only *nearly* equal, because each producer stamps its own suffix:

```
gt/    img_00001_gt.png            img_00001_crop01.png
pred/  img_00001_pred_v2.png       img_00001_crop01.png
```

Matching is a heuristic over filenames; every rule below exists because some real tree broke a
simpler rule.

## Why a reference modality

Pairwise all-to-all matching has no anchor and no stable identity for a row. Instead one
modality is elected reference and *its* files define the rows: each file of every other modality is
attached to the reference file it best matches. `MatchedTuple.key` (the reference basename) is what
the row is keyed on. The matcher's sort by key is intermediate — it fixes the tuple order the
collision suffixes below follow — and the displayed order is a final `naturalSort` by tuple *name*
(`rows-keyed-by-reference`).

The key is not what `results.txt` persists. Votes are written against `ImageTuple.name`
(`writeResultsFile`, resolved back by `mapWinnersToIndices`), which is
`findCommonSubstring(names) || matched.key`, plus a ` (2)`, ` (3)`… suffix from `uniquify` when that
name repeats — the longest common substring of *the matched cluster's* filenames, falling back to the
key only when there is none, then de-duplicated. So the durable vote key is *emergent*: adding or
removing a modality's file changes the cluster, the common substring can shift, and an existing vote is
orphaned (`docs/session-files.md: durable-vote-key`; this section is why it is fragile).

The collision suffix is a second, quieter version of the same hazard. `takenTupleNames` fills in tuple
order, so which colliding row gets the bare name and which gets ` (2)` depends on position: a change
that alters an *earlier* tuple's common substring can move the suffix onto a different row, and a
saved vote then re-targets silently — it still resolves, just to the wrong tuple. The suite pins that
colliding names are made unique, not which row keeps the bare one.

The reference is the modality with the most files — maximal coverage, since a non-reference file with
no matching reference file creates no row and is merely absorbed. The election uses strict `>`, so a
tie goes to whichever modality is first in the `modalities` array (caller order, see below). Ties are
common (all modalities complete), and benign only because with equal counts the choice rarely changes
the outcome.

## Two passes: exact, then fuzzy

**Pass 1 — exact basename equality** (extension stripped), run to completion over all modalities
before any fuzzy work. Fuzzy scoring is not trustworthy enough to beat an identical name: crop files
typically carry the *same* name in every folder (`..._crop01.png`), and prefix scoring would happily
attach them to a longer original. An exact hit is ground truth and removes the file from pass 2.

**Pass 2 — longest common prefix via a trie.** The trie is built once from the reference
basenames; each node carries the indices of every reference file passing through it. Walking a
query name down the trie yields, at the deepest reachable node, the candidate set for free —
no scan of the reference list.

The root holds all indices, so the candidate set is never empty: a query with no common prefix
falls back to "every reference file" and is resolved by tie-breaks, leaving the `NO MATCH` path
unreachable while the reference modality is non-empty. This rests on one easily-deleted line — the
build pushes each index onto the root before walking its characters — and deleting it turns a
no-common-prefix query into an empty candidate set, dropping the file from every tuple.

## Tie-breaks, in order

Applied among candidates sharing the LCP:

1. **Non-crop reference beats crop reference** (`/_crop\d+$/`) — unconditionally, before any
   length or similarity consideration.
2. **Smaller `|refLen − queryLen|`**.
3. **Higher LCS** (longest common subsequence).

**Why crop deprioritization is rule 1, not a tiebreak among equals.** A crop's name is the
original's plus a suffix, and both live side by side. A query with its own long suffix
(`img_00001_prediction.png`) can be *closer in length* to `img_00001_gt_crop01.png` than to
`img_00001_gt.png` — so length alone hands the original's row to the crop: the original tuple loses
that modality and the crop tuple gains a non-crop image, both wrong. Crops already pair in pass 1
(identical names), so excluding them from pass 2 costs nothing and closes the class regardless of
suffix lengths. Tests 4 and 5 pin it (a `_pred` or `_longmodality` query lands on `_gt`, not `_crop01`).

**Why LCS is last.** LCP (the trie) sees only a shared *prefix* and length-difference only size —
neither notices an identifier surviving in the *middle* while the surroundings differ. LCS does, but
it is the O(L²) rule and order-insensitive enough to reward coincidental overlap, so it *decides* only among
what the cheaper, sharper rules could not separate: candidates already tied on crop-ness *and*
length, never overriding a length verdict — though `lcsLength` is computed for every candidate,
which is where the O(C·L²) below comes from. It is the last resort that *sometimes* catches a middle
identifier, not the mechanism that does.

The comparator is greedy from `bestIdx = candidates[0]`, seeded `bestIsCrop = true` /
`bestLenDiff = Infinity` / `bestLcs = -1` only so the first *comparison* can't reject that default —
no seed is a claim about candidate 0. A lone candidate is taken as-is, with the crop rule not applied.

## Complexity

- Trie build: O(R·L) time and O(R·L) memory (every node stores an index list; total entries =
  R + the sum of reference name lengths — the root push contributes one per file).
- Matching walk: O(N·L) over all files.
- Tie-breaking: O(C·L²) time per fuzzy query but O(L) space — `lcsLength` keeps two rows, not the
  full DP table. C is the candidate count, small when names share long prefixes (the intended case)
  but degrading to C = R for a query sharing no prefix — worst case O(N·R·L²). It has not mattered
  because directories that compare have names that look alike.

## Modality order and naming

`scanDirectoriesAsModalities` does not sort; the array order it receives is the modality order of the
whole session. A session file's `paths` order is intentional — a baseline-then-variants or
ascending-epoch listing is meaningful, and sorting by name would destroy it.

The one exception is mode 1 (single directory, subfolders as modalities): subfolders have
no caller-intended order, so `scanDirectory` sorts them (`naturalSort`) *before* calling in.
The sort lives at the call site, not inside the shared function — that is the invariant.

Names come from:

- **Mode 2** — directory names, expanded with parent segments by `disambiguateDirectoryNames`
  only as far as needed to make them unique. **Mode 1** subfolders are unique within one parent, so
  their bare names are used — no disambiguation.
- **Mode 2 with a session file `labels` array** — `applyLabels` overrides the disambiguated names,
  keyed by URI string. Why they exist and why they must be injected at every naming site or none:
  `docs/session-files.md: labels-all-or-none` ("Why `labels` exist").
- **Mode 3** (files selected) — `findDifferingParts` strips the common prefix and suffix;
  collisions get a ` (2)`, ` (3)`… suffix from the shared `uniquify`, which probes the taken set
  rather than counting.

A modality name is the join key everywhere downstream (`findImageForModality` looks up by
*name*, not position). Two modalities with the same name would silently merge — hence
disambiguation, the uniqueness check on `labels`, and `uniquify` in mode 3.

## Trap 1: sparse on the extension side, dense in the webview

The same tuple has two shapes, and confusing them is the recurring index bug:

| | shape | length | missing modality |
|---|---|---|---|
| Extension (`ImageTuple.images`) | **sparse** | ≤ `modalities.length` | *absent* — the entry does not exist |
| Webview (`TupleInfo.images`) | **dense** | exactly `modalities.length` | placeholder with `name: ''` |

`scanDirectoriesAsModalities` only pushes images for modalities the tuple has, so
`tuple.images[i].modality !== modalities[i]` in general — an offset into `tuple.images` is not a
modality index; use `findImageForModality(tuple, modality)`. `sendInitData` re-densifies over
`allModalities`, emitting a placeholder per gap, so webview-side position *is* the global modality
index (`modalityAdded` splices a placeholder into every tuple to keep it so) — but a webview image
with an empty `name` has no bytes behind it.

## Trap 2: original vs display modality index

The webview lets the user reorder modality columns. `modalityOrder[displayIdx] = originalIdx`
is the only mapping, and it lives in the webview: the extension's `modalities` array is *always* in
original order. The extension does see display order in one place — `exportPptx` carries
`modalityOrder` on the wire and `handleExportPptx` iterates it so slides come out in the user's column
order — but it only reads it through, never stores it.

Which space each value lives in — the wire is original; `winners` is *display* in the webview
(`main.ts`) and *original* in the extension (`PanelState.winners`), so the same field name means a
different space on each side — is now encoded by the branded index types in `types.ts`. The brand is
not uniform coverage; the main classes it does not reach:

- **String keys.** The thumbnail cache key `${tupleIndex}-${originalModIdx}` is a string.
- **`Record<number, …>` keys.** `init.winners` and `winnersReset.winners` are keyed by plain `number`
  (TS index signatures cannot take a branded key), so only their *values* are branded.
- **`postMessage({...})` object literals**, which take `unknown` — the wire brand is not enforced at
  the boundary itself (`wire-index-is-original`).
- **Extension-side index parameters and fields.** About a dozen are still plain `number` —
  `slotMatchesUri`, `loadImageToCache`, `sendThumbnailMessage`/`sendThumbnailErrorMessage`,
  `removeModality`, `regenerateThumbnail`, `DeletedFileInfo.modalityIndex` — so the extension's
  internal plumbing is largely unbranded even though the wire types are not.

And the sanctioned conversions are the exception rather than the rule: `toDisplay`/`toOriginal` are
used at four sites in `main.ts`, while raw `modalityOrder[displayIdx]` indexing appears at roughly
twice as many. The brand documents intent at the boundaries; it does not police every hop.

`results.txt` sidesteps the whole question by persisting modality *names* and tuple *names*;
`mapWinnersToIndices` re-resolves them to original indices at load. That is deliberate — indices
are not durable across a rescan, names are.

### Mutating a display-ordered array with a wire index (`unpermute-before-splice`)

Trap 2 above is about *lookup*; mutation is where this broke. `modalities`, `modalityColors` and
`modalityPaths` are **display**-ordered arrays, and TS cannot brand-restrict `T[]` index access — so a
handler splicing them at a wire (original) index corrupts a permuted array, correct only until the
first reorder. The two handlers resolve this differently. `handleModalityRemoved` un-permutes all
three through the *previous* `modalityOrder` (`restoreOriginalOrder`), splices at the wire index,
and resets the order to identity. `handleModalityAdded` never un-permutes: it converts the wire
index to a *display* position (`displayOrderAfterInsert`) and splices the display arrays there,
because the user's arrangement must survive the insert (`rearrangement-survives-insert` below);
`modalityColors` is instead rebuilt by permuting the wire payload (original-order over the
post-insert set) through the preserved order. (`images` is display-ordered too but needs no
un-permute: both handlers reset it to `[]` and reload, never splice it.)

The second half is carrying display-space *values* across each handler's order change: they were
indices into the old permutation. `winners`, `currentModalityIndex` and `previousModalityIndex` are
mapped through `prevOrder` on remove (`carryIndex`), and on add merely shift at the insertion's
display position, since the permutation itself is preserved. A value carried across a space change
*unmapped* is the bug.

**Neither half is caught by the compiler**, and this is the thing to be clear about before deleting
anything here. A stale display index and a fresh one are both `DisplayModalityIndex`, so carrying one
straight across the reset is a same-type assignment; deleting the `restoreOriginalOrder` calls just
splices a `string[]`. The brand rejects *mixing spaces* (assigning an `OriginalModalityIndex` where a
`DisplayModalityIndex` is expected is a TS2322/TS2345), which is a different mistake from the one this
section is about. Nothing but the code comments and this doc keeps the un-permute and the carry alive
(`unpermute-before-splice`).

## Invariants

- **`rows-keyed-by-reference`** — rows are keyed by the reference file's basename; the *displayed*
  order is a final `naturalSort` by tuple **name**, the same rule watcher-time insertion maintains
  (`docs/file-watching.md: rows-insert-in-order`) — sorting by key put `X_crop01` ahead of a parent
  keyed `X_gt`. Modality order can still *change which modality is elected reference* (the election
  tie-breaks on array position), which changes the keys and, through naming, can change the names —
  so row order is not modality-order-independent in general.
- **`reference-seeds-one-tuple`** — every reference file yields exactly one tuple; nothing else
  creates tuples.
- **`one-file-per-modality`** — a modality contributes at most one file per tuple. Matching is
  many-to-one, not an assignment: if two files of one modality choose the same reference, the later one
  overwrites the earlier in the tuple's map and the earlier is dropped from the view.
- **`exact-before-fuzzy`** — pass 1 is total before pass 2 begins, and pass 2 skips anything pass 1
  matched.
- **`crop-never-beats-noncrop`** — a crop reference never beats a non-crop reference when both are
  candidates.
- **`modality-order-is-callers`** — modality order is the caller's; sorting is the caller's job
  (`scanDirectory` sorts its subfolders before calling). `classifyUris` preserves input order despite
  parallel stats.
- **`names-are-join-key`** — modality names are unique, and are the join key — position is not.
- **`sparse-vs-dense-tuples`** — extension-side tuples are sparse; webview tuples are dense with
  `name: ''` placeholders, and the two must not be indexed the same way.
- **`wire-index-is-original`** — `modalityIndex` on the wire is always the original/global index.
- **`revalidate-slot-before-write`** — async loads re-validate `(tupleIndex, modalityIndex) → uri` via
  `slotMatchesUri` before writing a cache entry, because watcher events re-index tuples underneath
  in-flight work. Whether a stale slot also suppresses the *message* depends on who is waiting: on the
  requested image path it guards the cache write only — both the image and the error reply are
  re-addressed rather than suppressed, falling back to the enqueued slot when that slot is empty
  (`docs/loading-architecture.md`: `reply-exactly-once`); on prefetch — nobody is waiting,
  so a stale slot drops the post along with the cache write. Thumbnails used to be the asymmetric case: a successful post
  was dropped on a stale slot while `thumbnailError` went out unguarded, blanking a slot that was
  actually fine. Every delivery — the requested image, the bulk sweep, on-demand
  thumbnails and single-slot regeneration — therefore resolves its slot through `resolveSlotForUri`
  on both the success and the
  error path: the index it was enqueued at is checked first and is almost always still correct, and
  only when a splice actually moved the row does it fall back to finding the file by URI. A splice
  moves the row rather than voiding the work, so nothing has to be re-requested to repair it: a modality
  add/remove still asks for every thumbnail, tuple add asks only for the new row, and tuple removal
  asks for none.
  `watcherLogic.ts` declines a rename it cannot prove unique for the same reason
  (`docs/file-watching.md`: `rename-never-guessed`).
- **`rearrangement-survives-insert`** — a watcher-inserted modality must not reset the user's pill
  arrangement, the focused modality, or display-space state: the new column lands beside its
  original-order predecessor (`displayOrderAfterInsert`, pure and suite-pinned), and existing
  display indices only shift at the insertion point. Resetting to identity order was the old
  behavior and reads as data loss to a user who curated an order.
- **`unpermute-before-splice`** — a handler holding an original (wire) index must un-permute a
  display-ordered array (`modalities[wireIndex]` and friends) before splicing it, and must carry
  display-space values through the *previous* `modalityOrder` before resetting it. **Both halves are
  invisible to the type system** — TS can't brand-restrict `T[]` index access, and a stale
  `DisplayModalityIndex` is type-identical to a fresh one — so deleting either produces a clean build
  and a bug that appears only after the first column reorder. See "Mutating a display-ordered array
  with a wire index".
