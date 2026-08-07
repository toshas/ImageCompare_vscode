# Testing

What is pinned, what is not, and the one trap that makes a green run mean less than it looks.

This doc covers the nine `ts-node` suites that gate publishing. A second, independent test system —
Vitest unit layer, `@vscode/test-cli` integration layer, Playwright webview layer, running in
`.github/workflows/test.yml` on three OSes — is documented in the repo-root `TESTING.md`.

Every suite is a plain `ts-node` script with no test framework: a bare `assert` counter that exits
non-zero on failure. That is why they run without a VSCode host — and why they can only cover code
that has no `vscode` import. (`pngTextChunk` does need a working native Sharp, to mint its fixture
PNG; every other suite needs nothing but Node.)

```bash
npx ts-node src/test/tupleMatching.test.ts
npx ts-node src/test/sessionFile.test.ts
npx ts-node src/test/watcherLogic.test.ts
npx ts-node src/test/pngTextChunk.test.ts
npx ts-node src/test/workPool.test.ts
npx ts-node src/test/ppmxParser.test.ts
npx ts-node src/test/modalityVisibility.test.ts
npx ts-node src/test/thumbPack.test.ts
npx ts-node src/test/wireFormat.test.ts
```

`.github/workflows/publish.yml` runs all nine in its `test` job, which gates the whole build matrix —
a red test blocks publishing to both marketplaces.

## The suites

| Suite | Imports | Pins |
|---|---|---|
| `tupleMatching` | **a copy**, plus real `modalityNames.ts` | Trie matching end to end: crop deprioritization (rule 1), each of the two remaining tie-breaks in isolation, nested crops, row sort order, colliding tuple names de-duplicated, and — against the real source — unique modality naming including the collided-tail fallback |
| `sessionFile` | real source | Path resolution, duplicate-path rejection, `labels`/`colors` validation, malformed JSON, `applyLabels()`, `suggestSessionFileName()` |
| `watcherLogic` | real source | `matchDeletedFile()` rename disambiguation (incl. the ambiguous-multi-delete no-hijack rule), `shiftIndexAfterRemoval()`, `modalityInsertIndex()` (caller order beats alphabetical on re-add) and `tupleInsertIndex()` (crop lands after its parent; natural row order) |
| `pngTextChunk` | real source (`pngText.ts`) | tEXt round-trip, the `x,y,w,h,srcW,srcH` crop format, PNG structure survival, CRC-32 against a full-table probe |
| `workPool` | real source | Concurrency cap (incl. the reject path), priority + FIFO/seq order, cancellation, re-entrancy, error propagation |
| `ppmxParser` | real source | All four magic x flags combinations, size-based flags detection, normalization, malformed input |
| `modalityVisibility` | real source | Hidden-pill keyboard cycling: skip, run-skip, non-wrapping edges, all-hidden stay |
| `thumbPack` | real source | Packfile round-trip, uuid pairing rejection, truncation/overflow/duplicate rejection |
| `wireFormat` | real source | Image payload normalization: Buffer→plain Uint8Array (species-safe), offset views copied tight, structuredClone survival |

## The trap: one suite still tests a copy

`tupleMatching.test.ts` contains **pure TypeScript copies** of the trie-matching functions it exercises, because the
originals live in `fileService.ts`, which imports `vscode`. Nothing keeps the copy in step with the
original. A green run proves the *algorithm as transcribed* behaves — not that the shipped function
does. When you change trie matching, the test passing is not evidence; update the copy in the same
change, or the suite silently starts pinning code that no longer exists.

This is not theoretical: `pngTextChunk` used to be a copy too, and that is exactly how a
crop-breaking bug shipped. The real `pngInjectText` called `zlib.crc32` (Node 20.15+) while
`engines.vscode` allowed Node 18, so every crop threw on older VSCode — while the suite stayed green,
because its copy had its own `zlib.crc32`. The fix was structural: the logic moved to `pngText.ts`, a
pure `vscode`-free module the test now imports. **That is the pattern** — `watcherLogic.ts`,
`workPool.ts`, `sessionFile.ts`, `ppmxParser.ts`, `pngText.ts`, `thumbPack.ts`, `wireFormat.ts` and
`webview/modalityVisibility.ts` all exist because extracting a decision into a pure module is what
makes it testable at all. Prefer that over a copy.

## A green suite is not evidence

`scripts/mutation-check.mjs` (a CI gate) flips a known rule in the file the suite actually exercises —
the real source for every suite, `tupleMatching` included through `modalityNames.ts`, plus
`tupleMatching.test.ts`'s own copy for the trie mutations, since mutating `fileService.ts` would not
reach them — reruns that suite, and fails if it stays green. **Run it to see what it covers** — it prints one
line per mutation, and that output *is* the list. Nothing here enumerates them: two attempts to do so
went stale within a day, the second while correcting the first. It exists because the tuple-matching suite once passed
with several of its rules deliberately broken. When you add a test, pin a value
from *outside* the implementation (a spec constant, a hand-computed expectation); code compared to
itself proves nothing.

Every other suite imports the real source and is real coverage.

## What nothing covers

- **The image backends.** Nothing tests Jimp or `sharpLoader.ts`, and nothing tests the fallback
  chain. `pngTextChunk` uses Sharp only to mint a fixture PNG and re-read it — that exercises Sharp
  incidentally, not the loader or the tiers. See the Testing section of `docs/image-backends.md` for
  why a real test is awkward: the `Unsupported CPU` path needs a CPU no CI runner has, so it would
  have to be simulated, and the wasm32 tier it falls back to is absent from any normal install.
- **Anything importing `vscode`** — `imageCompareProvider.ts` (the largest file), `extension.ts`, the
  watcher wiring. Only their pure helpers are extracted and pinned; prefer that shape for new logic.
- **The webview.** No DOM harness; `webview/main.ts` and `crop.ts` are verified by hand.
- **Packaging.** One CI step scans the VSIX for the wasm32 tier (`docs/image-backends.md`), which
  transitively pins two entries of the `.vscodeignore` un-ignore list (`@img`, `@emnapi`). Nothing
  checks the rest of it — `sharp` itself, `detect-libc`, `semver` — whose failure mode is identical
  and silent.

## Manual checks

Failures here are invisible to CI, so they are worth walking before a release:

1. All three modes (base dir / dir-per-modality / file list) with add, delete and modify.
2. Rename detection — a quick delete+create must move the image, not drop the row.
3. Partial tuples (a modality missing an image) render a placeholder, not a hole.
4. A remote filesystem (SSH, WSL) or a FUSE/network mount, where the watchers do not fire and the
   existence sweep is the only detector.
5. In base-dir mode, add a modality directory while the comparison is open — both by `mkdir` then
   writing images into it, and by moving in a directory that is already populated. The column must
   appear without reopening. The base glob is non-recursive, so no event fires for the images inside
   it — the directory entry itself is the only event, and where neither watcher reports it the
   existence sweep is what picks it up, so allow a sweep interval before calling it a failure.
6. Carousel feel with a many-modality session (10+): it opens with every column visible; the resize
   handle tracks continuously — each drag frame runs a real refit of the virtualized row pool, so
   tiles stay crisp throughout the drag (no scale-preview softness) and the focused row holds its
   viewport position, moving only where the top/bottom bounds clamp forces it; arrow-key stepping
   keeps the tile grid pixel-stationary at the ends too — only tile content and the highlight
   change, with the last column always clear of the scrollbar thumb — and wheel or thumb drag
   scroll freely.

## Debug logging

Enable `imageCompare.debug` in settings, then read the webview dev console
(**Help > Toggle Developer Tools**) for `[IC-EXT]` and the Extension Host output for `[IC-MATCH]`:

```jsonc
// settings.json
"imageCompare.debug": true
```

`[IC-EXT]` traces watcher events, sweep results, and the handler error paths. `[IC-MATCH]` traces
matching: per-modality file counts, the elected reference, exact hits, then fuzzy candidates and
scores. To debug a mis-grouped comparison, read the final tuple summary and look for `MISSING:`
entries — those are the modalities that found no file for a row.
