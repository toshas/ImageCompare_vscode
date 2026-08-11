# Testing

What is pinned, what is not, and the one trap that makes a green run mean less than it looks.

This doc covers the Vitest unit suites in `test/unit/` that gate publishing. They are Layer 1 of the
multi-layer test system — Vitest unit layer, `@vscode/test-cli` integration layer, Playwright webview
layer, running in `.github/workflows/test.yml` on three OSes — documented in the repo-root
`TESTING.md`. The former `ts-node` suites in `src/test/` were ported here verbatim; there is one
runner now.

Every suite imports the real shipped module. Suites for `vscode`-free code (`sessionFile`,
`watcherLogic`, `workPool`, `ppmxParser`, `modalityVisibility`, `thumbPack`, `wireFormat`) need
nothing but Node; the rest (`tupleMatching`, `pngTextChunk`, …) reach `vscode`-importing code
through the `vscode` mock alias in `test/vitest.config.ts`. One caveat Vitest brings: suites are
transpiled by esbuild, **not type-checked** — no `tsc` config includes `test/`, so a type error in a
test file surfaces only if it changes runtime behaviour.

```bash
npm test                                                          # the whole unit layer
npx vitest run test/unit/workPool.test.ts --config test/vitest.config.ts   # one suite
```

`.github/workflows/publish.yml` runs `npm test` in its `test` job, which gates the whole build
matrix — a red test blocks publishing to both marketplaces.

## The suites

| Suite | Imports | Pins |
|---|---|---|
| `sessionFile` | real source | Path resolution, duplicate-path rejection, `labels`/`colors` validation, malformed JSON, `applyLabels()`, `suggestSessionFileName()` |
| `watcherLogic` | real source | `matchDeletedFile()` rename disambiguation (incl. the ambiguous-multi-delete no-hijack rule), `shiftIndexAfterRemoval()`, `modalityInsertIndex()` (caller order beats alphabetical on re-add) and `tupleInsertIndex()` (crop lands after its parent; natural row order) |
| `workPool` | real source | Concurrency cap (incl. the reject path), priority + FIFO/seq order, cancellation, re-entrancy, error propagation |
| `ppmxParser` | real source | All four magic x flags combinations, size-based flags detection, normalization, malformed input |
| `modalityVisibility` | real source | Hidden-pill keyboard cycling: skip, run-skip, non-wrapping edges, all-hidden stay; the tiny-tile mouse-vote guard threshold |
| `thumbPack` | real source | Packfile round-trip, uuid pairing rejection, truncation/overflow/duplicate rejection |
| `wireFormat` | real source | Image payload normalization: Buffer→plain Uint8Array (species-safe), offset views copied tight, structuredClone survival |

Two more suites sit in the same directory and import the real shipped code via the `vscode` mock
alias: `test/unit/tupleMatching.test.ts` pins trie matching end to end (crop
deprioritization, each tie-break in isolation, nested crops, matcher key order, the final row order
by tuple *name*, colliding tuple names de-duplicated, and unique modality naming including the
collided-tail fallback — the pipeline cases run the real `scanForImages` over temp directories), and
`test/unit/pngTextChunk.test.ts` pins the tEXt round-trip, the `x,y,w,h,srcW,srcH` crop format, PNG
structure survival, CRC-32 against the IEEE check value and a full-table probe, and a Sharp re-read
of an injected PNG (the one unit test that needs a working native Sharp).

## The copy trap (historical)

`tupleMatching.test.ts` used to contain **pure TypeScript copies** of the trie-matching functions,
because the originals live in `fileService.ts`, which imports `vscode` — and nothing kept the copy in
step with the original, so a green run proved only that the *algorithm as transcribed* behaved.
`pngTextChunk` was a copy once too, and that is exactly how a crop-breaking bug shipped: the real
`pngInjectText` called `zlib.crc32` (Node 20.15+) while `engines.vscode` allowed Node 18, so every
crop threw on older VSCode — while the suite stayed green, because its copy had its own `zlib.crc32`.
The copy era is over: both suites import the real
`matchTuplesWithTrie`/`scanForImages` and `pngText.ts` through the Vitest `vscode` mock alias, so they
cannot drift. For code that has no `vscode` import, the extraction pattern still holds —
`watcherLogic.ts`, `workPool.ts`, `sessionFile.ts`, `ppmxParser.ts`, `pngText.ts`, `thumbPack.ts`,
`wireFormat.ts` and `webview/modalityVisibility.ts` all exist because extracting a decision into a
pure module is what makes it testable at all. Never test a copy.

## A green suite is not evidence

`scripts/mutation-check.mjs` (a CI gate) flips a known rule in the real source file the suite
exercises — every suite is killed through `vitest run` (the trie mutations hit `fileService.ts`
and are killed by `test/unit/tupleMatching.test.ts`) — reruns that suite, and fails if it stays
green. **Run it to see what it covers** — it prints one
line per mutation, and that output *is* the list. Nothing here enumerates them: two attempts to do so
went stale within a day, the second while correcting the first. It exists because the tuple-matching suite once passed
with several of its rules deliberately broken. When you add a test, pin a value
from *outside* the implementation (a spec constant, a hand-computed expectation); code compared to
itself proves nothing.

## What nothing covers

- **The image backends.** Nothing tests Jimp or `sharpLoader.ts`, and nothing tests the fallback
  chain. `test/unit/pngTextChunk.test.ts` uses Sharp only to mint a fixture PNG and re-read it — that
  exercises Sharp incidentally, not the loader or the tiers. See the Testing section of `docs/image-backends.md` for
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

Failures here are invisible to CI, so they are worth walking before a release. Two former entries
are automated now and dropped from the walk: three-mode scanning/commands run in the headless
integration layer (`npm run test:integration`), and placeholder rendering plus the webview
interactions run in the Playwright layer (`npm run test:webview`) — both on every push via
`.github/workflows/test.yml`. What remains manual:

2. Rename detection — a quick delete+create must move the image, not drop the row.
4. A remote filesystem (SSH, WSL) or a FUSE/network mount, where the watchers do not fire and the
   existence sweep is the only detector.
5. In base-dir mode, add a modality directory while the comparison is open — both by `mkdir` then
   writing images into it, and by moving in a directory that is already populated. The column must
   appear without reopening. The base glob is non-recursive, so no event fires for the images inside
   it — the directory entry itself is the only event, and where neither watcher reports it the
   existence sweep is what picks it up, so allow a sweep interval before calling it a failure.
   Do this once with a custom pill order ([ ] rearrangement) and a non-first modality focused: the
   arrangement must survive, focus must stay put, and the new column must land beside its
   original-order neighbour (docs/tuple-matching.md: rearrangement-survives-insert applies).
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
