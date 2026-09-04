# Testing

What is pinned, what is not, and the one trap that makes a green run mean less than it looks.

The extension is two programs with different testability:

1. **Extension host** (Node): `fileService`, `thumbnailService`, `imageCompareProvider`, file
   watching, crop/PPTX/results I/O.
2. **Webview UI** (browser, **canvas-based**): `webview/main.ts`, `webview/crop.ts` — carousel,
   zoom/pan, crop, voting.

The canvas is opaque to DOM selectors, so the webview is tested through a **state hook**
(`window.__ic_test`) that exposes the UI's logic — zoom, pan, selected tuple/modality, crop rect,
winners — letting specs assert behavior without reading pixels. Every assertion is deterministic,
so the suite runs identically on any OS.

## The three layers

| Layer | Runner | What it covers | In CI |
|-------|--------|----------------|-------|
| **1 — Unit** | Vitest | Pure logic on the **real** exported code — tuple matching, PNG tEXt chunks, crop math, the work pool, watcher helpers | 3 OSes |
| **2 — Integration** | `@vscode/test-cli` (headless VSCode) | The real extension activating — directory scanning, commands, results.txt I/O on temp fixtures, and the entry types the **real** `workspace.fs` reports (a dangling symlink is `Unknown\|SymbolicLink`, never `File`) | 3 OSes |
| **3 — Webview** | Playwright (headless Chromium) | The real `dist/webview.js` in a harness, driven by canned messages; deterministic state-hook assertions | 3 OSes |

```bash
npm test                  # the whole unit layer (alias: test:unit)
npm run test:integration  # Layer 2 — headless VSCode
npm run test:webview      # Layer 3 — run `npm run compile` first
npm run test:all          # all three
npx vitest run test/unit/workPool.test.ts --config test/vitest.config.ts   # one suite
```

Layer 1 is the publish gate: `.github/workflows/publish.yml` runs `npm test` and
`scripts/mutation-check.mjs` in its `test` job, which gates the whole build matrix — a red test
blocks publishing to both marketplaces. On a `pull_request` that job (and `test-full`) is skipped,
because test.yml runs both on the PR already; the ten-leg build matrix runs anyway, and everything
that publishes is gated off by event
(`docs/image-backends.md: pull-request-builds-never-publish`). All three layers additionally run in
their own workflow (`.github/workflows/test.yml`) on **ubuntu / windows / macos** for every PR, and
for pushes to `main` or `test/**` — its push trigger is branch-limited, so pushing any other branch
starts no run at all, and an empty checks page must not be read as a green one. That proves
the per-OS risks on a real OS — Sharp's native binary, the file watcher, Windows path/CRLF
handling — not just mocked. There are no pixel snapshots and no committed baselines, so every job
is deterministic and nothing has to be run or refreshed by hand.

Every unit suite imports the real shipped module. Suites for `vscode`-free code (`sessionFile`,
`watcherLogic`, `workPool`, `ppmxParser`, `modalityVisibility`, `thumbPack`, `wireFormat`,
`thumbUrlCache`, `resultsFile`, `cropPlan`, `pptxDeck`) need
nothing but Node; the rest (`tupleMatching`, `pngTextChunk`, …) reach `vscode`-importing code
through the `vscode` mock alias in `test/vitest.config.ts`. Vitest transpiles with esbuild and
type-checks nothing itself; `tsconfig.test.json` closes that gap — `npx tsc --noEmit -p
tsconfig.test.json` runs in the CI gates job and covers all of `test/` except `test/integration/`,
which `test:integration` type-checks through its own tsconfig.
`pngTextChunk`'s Sharp-validation test needs a working native Sharp (installed by `npm ci`).

### The webview is tested out of process

The webview only talks to the extension through `postMessage`. So Layer 3 runs the **whole UI in a
plain browser**: load the real bundle against a harness that stubs `acquireVsCodeApi` (capturing
outbound messages) and feeds inbound `init`/`thumbnail`/`image` messages from fixtures. No
Electron — deterministic and fast.

The harness HTML is generated from `src/webviewShell.ts` — the **same** styles+body the production
panel uses — so it can't drift from the real shell. The `window.__ic_test` hook is read-only and
inert unless the harness sets `__ic_test_enabled`.

### Layout

```
test/
  unit/            # Layer 1 (Vitest)
  mocks/           # the `vscode` mock alias (vscode.ts)
  fixtures/        # shared message/image fixtures
  integration/     # Layer 2 (@vscode/test-cli) + its tsconfig
  webview/         # Layer 3 (Playwright): specs + generated harness
  dashboard/       # feature-coverage dashboard (generated)
  demos/           # captioned demo gallery (generated)
  vitest.config.ts                     # Layer 1 config
  webview/playwright.config.ts         # Layer 3 config
.vscode-test.mjs                       # Layer 2 config (must sit by package.json)
```

The Vitest and Playwright configs live next to their tests (invoked via `--config`).
`.vscode-test.mjs` stays at the repo root because `@vscode/test-cli` reads the extension's
`package.json` from the config's own directory.

## The suites

| Suite | Imports | Pins |
|---|---|---|
| `sessionFile` | real source | Path resolution, duplicate-path rejection, `labels`/`colors` validation, malformed JSON, `applyLabels()`, `suggestSessionFileName()`, the version gate, `serializeSessionFile()` relative-path rule |
| `watcherLogic` | real source | `matchDeletedFile()` rename disambiguation (incl. the ambiguous-multi-delete no-hijack rule), `shiftIndexAfterRemoval()`, `modalityInsertIndex()` (caller order beats alphabetical on re-add) and `tupleInsertIndex()` (crop lands after its parent; natural row order) |
| `workPool` | real source | Concurrency cap (incl. the reject path), priority + FIFO/seq order, cancellation, re-entrancy, error propagation |
| `ppmxParser` | real source | All four magic x flags combinations, size-based flags detection, normalization, malformed input |
| `modalityVisibility` | real source | Hidden-pill keyboard cycling: skip, run-skip, non-wrapping edges, all-hidden stay; the tiny-tile mouse-vote guard threshold |
| `thumbPack` | real source | Packfile round-trip, uuid pairing rejection, truncation/overflow/duplicate rejection |
| `wireFormat` | real source | Image payload normalization: Buffer→plain Uint8Array (species-safe), offset views copied tight, structuredClone survival |
| `standaloneArtifact` | real source | The webview layer's build-once rule (`test/webview/standaloneArtifact.ts`) on synthetic trees: missing/stale/fresh, every input kind making the page stale, the shared-mtime tie counted as stale, `test/` and non-source files ignored, and the problem message naming the file and the command |
| `thumbUrlCache` | real source | Webview thumbnail-url ownership: the superseded url is revoked and the incoming one never is, the successor is adopted before the loser dies, the shared ✕ placeholder is stored but never revoked, delete/clear/re-key revoke exactly what they drop |
| `thumbnailWire` | real source | The `thumbnail` post path on the real provider: a pack-slice Buffer is copied tight (plain constructor, offset 0, exact length) before it reaches `postMessage`, sweep and on-demand paths alike |
| `resultsFile` | real source | `results.txt` format: byte-pinned header (committed literals, not self-comparison), serialize/parse round-trip, CRLF parsing, malformed-line skipping |
| `cropPlan` | real source | `_cropNN` naming: max across modality dirs (the partial-crop overwrite case), regex escaping, padding; rect scale: round-then-clamp order, negative/overflow edges |
| `arrivalPlan` | real source | Watcher/crop arrival placement: exact-basename regroup, free-slot tie-break, taken-slot → new tuple, ` (2)` uniquification, natural insert position, winner/current shifts, `tupleAdded`/`fileRestored` payloads |
| `cropRelRect` | real source | `toRelativeRect`: per-axis denominators (non-square source), round-trip with `scaleAndClampRect` |
| `winnersToNames` | real source | Winner indices → durable modality names; unresolvable winners dropped, never written |
| `removalPlan` | real source | Tuple-delete sequence: step order, emptied-modality indices pre-shifted for earlier splices, `tupleDeleted`→refresh→re-save transcript, re-save after every step, winner shifts and clamping |
| `pptxDeck` | real source | Deck build against a recorder pptx + stub io: slide counts, parent/crop pairing (a voted crop never ships without its parent), winner captions, `modalityOrder` slide order, callout-rect gating on crop metadata |
| `debugLog` | real source | The debug sink: disabled → the message thunk is never invoked and the channel stays empty; enabled → one `+<ms>ms [TAG] text` line in the "ImageCompare" channel; verbose gate; runtime config change both ways; channel disposed with the subscription; the byte/elapsed/tier/throughput formatters against hand-computed values |
| `thumbTierStats` | real source | Which cache tier answered `getThumbnail`, against a real cache directory: memory/pack/disk/generated attributed correctly, bytes recorded, and *nothing* counted while `imageCompare.debug` is off or after it is switched off mid-session |
| `thumbSharedWait` | real source | What a tier's `ms` means when N requests share one pack read (the read is slowed through the mock): the tiers report per-item work only, the shared read is counted once with the callers it blocked, and the sweep rollup prints both terms |
| `pollNoise` | real source | The existence poll's pool line: quiet cycles print once and then go silent, a busy pool prints every cycle even unchanged, and a cycle that finds a deletion still reports it |
| `rootReadoption` | real source | The reported repro on the real provider over a temp dir: `rm -rf` the mode-1 root, every per-file removal committed (scan empties in place), then the directory recreated — the `modalityAdded`/`tupleAdded` the webview needs are posted (and after the root's return edge, not before), every re-adopted dir is watched again, and a second sweep over the same tree adds nothing. The bed builds real `watchersByDir` records, because their absence is what keeps a released dir in `watchedDirs` and re-adopts through a route production does not have |
| `emptyNotice` | real source | The emptied comparison's terminal notice: silent while anything is drawable, speaking at zero rows *and* at zero columns (the two shapes the two detectors produce), the folder named only when the host established it is gone, and content winning over a still-flagged missing root — the recoverability rule in pure form |
| `contextMenuModel` | real source | The comparison's context menu: the extension's item set pinned against what the manifest used to contribute, the standalone's differing *only* by an item its `HostCapabilities` disclaim, the local/host split exact both ways, the toggle label following the hidden state, and the help text derived from the same model so it cannot promise a missing item |
| `noticeChannel` | real source | What a finished host action says: the wordings pinned against the strings the provider used to hand `showInformationMessage`/`showErrorMessage`, the reveal action offered only to a host that can reveal (with the text unchanged either way), and a failure toned `error` with no action |
| `axisScroll` | real source | The one rule every scrollable axis obeys: centring computed from hand-derived geometry, clamping at both ends and on a short axis, the pitch snap that makes consecutive items differ by exactly one pitch, and Alt — multiplying a linear scroll but *compounding* the zoom step (`1.03**5`, not `1 + 0.03*5`), which is the arithmetic that keeps "faster" meaning the same on every axis |
| `tupleLoadPlan` | real source | The webview's arrival policy: arrival requests only the on-screen modality, sibling order by display distance (rearranged order, hidden pills skipped as targets *and* steps, forward-first ties), cached slots dropped, nearest-two-vs-tail split |
| `parallelScan` | real source | The open scan's directory IO, with latency and entry order simulated in the `vscode` mock: all 11 modality dirs listed in one wave, the fan-out capped at 16, caller order preserved when the dirs finish slowest-first and across waves, and the serial loop's behaviours kept (image-less dirs omitted, per-directory natural sort, a listing failure still rejecting with the earliest failure in input order). Also: a scrambled 12-directory completion order carried through `buildInitPayload` — positional `modalityColors` and every dense tuple's slot→modality map, which is what a silent column reshuffle would move — and a slow directory in the middle finishing last |
| `tupleLoadScheduling` | real source | The same policy where it costs money — the real provider's message loop against the real pool: browsing six tuples leaves only the current one queued, a cancelled load never reaches the filesystem, `tail` requests queue in their own class, the sweep keeps every speculative slot, dispose leaves nothing queued |
| `openRollup` | real source | The open-path rollup: the pure formatter's spans against hand-computed marks, the real provider emitting exactly one `[IC-OPEN]` line ahead of the sweep, where each mark is *taken* (burnt wall time must surface in `other`, never in a neighbour), what debug costs when off (the init payload is handed to `JSON.stringify` exactly once with debug on and never with it off, measured on a real open), and the handle census — node's own resource list shows the three `fs.watch` handles an open creates gone after the close, and every 10 s poll interval it started cleared |

Two more suites sit in the same directory and import the real shipped code via the `vscode` mock
alias: `test/unit/tupleMatching.test.ts` pins trie matching end to end (crop
deprioritization, each tie-break in isolation, nested crops, matcher key order, the final row order
by tuple *name*, colliding tuple names de-duplicated, and unique modality naming including the
collided-tail fallback — the pipeline cases run the real `scanForImages` over temp directories), and
`test/unit/pngTextChunk.test.ts` pins the tEXt round-trip, the `x,y,w,h,srcW,srcH` crop format, PNG
structure survival, CRC-32 against the IEEE check value and a full-table probe, and a Sharp re-read
of an injected PNG (the one unit test that needs a working native Sharp).

Two Layer 3 specs cover the affordance surface the webview took over from the host
(`docs/standalone.md: affordances-rendered-by-the-webview`): `test/webview/context-menu.spec.ts`
drives the real bundle — the menu opens on the image and on a pill, `contextmenu` is
default-prevented so no browser menu can appear behind it, Hide Modality reaches the state whose only
trigger used to be a VS Code command, a local item never posts and a host item always does, Escape
dismisses without also resetting the zoom, and the help modal names only what the host offers — and
`test/webview/notice.spec.ts` drives the notice channel end to end, including the reveal action's
`revealPath` post and a finished export announcing itself from the `pptxComplete` both hosts already
send. The standalone half is asserted against the *real built artifact* in
`test/webview/standalone-build.spec.ts` ("standalone context menu"), which is the only layer that can
see the browser's own menu being suppressed in the shipped page.

One webview-layer spec covers a whole product rather than one behavior:
`test/webview/standalone-build.spec.ts` serves `dist/standalone/image_compare.html` (built once per
run by the Playwright `globalSetup`, see "The standalone artifact" below) over localhost (OPFS needs
a secure context), fabricates a real modality tree in OPFS in-page, boots the adapter through
`window.__ic_standalone.open()`, and pins the tuple/modality literals the real matcher produces plus
a byte-for-byte `results.txt` round trip against the real `serializeResults`. The same file pins
the standalone poll (external add/delete/change and `results.txt` edits landing as granular
messages with view state intact, plus the two-root switch producing no stale posts, driven by a
short injected `pollIntervalMs`) and the no-FSA drag-drop walker via the `openDroppedEntry` seam —
see `docs/standalone.md` and `docs/file-watching.md`, "The standalone poll".

Three of its poll specs exist because the obvious fixture cannot fail. `standalone poll re-verifies a
removal with stat before reporting it` boots the adapter on a **lying directory handle** (the
`wrapListing` option of `bootPolledFixture`: names in `window.__ic_hidden` are skipped by every
`entries()` listing while `getFileHandle` still returns them), because a real OPFS removal is
genuinely gone — with genuinely-gone removals, deleting the poll's `stat` re-verification changes no
outcome and every other spec stays green. `standalone re-open stops the old root poll timer and
observer` counts **live pollers** (page-level `setInterval`/`clearInterval` wrappers keyed on the
injected interval, plus a stub `FileSystemObserver` counting constructions against disconnects),
because the adapter's `state !== s` guards silence a leaked timer or observer without stopping it:
the no-stale-posts spec beside it passes with the whole `stopPolling` call removed from `openRoot`.
`standalone poll orders a same-cycle dir rename remove-then-adopt within one cycle` **holds the poll
timer** rather than racing it: an init script captures the interval the adapter arms at a sentinel
`pollIntervalMs` (every other `setInterval` passes through) and removes `FileSystemObserver`, so the
only trigger left is the spec calling that callback by hand — once, after both halves of the rename
are already on disk. The rename spec beside it mutates a live fixture under a 150 ms poll, so the
removal and the adoption routinely land in *different* cycles, and a two-cycle split emits
modalityRemoved-then-modalityAdded whatever the block order inside a cycle is. Measured with
adoption moved ahead of the removals in `runPollCycle`, `--workers=4`, 20 runs each — and quote the
invocation shape with the number, because it moves the escape rate threefold: the racing spec caught
the reorder **14 of 20** whole-suite, 14 of 20 running only the two rename specs, and 18 of 20 under
`--repeat-each=20`. So it escapes 10-30% of the time, not the 1-in-6 first reported. The held-timer
spec failed 20 of 20 in every shape, and is 20 of 20 green with the adapter restored.

### The standalone artifact is built once per run, and freshness is checked, not assumed

The build lives in `test/webview/global-setup.ts` — the Playwright main process, before any worker
exists — not in the spec's `beforeAll`. It used to be in `beforeAll`, and with `fullyParallel` every
worker that picked up a test from that file ran its own `scripts/build-standalone.mjs` over the
**same** output path: instrumented at `--workers=4` (an `fs.writeFileSync`/`readFileSync` spy
preloaded into every node process of the run), four separate builds wrote
`dist/standalone/image_compare.html` inside the same half-second while four workers read it — 273 ms
apart in one run, 434 ms in the next, with a worker's read starting 12 ms after another build's write
finished. Nothing had failed in 40+ runs — which is the profile of a
flake that bites first on a slow CI runner, and this suite gates three OSes.

Moving the build is only safe if "already built" stays an honest question, so
`test/webview/standaloneArtifact.ts` owns one rule and both callers use it: `globalSetup` builds
**iff** the artifact is not fresh, and the spec's `beforeAll` asserts the same predicate and
never builds — an `existsSync` would serve a month-old page happily. Stale means *some build input
has an mtime at least as new as the artifact*: `scripts/build-standalone.mjs`, `tsconfig.standalone.json`,
`package.json` (the version is injected into the page), the inlined `dist/webview.js`, and every
`.ts` under `src/` and `.ts`/`.mjs` under `standalone/`. A tie counts as stale — a build reads its
inputs before it writes, so an input sharing the artifact's mtime was edited after it; the cost is
one redundant build, never a stale page. `test/` is deliberately not an input: editing a spec
changes nothing about the page.

An mtime alone is not enough, because the worst artifact on disk is also the newest one. A build
killed mid-write (Ctrl-C, ENOSPC, an EIO on a network mount, the OOM killer) leaves a truncated or
**zero-byte** page stamped *now* — newer than every input, so a pure mtime rule calls it current
and every worker serves it. Measured: the page is written with a single `writeFileSync`, which
truncates before it writes, and a syscall-level probe of a parallel run saw 12 of 3366 reads come
back short or empty (0.36%). That page then fails the specs deep inside the adapter
(`Cannot set properties of undefined`), pointing the developer at `standalone/` instead of at the
artifact, and — before the build moved out of `beforeAll`, where it ran unconditionally — it used to
heal itself on the next run; under a conditional build it is sticky forever, because no input mtime
ever moves again.

So the rule checks completeness first: the artifact's last 64 bytes must contain `</html>`, the
page's closing tag (`standalone/compose.mjs` ends the template with it and nothing else follows, and
it occurs exactly once in the built page). Anything else — zero bytes, a prefix, an unreadable file —
is `corrupt`, which `globalSetup` rebuilds and the spec reports **by name**. The sentinel is
structural, not semantic, and that is the point: a *content* marker such as the `__ic_standalone`
boot seam could legitimately be renamed by a future build, and then every run would rebuild and
still call the result corrupt — a permanent false alarm. An HTML
document that stops ending in `</html>` is not a legitimately-changed build; it is a truncated file.
A length threshold was rejected for the opposite reason: it is arbitrary, and it passes any
truncation that happens to be long enough.

The same fail-closed default applies to the inputs. A directory that cannot be listed, or an input
set that comes back empty, is not evidence that the artifact is current — both report
`unverifiable`, which rebuilds and reports, rather than the `fresh` that a swallowed `readdirSync`
error used to produce.

A build that *fails* is caught but not fatal: `globalSetup` reports it and continues, so the specs
that serve the page fail on their own assertion (naming the stale, missing or corrupt artifact) while
the rest of Layer 3 still runs — the blast radius each spec had when it built the page itself.
Throwing from `globalSetup` would abort the whole webview run over a broken `standalone/`. The
completeness check is what keeps that policy honest: a build that dies *during* its write both
leaves a corrupt artifact and stamps it fresh, so without it the `FAILED` banner would be followed
by misleading in-page failures instead of the actionable message.

What the rule does **not** catch: an input restored with an older timestamp (`tar -x`, `rsync -t`;
`git checkout` stamps now, so it is caught), a dependency change under `node_modules` (an esbuild
upgrade), and a `dist/webview.js` that is itself stale with respect to `src/` — the standalone build
inlines whatever bundle is on disk and only compiles when it is *missing*, so `npm run compile`
before the webview layer remains the developer's job exactly as it was before. The conditional is
also what keeps a single-spec run cheap: a developer running `-g` something pays an mtime scan of
`src/` + `standalone/` (milliseconds) instead of a build.

It does **not** always avoid the build in the canonical `npm test && npm run test:webview` loop, and
the earlier claim that it did was wrong. `test/unit/mutationHarness.test.ts` restores
`src/wireFormat.ts` in the *working tree* with byte-identical content (that is how it proves the
manifest catches a poisoned tree), which leaves `git status src/` clean but bumps the file's mtime —
measured: same md5, mtime one minute later. So `npm test` alone makes the artifact stale and the
webview layer pays one ~1.7 s build. Restoring the mtime with `utimesSync` would remove it, but it
belongs in that spec's restore path, not in `scripts/mutation-check.mjs` (the harness only ever
writes inside its sandbox copy), and one redundant build is not worth complicating a restore path
whose correctness is what keeps mutations out of the working tree.

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

**The harness never writes the working tree.** It copies `src/`, `standalone/`, `test/`,
`package.json` and the
tsconfigs into an `imagecompare-mutation-*` sandbox under the OS temp dir, mirrors `node_modules`
entry by entry as symlinks (so the sandbox gets its own empty Vite cache rather than sharing the
repo's), runs every suite with the sandbox as cwd, and deletes it on the way out. Mutating in place
cost a whole benchmark run once: an interrupt that was neither `SIGINT` nor `SIGTERM` left
`this.down = -1` in `src/thumbnailPlan.ts` and every later build served it. `SIGHUP`, `SIGQUIT`, an
uncaught exception, an unhandled rejection and the exit hook now all restore, verify a SHA-256
manifest of every file the run touched, and drop the sandbox; `SIGKILL` and OOM cannot be handled at
all, which is the point of the copy — what they leave behind is a stale temp dir, not stale source.
The manifest separates the two changes it can see: a working-tree file that turned into *this run's*
mutation is a poisoning and fails the run by name, while any other change is someone editing during
the run and is only noted, so an edit landing mid-run neither breaks the run nor is broken by it.
A restore that cannot happen — the sandbox reaped or `rm -rf`'d out from under a live run — prints
`COULD NOT RESTORE <path>` and what to do about it, and forces a non-zero exit; it used to throw
*inside* the crash handler, which node answers with a bare double stack and exit 7 at exactly the
moment someone is reading the log.

`test/unit/mutationHarness.test.ts` drives the real script and signals it for each of those exits.
It narrows the run through the `MUTATION_CHECK_TEST` env seam (JSON: `only` or `mutations`,
`pauseMs`, `throwAfterApply`, `rejectAfterApply`), which is unset in every real run — with it unset
the script takes exactly the path CI gates, the whole mutation list.

**Only a full run can exit 0.** A seam-narrowed run opens with a `SUBSET RUN - NOT THE GATE` banner,
closes with a `NOT A GATE - subset run: N of <total>` trailer instead of the all-killed line, and exits
**2** — never 0, and never 1 either, which stays reserved for a genuine survivor/error/manifest
failure so the spec can still tell a healthy subset from a broken one. Exit 0 is the only status
automation reads: a banner is invisible to `&&`, to `set -e` and to a green CI step, so a subset that
exited 0 would be indistinguishable from the gate that guards publishing to both marketplaces. The
seam cannot be refused outright when `CI` is set — the spec runs under `npm test`, which runs in CI,
and needs it. The harness is also the one script no mutation can cover (mutations edit `src/` inside
a sandbox that does not even contain `scripts/`), so its specs are proven by hand-breaking instead:
each handler prints its own name, so deleting the `unhandledRejection` hook — which node then routes
to `uncaughtException` for the same exit code and the same restore — still fails a test.

## Adding a feature, fix, or test — the one workflow

Every change lands the same way, so it can't silently regress:

1. **Formalize** the report — symptom → repro → expected vs actual → suspected component → which layer.
2. **Write the failing test first (RED)** at the lowest layer that reproduces it (unit →
   integration → webview). Import the **real** function (`export` it if needed); assert webview
   state via `window.__ic_test`'s `getState()`. For a known-but-unfixed bug, pin it with
   `it.fails(...)` so it flips to a hard failure once fixed.
3. **Fix (GREEN)** — smallest change; re-run the layer, then `npm run test:all`.
4. **Document** — one line in *Findings* below; update `CLAUDE.md` or the relevant `docs/` file if
   architecture changed; map the feature in `test/dashboard/features.json` (CLAUDE.md → "Growing
   the dashboard").
5. **CI guards it** — all three layers run on ubuntu/windows/macos for every PR (and every `main`
   push). No local step and no per-OS baselines: every assertion is deterministic.

This is automated by the **`fix-issue` agent skill** (`skills/fix-issue/`, symlinked into
`.claude/skills/`): give it a bug description in prose and it produces the issue, the failing test,
the fix, the docs, and the CI check.

## What nothing covers

- **A real wasm32 decode.** The tiers themselves are covered now — `test/unit/sharpLoaderTiers.test.ts`
  pins the loader's decision (native blocked, wasm32 exempt, resolver restored, null rather than a
  throw) and `test/unit/jimpFallback.test.ts` drives the real `ThumbnailService` onto the real Jimp —
  but no suite ever *decodes* through WASM, because `@img/sharp-wasm32` declares `cpu: ["wasm32"]` and
  no test-layer install has it (only `publish.yml`'s runners do, by hand-extracting the tarball). It is checked by hand against a tree built the way `publish.yml`
  builds the universal target; see the Testing section of `docs/image-backends.md`. `test/unit/pngTextChunk.test.ts` uses Sharp only to
  mint a fixture PNG and re-read it — that exercises Sharp incidentally, not the loader or the tiers.
- **The three scroll axes' wiring, by mutation.** `test/webview/axis-scroll.spec.ts` pins which
  events centre the selection and which must not — the wiring lives in `webview/main.ts`, so no
  Vitest mutation can reach it. The *rule* is mutation-covered in `test/unit/axisScroll.test.ts`;
  what stands in for the wiring is that six of the seven *tests* were watched failing against the
  pre-change bundle, and the seventh — the digit-jump/pill-click one — was strengthened after that
  run showed it passing **vacuously**: containment of the active pill is satisfied trivially by a
  wrapped row, whose `scrollLeft` is pinned at 0. It now also asserts the strip *moved*, away from an
  extreme the selection is not at, and fails pre-change too.
- **The menu's and the notice's DOM rules, by mutation.** `test/webview/context-menu.spec.ts` and
  `test/webview/notice.spec.ts` pin rules that live in `webview/main.ts` and
  `webview/contextMenu.ts` — keys must not act behind an open menu (Del there is a permanent file
  delete), the menu must close when the host re-indexes slots under its frozen target, and a faded
  action toast must stop taking clicks. The harness runs Vitest suites only, so no mutation can
  reach any of them. What stands in: each was verified by reverting its fix and watching the spec go
  red. The *model* half — item sets, capability gating, wording, tone — is mutation-covered in
  `test/unit/contextMenuModel.test.ts` and `test/unit/noticeChannel.test.ts`.
- **VS Code's own webview context menu staying suppressed.** The comparison renders its own menu and
  cancels the `contextmenu` event, which works because VS Code's webview preamble skips an event it
  finds already default-prevented (`docs/standalone.md: affordances-rendered-by-the-webview`). No
  layer can see that: Layer 1 has no DOM, Layer 3 runs plain Chromium where our handler is the only
  one, and Layer 2 has no webview panel. Layer 3 pins everything on *our* side — the event is
  default-prevented and our menu opens, in the harness and in the real standalone artifact — so what
  is untested is precisely VS Code's half of the contract. It is walked by hand (Manual checks) and
  would show up as VS Code's default menu appearing over ours in the panel. The extension's serving
  half (`handleMenuAction`, `resolveMenuTarget`, `revealPath`, `postNotice`) is likewise uncovered,
  for the same reason the rest of the provider is; its standalone twin is covered against the real
  artifact.
- **Most of `imageCompareProvider.ts`** (the largest file). The integration layer covers
  activation, command registration, real-fs scanning, results.txt I/O, and the real API's entry
  types (the dangling-symlink premise every `type & FileType.File` gate rests on), but the provider's
  message loop, watcher wiring, and PPTX export run untested — only their pure helpers
  (`watcherLogic`, `workPool`, `pngText`, …) are extracted and pinned. Prefer that shape for new
  logic. **No mutation covers that entry-type case**: it is pinned only by the integration layer,
  which the mutation harness cannot run (it is Vitest-only), so its premise was confirmed by hand
  against the shipped VS Code source instead. What stands in for a mutation on the code side: the
  rule the premise protects — the `type & FileType.File` gate in `listImagesIn` — stays covered by
  the `symlink: broken link accepted` mutation.
- **The standalone poll's snapshot pruning.** `runPollCycle` ends by dropping `s.snapshots` entries
  whose modality column is gone. Nothing pins that block and nothing at the wire level can: the
  cycle that removes a column has already overwritten that dir's snapshot with `[]` (an unlistable
  dir yields an empty listing), the only read of a snapshot is `s.snapshots.get(dir)` for a *live*
  modality, and the only way a dir becomes live again is adoption — which re-seeds that same entry
  before any cycle reads it. Deleting the block outright leaves all 62 webview specs green (checked,
  not assumed). What remains is memory hygiene plus an early-race guard, observable only through a
  new production seam (a snapshot-census hook on `__ic_standalone`) — a bigger change than the five
  lines it would guard. Accepted as untested rather than closed with a test that cannot fail.
- **`pruneOldSessions` in `extension.ts`.** The 30-day generated-session prune is module-private and
  its only caller is the deferred 15s timer inside `activate`. A Layer 2 route does exist — activation
  is lazy, and the sessions dir is discoverable through `TabInputCustom`'s uri, so a test could seed
  an old session there and wait the timer out — but it is order-fragile (any earlier test that
  activates burns the window) and costs 16s of wall clock, so it is unattractive rather than
  impossible. Calling `activate` directly is what would break the activation test beside it. Its `type & FileType.File` gate is therefore the one `FileType` site in
  `src/` with no test of any kind (docs/tuple-matching.md: entry-type-is-a-bitmask) — the sibling
  sweep in `thumbnailService.cleanupOldCache` is pinned at Layer 1 (with a mutation) and Layer 2.
  Pinning it needs the function exported, which is a production change, not a test one.
- **The webview's pixels.** The Playwright layer drives the real bundle but asserts logic through
  the state hook — no pixel snapshots — so canvas rendering and visual layout are verified by eye
  (the demo gallery and the manual checks below).
- **Packaging.** One CI step scans the VSIX for the wasm32 tier (`docs/image-backends.md`), which
  transitively pins two entries of the `.vscodeignore` un-ignore list (`@img`, `@emnapi`). Nothing
  checks the rest of it — `sharp` itself, `detect-libc`, `semver` — whose failure mode is identical
  and silent.

## Findings (caught by this testbed)

- **Three platform targets were never published, and VS Code blamed the engine range** *(fixed)* —
  a remote-session install failed with *"not compatible with the current version of Visual Studio
  Code (version 1.135.0)"* against `engines.vscode: ^1.85.0`, which accepts it. The message is VS
  Code's own and names the wrong cause: the real condition is *no published target matches this
  host*, and VS Code matches the **server's** platform, so a Linux remote decides it. Six of nine
  targets were built — `alpine-x64`, `alpine-arm64` and `linux-armhf` were not — and nothing in the
  repo could see that, because a platform target is a line in a workflow matrix that no suite read.
  This one was **not** caught by the testbed; it was caught by a user, and the testbed's answer is
  `test/unit/publishTargets.test.ts`: the matrix must carry all nine targets plus the universal
  build, `--libc` must actually reach npm (musl and glibc are both `--os=linux`), and every matrix
  target must have an entry in the artifact scan's expectation table. The flag is *not* sufficient,
  which review caught before the first alpine leg ran: `package-lock.json` carries no `libc` for
  `@img/sharp-*`, so a lockfile-driven install restores the glibc tier beside the musl one and the
  artifact scan would have failed the leg — hence the prune the suite now also pins
  (`docs/image-backends.md: one-native-tier-per-target`). Eight mutations, each surviving without that
  suite. The same round covered the
  two fallback tiers underneath, which had no tests at all while a whole platform target was about
  to rest on them. (`docs/image-backends.md: all-platform-targets-built`, `universal-has-no-native`)

- **The ten-leg build first ran at tag time** *(fixed)* — `publish.yml` triggered only on `v*` tags,
  so the per-target Sharp install, the libvips prune and the packed-VSIX scan were first exercised at
  the one irreversible step; both findings above are what that costs. `pull_request` now runs the same
  build job and the `codium-smoke` install check, and nothing on that path can publish. The suite's
  answer is in `test/unit/publishTargets.test.ts`, which reads the workflow as a document (js-yaml, an
  explicit devDependency) and evaluates the real `if:` expressions under a model of Actions' own
  semantics — implicit `success()` included — rather than asserting their wording, so an equivalent
  rewrite passes and a weakening does not. Twelve mutations: all twelve killed with those cases
  present, eleven of them surviving once the cases are removed — the twelfth mutates the semantic
  model itself, which goes with them. (`docs/image-backends.md: pull-request-builds-never-publish`)

- **The artifact scan passed the very VSIX that shipped the defect** *(fixed, same round)* — the
  scan added above was a per-target *deny*-list naming strays for four of the ten legs. The other
  six were checked only for the presence of their own binary, so anything extra rode along. Packaging
  a `linux-arm64` VSIX with the pre-change recipe reproduced the shipped 0.4.0 artifact — four
  libvips tiers, 36,092,593 bytes — and the scan printed `OK` and exited 0. The lesson is the one the copy-trap
  section already makes: a check written per-case is only as good as its case list, and reading it is
  not testing it. It is now one rule every leg is held to (the packed `@img` set must equal `colour`
  + this target's own pair + `sharp-wasm32`), and the suite no longer pins the scan's *text* — it
  extracts the real `node -e` program from the workflow and runs it against synthetic VSIX zips whose
  entry names are the measured shapes, so the shipped four-tier artifact is a red test. Writing it
  also found a second defect the text-pinning could never have: an apostrophe in the scan's own
  comment ended the `node -e '...'` shell string, and the step died with a bash syntax error instead
  of checking anything. That is pinned too — and so, since a quote count is only a proxy for it, is the
  property that actually matters: one case takes the step's `run:` body verbatim and executes it under
  the shell Actions uses (`bash --noprofile --norc -eo pipefail`), asserting exit 0 for a conforming
  VSIX and exactly 1 for a stray-carrying one. Exactly, because bash's own exit 2 for a step that never
  parsed is otherwise indistinguishable from the check firing — which is the shape both defects took.

- **Only a mouse re-aimed the sweep; the keyboard never did** *(fixed)* — reported from the field:
  after clicking a carousel tile the sweep kept filling that column while the arrows, the digits and
  `[` / `]` moved the view elsewhere. The click path posted `setCurrentModality`, and no keyboard
  route posted anything at all — so the column half of the aim was frozen at whatever the last click
  (or the last `tupleFullyLoaded`, a whole cold tuple away) had said. The *row* half was never
  broken: `ArrowUp`/`ArrowDown` post `setCurrentTuple`, which the trailing-edge dwell has always
  settled, so what looks like a stuck row is that dwell working as designed — no test was written for
  a bug that was not there. The reason the keyboard had been left out was churn, and the measurement
  is what settled where to answer it: driven through both real hosts, **eleven reports buy eleven
  re-aims** (each drops the sweep's queued dispatches), so a report per keystroke would have been the
  thrash `sweep-centre-dwells` exists to prevent. The gate therefore sits in the webview, which is
  the only place that can tell a settled pick from a burst, and is pure so it can be pinned:
  `ColumnReportGate` (`src/webview/tupleLoadPlan.ts`) reports a click at once and a key on the
  navigation debounce — **ten held repeats are one report** (`test/webview/tuple-load.spec.ts`
  counts them off the real bundle; `test/unit/tupleLoadPlan.test.ts` pins the gate on a fake clock,
  `test/unit/sweepHostEquivalence.test.ts` pins the churn and the latest-report-wins rule in both
  products), with four mutations in `scripts/mutation-check.mjs`
  (docs/loading-architecture.md: picked-column-reports-itself).

- **The poll's dir grouping silently degraded to per-file on Windows — and the fs.watch backup never
  armed there at all** *(fixed)* — `watchedDirs`, `watchersByDir` and the sweep's per-directory
  grouping are keyed in URI-path space (`/C:/data/exp1/GT`); node's `fs` takes filesystem paths. On
  POSIX the two are the same string, so the whole layer of tests above could not see the difference,
  and `test/unit/crossPlatform.test.ts` — the one suite that feeds Windows-shaped input on purpose —
  covered only naming and matching, never the watcher or the sweep. Two consequences, both shipped:
  `fs.watch` was handed the URI path, which on Windows resolves `/C:/…` to `C:` as a *path component*
  NTFS cannot hold, so the call threw for every watched dir, was swallowed by its own `catch`, and no
  release ever had the delete backup on Windows (`test/unit/openRollup.test.ts`'s handle census read
  0 there and 3 everywhere else — the same bug from the other end); and `test/unit/pollCost.test.ts`
  hand-built `watchedDirs` from `path.join`, so on Windows every tracked file missed the lookup and
  became a *stray*, putting the sweep back on one existence check per file — 29 tasks where 4 were
  expected, the 7407-task flood that suite exists to forbid, reported as a bed defect rather than a
  product one. `crossPlatform.test.ts` now drives the real `watchDirectory` and the real
  `runDeleteSweep` with Windows-shaped URIs from a POSIX runner and pins what node is handed, what
  URI a reported delete carries (built from the tracked key, never re-parsed from `fsPath`, which
  lowercases the drive letter), and that a cycle still costs one pooled task per directory; three
  mutations, each surviving without those tests. `test/mocks/vscode.ts`'s `fsPath` now lowercases the
  drive letter as vscode-uri does, so the round-trip is visibly not the identity on a POSIX runner.
  What is **not** mutation-covered: the three `watchedDirs` producers themselves. On Linux
  `uri.fsPath === uri.path` for every path a test can create, so a producer drifting into filesystem
  space is a no-op here, so no mutation of *those producers* bites on a POSIX runner (synthetic
  `/C:/` state is constructible at Layer 1 — the consumers are pinned that way); the invariant citation
  (`docs/file-watching.md: watched-dirs-are-uri-paths`) at each of the three sites and the consumer
  tests above are what stand in for it. Also **not** covered: UNC. Real vscode carries a `\\server\share`
  tree's server in the URI's *authority*, which `watchedDirs` (built from `uri.path`) never holds and
  the mock's `Uri` has no field for, so no assertion here could speak to it; the gap is wider than
  this fix — `Uri.file(dir).with({ scheme })` drops the authority for the VS Code watcher's
  `RelativePattern` too — and is left open with this reason rather than closed with a test that cannot
  fail. (`docs/file-watching.md: watched-dirs-are-uri-paths`)

- **A `node:fs` existence probe that answers differently on Windows — the second one this session**
  *(fixed)* — the sweep asked `fs.promises.access` whether a deletion candidate was still there, twice
  (the check and the re-verification), and the `fs.watch` delete backup asked it the same question. On
  Windows that call reports the attributes of a *symbolic link itself*, so a tracked file replaced by a
  dangling link reads as **present**: the sweep returned early and never reported the deletion, and the
  backup routed a vanished file into the *arrival* branch. `test/unit/pollCost.test.ts`'s C3b — a real
  dangling symlink, whose name a listing still returns — was the witness, green on POSIX and red on
  Windows CI, because POSIX rejects `access` and `stat` alike for such a link and **no filesystem a
  Linux runner can build distinguishes the two calls**. Fixed by probing with `stat` at all three sites
  (docs/file-watching.md: existence-probes-follow-the-link); the standalone poll had always
  re-verified with `stat`, so this was also a divergence between the two products.
  The durable lesson is the *class*, not the call: this is the **second** time in one session that a
  `node:fs` API was handed something a POSIX runner cannot judge — the first was `fs.watch` given a URI
  path (the finding above), which threw on Windows only. Both were invisible to every green suite for
  the same reason, and both were closed the same way: **fake the platform's verdict at the `node:fs`
  seam, never the filesystem**. `vi.mock('node:fs', …)` replacing exactly one function — `watch` there,
  `promises.access` here, and here only for paths a test lists as lying — leaves the real symlink, the
  real listing and the real provider in play. Without that stub the mutations below are no-ops on Linux
  and would survive; with it they are killed. Three mutations in `scripts/mutation-check.mjs`, one per
  probe, each verified SURVIVING with the two new tests reverted. When a `node:fs` call's *contract*
  differs across platforms, assume the POSIX runner cannot see it and stub the seam.

- **One message, two consumers with opposite latency needs: the sweep chased a held key** *(fixed)* —
  `setCurrentTuple` is posted ungated on every navigation so `cancelImageLoads` can kill stale
  full-image loads at once, and the open-time sweep took its centre from the same field. Holding Down
  over a cold 315x10 grid therefore re-aimed the sweep on every completed thumbnail, landing tiles at
  rows the cursor had already passed. The sweep now reads a trailing-edge dwelled copy
  (`the shared aim policy`, `LOAD_DEBOUNCE_MS`) while the cancellation keeps the raw signal;
  `test/unit/sweepCentreDwell.test.ts` drives a real key-repeat burst on the real provider under fake
  timers and pins one re-aim after it, per-keystroke cancellation during it, and no timer left behind
  by a dispose mid-burst, with two mutations (dwell removed, dwell made leading-edge).

- **The fix above shipped to one product only** *(fixed)* — the sweep takes its aim as an injected
  callback and each host built one by hand, so the dwell landed in `imageCompareProvider.ts` and the
  standalone adapter kept feeding the raw index. The aim is now `src/sweepAimPolicy.ts`, shared:
  hosts forward raw reports and supply `setTimeout`/`clearTimeout`, nothing else.
  `test/unit/sweepAimPolicy.test.ts` pins the policy on a fake clock, and
  `test/unit/sweepHostEquivalence.test.ts` drives the *same* held-key burst through both **real**
  hosts — the real provider, and the real `standalone/adapter.ts` imported with the browser globals
  it needs stubbed and opened on a fake FSA handle — and requires the two traces to be identical and
  equal to the literal ff11b92 pinned. That suite is why the mutation sandbox now carries
  `standalone/` (the adapter can be mutated at last: two of the entries do exactly that, and nothing
  but this suite kills them). `scripts/check-sidedness.mjs` gained a third gate for the structural
  half — `POLICY_SEAMS`, a curated list of injected decisions, which fails when a host hand-builds
  one; verified by running it against the ff11b92 and 32f73a0 trees, where it names both hosts and
  quotes the offending line (`docs/standalone.md: host-supplies-data-not-policy`).

- **A clicked column never reached either host, so the sweep filled column 0** *(fixed)* — the aim's
  column travelled in `tupleFullyLoaded`, which the webview posts only once **every** modality of a
  tuple has arrived; a tuple arrival requests the on-screen column and its nearest siblings only, so
  on the field's 265x136 grid that report is a whole cold tuple away or never comes. Clicking a tile
  in the 5th column of an un-arrived row therefore changed nothing the extension could see, and the
  sweep kept filling the column it already had — the strip's first, which is the same fallback a host
  that reports nothing gets, and why the symptom reads as "always column 0". A carousel tile click
  now posts `setCurrentModality` (the strip, no claim about loading — `tupleFullyLoaded` also drives prefetch)
  and both hosts feed it to the same `noteStrip`. Both products reproduced it, since both read the
  same reports: the webview half is pinned in `test/webview/tuple-load.spec.ts` (a click on an
  uncached row reports the column, and reports it as a display position within the order it also
  sends, on a rearranged strip), the host half in `test/unit/sweepHostEquivalence.test.ts`, which
  requires the same clicked column out of both **real** hosts — with a mutation per host, each
  surviving without that assertion. The webview post itself has no mutation: the harness runs Vitest
  only, so Layer 3 stands in for it, exactly as it does for the reported `visibleRows` radius.

- **Two comparison tabs shared one FIFO, so the second one indexed nothing for a chunk** *(fixed)* —
  on the real pool and the real sweep runner, a second 746x10 tab joining a running sweep waited 28
  reads (8 batches, ~11 s at the field's cold cost) for its first slot and then took 12 % of the next
  32; the pool now rotates between per-panel groups (50 %), and a *hidden* tab's sweep pauses
  outright (0 reads over 20 batches, against 40 before). `test/unit/poolFairness.test.ts` and
  `test/unit/sweepHiddenPanel.test.ts`, with twelve mutations — including the two that hang rather
  than starve: a pause with nothing outstanding has no settle left to end the sweep, so the host's
  repump on dispose is the only exit, and a sweep paused at start must not take the empty-grid exit.

- **A test raced a deliberately unawaited cache write** *(fixed)* — `thumbTierStats`'s disk-tier test
  read the tier counter before `saveToDiskCache`'s fire-and-forget write had landed, so it failed 2 of
  15 full `npm test` runs under whole-suite IO contention (and deterministically with 25 ms injected
  into that write). The write stays unawaited — the caller must never block on a cache fill — and the
  test now waits for the per-entry `.jpg` before reading the tier, failing by name if it never lands.
  Green with 25 ms and 250 ms injected; still fails if a disk hit is attributed to any other tier.

- **Four Playwright workers raced one standalone build output** *(fixed, latent)* — the standalone
  spec built `dist/standalone/image_compare.html` in `beforeAll`, so at `--workers=4` four builds
  wrote the page other workers were serving (spied writes: 4 per invocation, 270 ms apart, a read 12 ms
  behind one). Built once in `globalSetup` now, gated by the mtime freshness rule in
  `test/webview/standaloneArtifact.ts` (1 write per invocation, all reads after it), pinned by
  `test/unit/standaloneArtifact.test.ts` and eight mutations. See "The standalone artifact" above.

- **A zero-byte artifact was the newest file on disk, so nothing rebuilt it** *(fixed)* — moving the
  build behind an mtime check turned a self-healing truncated page (the old `beforeAll` rebuilt
  unconditionally) into a permanently sticky one: `: > dist/standalone/image_compare.html` produced
  no rebuild on any later run and the specs failed inside the adapter instead. The freshness rule now
  requires the page's closing tag in its last bytes before it looks at any mtime, and fails closed on
  an input tree it cannot enumerate. See "The standalone artifact" above.

- **A slot invalidation left the payload already parked for that slot on the wire** *(fixed)* — the
  five slot-level invalidation paths (a delete when first seen and again when the rename window
  commits, a restore, a rename onto the slot, an in-place rewrite) deleted the `loadedImages` entry
  and nothing else, so a speculative payload parked behind a thumbnail sweep — minutes, on a real
  grid — still posted afterwards and painted an image for a slot whose file was gone; the burst hold
  had the same gap since before backpressure existed. Fixed by one funnel, `invalidateSlot`, that all
  of them (plus the `forceReload` retry) now go through
  (`docs/loading-architecture.md: slot-invalidation-clears-the-wire`). Pinned in
  `test/unit/transportLifetime.test.ts` in both directions — no ghost after an invalidation, and the
  park left alone when `evictDistantTuples` merely frees bytes for live slots — and by ten mutations.

- **The mutation harness poisoned the working tree** *(fixed)* — `scripts/mutation-check.mjs` wrote
  each mutation over the real source file and restored it in a `finally`. A `pkill -f mutation-check`
  whose pattern also matched the calling shell orphaned node, which then took `SIGHUP` — not one of
  the two handled signals — and `src/thumbnailPlan.ts` was left carrying `this.down = -1`, serving a
  whole benchmark run before anyone noticed. Fixed by mutating a temp-dir copy of the tree instead
  (a `SIGKILL` now leaves a stale sandbox, not stale source), plus restore handlers for `SIGHUP`,
  `SIGQUIT`, `uncaughtException`, `unhandledRejection` and `exit`, and a checksum manifest that fails
  the run naming any file that moved. Guarded by `test/unit/mutationHarness.test.ts`, which spawns the
  real harness and kills it mid-mutation with each of those signals.

- **A subset mutation run looked exactly like the gate** *(fixed)* — `MUTATION_CHECK_TEST` shrinks the
  run to any subset and exited 0 all the same, so "195 killed" in a log could not be told from "1
  killed" and every later claim to have run the gate was worth less. A subset now carries a banner and
  a trailer and exits 2. Found by review of the sandboxing change, not by a test; the same review found
  that the crash handlers' restore could throw (exit 7, raw stack) and that `unhandledRejection` was
  the one exit path with no test — both closed with `test/unit/mutationHarness.test.ts`.

- **Every tuple visited queued its whole tuple, and nothing ever cancelled it** *(fixed)* — found in
  the field, not by a test: a 746×10 panel sat six minutes at `run=[0,15,0,0,0,1,0]
  queued=[0,124,0,0,0,5842,1]` — 15 of 16 pool slots on `SIBLING` full-image loads of tuples the user
  had long left, one for the whole carousel sweep, 3.5 GB on the wire against ~4 thumbnails/s. Two
  causes, both invisible to the suites at the time: arrival requested *all* modalities, and only
  prefetch waves were keyed and cancellable. Fixed in `webview/tupleLoadPlan.ts` + `webview/main.ts`
  (arrival asks for the on-screen modality; the rest waits for a dwell navigation cancels, ordered by
  display distance, split nearest-two vs `SIBLING_TAIL`), `workPool.ts` (a class admitted only when
  nothing else is queued) and `imageCompareProvider.ts`/`standalone/adapter.ts` (per-tuple pool keys,
  cancelled on `setCurrentTuple` and on dispose). Guarded by `test/unit/tupleLoadPlan.test.ts`,
  `test/unit/tupleLoadScheduling.test.ts` (the real provider's queue, read through `WorkPool.stats()`),
  workPool Tests 18-19 and `test/webview/tuple-load.spec.ts` (the real bundle's outbound requests).

- **The same round then hid the flip it was supposed to serve** *(fixed)* — after the dwell had marked
  every slot, a modality flip onto a tail-ranked one posted nothing at all (the "already asked" guard
  was rank-blind), so the on-screen tile inherited `SIBLING_TAIL`'s admission rule and stayed a
  spinner until the sweep drained. Fixed by recording the rank of each outstanding request
  (`rankCovers` in `webview/tupleLoadPlan.ts`, `requestedSlots` as a map in `webview/main.ts`); guarded
  by the rank-upgrade cases in `test/unit/tupleLoadPlan.test.ts` and the post-dwell flip in
  `test/webview/tuple-load.spec.ts`.

- **Thumbnail cache: a stale thumbnail with no way back, and a pack that expired mid-use** *(fixed)* —
  the key was `sha256(uri + mtime + size)`, so an in-place overwrite that restored mtime and kept the
  byte count (`cp -p`, `rsync --times`, a training loop rewriting outputs) hit the cache forever and
  showed an image no longer on disk; and `cleanupOldCache` pruned by mtime, so the packfile a fully
  warm session was serving from aged out while in active use. Fixed in `thumbnailService.ts` (inode
  ctime in the key via `statForKey` — vscode's own `FileStat.ctime` is *birth* time and would have
  fixed nothing, which is why `test/mocks/vscode.ts` now reports birthtime; eviction of superseded
  keys; a two-`utimes` last-use stamp on the pack). Guarded by `test/unit/thumbCacheKeying.test.ts`
  and `test/unit/thumbCacheExpiry.test.ts` against real files and a real cache dir.

- **Thumbnail cache: a pack deleted under a live session was never put back** *(fixed)* — the stamp
  stops the sweep only if it lands first, and when a pack was deleted anyway a fully warm session
  marked nothing dirty, so the close published nothing and the *next* open was cold — Round 4's own
  goal, half met. Fixed in `thumbnailService.ts` (`packGone`: at a publish decision that would
  otherwise write nothing, a session that loaded a pack stats the pair and a missing half marks the
  cache dirty); guarded by the republish test in `test/unit/thumbCacheExpiry.test.ts`.

- **The debug channel overstated thumbnail work ~12× and never stopped talking when idle** *(fixed)* —
  both found in the field, in the log itself, on a remote-SSH session. (a) A warm 9×10 open reported
  `pack=83/385.1KB/8118ms` for a sweep that finished in **658 ms wall**: all 83 requests awaited the
  same in-flight `ensurePackLoaded()` promise and each charged the whole shared read to its own tier,
  so one ~600 ms NFS read printed as 8.1 s of "pack time" — the tier looked ~12× slower than it is,
  and `disk`/`generated` inherit the same wait. (b) With debug on, an idle window logged
  `[IC-EXT] pool active=0/16 run=[0,…] queued=[0,…]` every ~10 s forever, because the existence poll
  emitted its pool snapshot unconditionally. Fixed in `thumbnailService.ts` (each waiter subtracts its
  own shared wait; the read is measured once where it happens and reported as
  `packLoad=1x612ms/1.4MB blocked=83/8118ms`) and in `pollPlan.ts`/`imageCompareProvider.ts` (the
  snapshot prints on change or on a busy pool). Guarded by `test/unit/thumbSharedWait.test.ts` (real
  service and real sweep, with the pack read slowed through the mock so the shared load is an
  external number) and `test/unit/pollNoise.test.ts` (three quiet cycles leave one line; a busy pool
  still prints every cycle even unchanged; a cycle that finds a deletion still reports it).
- **Transport backpressure: three ways the sweep's wire claim could outlive the sweep, and a park
  nobody re-indexed** *(fixed)* — the sweep flag was raised outside any guard (a synchronous throw
  out of `runThumbnailSweep`'s prologue skipped the `.finally`), had no stall watchdog (one hung
  `getThumbnail` parked speculation for the panel's life), and neither the park nor the scrub-burst
  hold was re-keyed by a splice, so a payload could paint under another file's label for the whole
  sweep. Fixed in `imageCompareProvider.ts`/`transportBudget.ts` (single `endSweep` exit, 30 s idle
  watchdog, re-key on row splices and drop on column splices, ack watchdogs cleared on dispose);
  guarded by `test/unit/transportLifetime.test.ts`.
- **Help modal clipped on small windows and its table drifted from the handlers** *(fixed)* — the
  fixed 450px/30px-padding `.modal-content` overflowed a 13"-laptop viewport on all sides, and the
  shortcut table still said Enter only toggles the winner (in crop mode it confirms the crop) and
  omitted Cmd variants, film-strip wheel gestures, and the crop square-snap double-click. Fixed in
  `webviewShell.ts` (viewport-capped, scrollable modal + table rebuilt from the real handlers);
  guarded by `test/webview/help-modal.spec.ts` at a 760×440 viewport.
- **Modality reorder lost the tooltip path** *(fixed)* — `moveCurrentModality` swapped
  `modalities`, `modalityColors`, and `modalityOrder` but not `modalityPaths`, so after reordering
  the pill name updated while its hover tooltip stayed in startup order. One-line fix in
  `webview/main.ts`; guarded by `test/webview/reorder.spec.ts`.
- **Matcher: orig+crop collision** *(open, documented)* — when originals and crops coexist, a crop
  query file can take the original's match slot. Pinned as `it.fails` in
  `test/unit/tupleMatching.test.ts` — it flips to a hard failure the moment the matcher is fixed.
- **Copy Image kept the previously copied image** *(fixed)* — the copy ran while the menu still held
  focus, and Chromium rejects `navigator.clipboard.write`
  from an unfocused document, so the write was dropped (a 1.4s "Copy failed" toast the only trace)
  and the clipboard retained the earlier image. Fixed in `webview/main.ts` (`writeImageToClipboard`):
  an unfocused write is deferred until the window refocuses, with the frame captured at copy time and
  latest-copy-wins; guarded by `test/webview/copy-image.spec.ts` (real clipboard read-back, dims-keyed).
- **PPTX button: no feedback, unbounded re-clicks, no-votes no-op** *(fixed)* — the webview never
  handled `pptxComplete`/`pptxError`, so nothing blocked re-clicks (each spawning another full
  export re-reading every image through the work pool) and a click with zero votes silently did
  nothing. Fixed in `webview/main.ts` (busy spinner until the provider answers; no votes exports
  the whole view with null winners); guarded by `test/webview/pptx-export.spec.ts`.
- **Carousel tiles showed the browser's broken-image glyph** *(fixed)* — while an external process
  rewrote files mid-view, a `thumbnail` message could carry a dataUrl the browser cannot decode
  (e.g. generated from a truncated mid-write read); the carousel `<img>`s had no `onerror`, so the
  raw glyph appeared and the corrupt url stayed cached, re-applied on every pooled-row rebind.
  Fixed in `webview/main.ts` (`handleThumbDecodeFailure`): decode failure paints the designed ✕
  placeholder and re-requests the tuple once, guarded per slot so a permanently corrupt file cannot
  loop; guarded by `test/webview/thumbnail-decode.spec.ts`.
- **Standalone build proven against the real matcher** *(new coverage)* — the single-file browser
  build is smoke-tested end to end (`test/webview/standalone-build.spec.ts`): mutation runs showed
  the spec catches both a row-order bypass of `scanForImages` and a hand-rolled `results.txt`
  format replacing `serializeResults`.
- **Two standalone poll rules were pinned only by tests that could not fail** *(new coverage)* — the
  polling round shipped with both gaps written down rather than closed: with real OPFS fixtures the
  poll's `stat` re-verification (docs/file-watching.md: sweep-reverifies-before-report) could be
  deleted with every spec green, and the re-open cleanup could be deleted from `openRoot` with the
  two-root spec green, because `state !== s` mutes a leaked poller instead of stopping it. Closed by
  the two specs described under "The suites" above (a lying listing; a live-poller count) — no
  production change: both ride seams the build already had (`__ic_standalone.open` takes the
  directory handle the test supplies; `pollIntervalMs` is injectable). **No mutation covers either
  one**: they are pinned only by Playwright, which the mutation harness cannot run (it is
  Vitest-only), so each was broken by hand instead — deleting the re-verify fails only the
  re-verification spec (`tupleDeleted:0-` reported for a file `stat` still finds), deleting
  `stopPolling(state)` fails only the cleanup spec (`pollTimers: 2, live: 2` after the switch), and
  in both runs the other eleven specs in the file passed.
- **Standalone modality rename made the pill disappear; a copied-in modality dir never appeared**
  *(fixed)* — modality-column adoption was provider-only (`addNewModality` lived in
  `imageCompareProvider.ts`) while removal was already shared, so the standalone poll could only
  execute half of a dir rename: the emptied column left, and the renamed/copied dir was never
  listed. Fixed by extracting the adoption decisions into `src/adoptionPlan.ts` (provider rewired
  onto it, wire-identical) and adding the poll's adoption executor, run after removals so a rename
  lands as remove-then-adopt in one cycle; guarded by the adoption/rename/re-open specs in
  `test/webview/standalone-build.spec.ts` and `test/unit/adoptionPlan.test.ts`.
- **Symlinked modality dirs and images were invisible at open time** *(fixed)* — `FileType` is a
  bitmask (a symlinked dir stats `66`, a symlinked file `65`), but the open-time scanner compared it
  with `===` while the adoption/poll paths already masked, so the same link showed up only if it
  appeared *after* open and vanished on the next reopen. Fixed by masking in every module that
  classifies an entry (`fileService.ts`, `extension.ts`, `thumbnailService.ts`, and the already-masked
  `imageCompareProvider.ts`; docs/tuple-matching.md: entry-type-is-a-bitmask).
  Guarded by `test/unit/symlinkScan.test.ts`, which scans real symlinks
  on disk through a `vscode` mock whose `FileType` now mirrors vscode's own `toType`. The previous
  mock could not have caught this, and worse: its `readDirectory` called every symlink a plain file
  while its `stat` silently *followed* links — so the broken `classifyUris` path looked correct.
- **The thumbnail packfile was thrown away by every quick close** *(fixed)* — pack writes are 30s
  idle-debounced and `ThumbnailService.dispose()` *cleared* the timer without writing, so a window
  closed or reloaded inside the debounce left no `thumbs.pack`/`thumbs.idx` at all and the next open
  fell back to thousands of per-entry reads — the "why is a warm open still slow on a network mount"
  report, and invisible except as slowness. Fixed by publishing on the way out (`dispose()` starts
  the write, `flush()` awaits it, `deactivate` awaits `flush()`), with the snapshot's entries
  captured at queue time so the shutdown `clearMemoryCache()` cannot publish an empty pack over a
  good one (docs/image-backends.md: thumb-pack-survives-close). Guarded by
  `test/unit/thumbPackFlush.test.ts`, which drives the real service against real files through the
  fs-backed `vscode` mock (its write side — `writeFile`/`rename`/`createDirectory` — was added for
  this) and ends on the payoff: with every per-entry `.jpg` deleted, a fresh service still serves
  byte-identical thumbnails from the pack alone.

- **Prefetch was slower than no prefetch at the one thing it exists for** *(fixed)* — a wave loaded
  `center ± prefetchCount` × *all* modalities, tuple-major. Measured on the field's shape (10
  modalities, `prefetchCount 3`, a 5-slot pool, 2.5 MB images at 740 ms each), that is 69 slots /
  164.5 MB / 13.3 s per wave, and a five-tuple browsing trace read 242.5 MB to display 10 MB — 4 %
  useful. The order was the worse half: the `+1` tuple's on-screen column sat behind the centre
  tuple's other nine, so stepping to the neighbour 1.2 s into the wave *missed* the cache and cost
  1022 ms, against a 741 ms idle cold load and the 1021 ms the same step cost with
  `prefetchCount: 0`. Fixed by scoping the wave to the on-screen column plus the nearest two
  siblings and issuing it column-major (`prefetchPlan.ts`, reusing the current tuple's own
  `siblingLoadPlan` so the two policies cannot drift)
  (docs/loading-architecture.md: prefetch-scoped-to-the-visible-column, prefetch-visible-column-first).
  After: 20 slots / 47.7 MB / 3.7 s per wave, 95.0 MB per trace, and both neighbour steps are cache
  hits at 0 ms. What it does **not** fix, and the measurement says so: a navigation issued mid-wave
  still waits up to one in-flight decode (1221 ms vs a 741 ms baseline) — the pool always hands a
  `VISIBLE` load a slot (`active=4/5` throughout), so the queue is not the constraint; the host's
  four decode threads are, and running tasks are never preempted. Narrowing shrinks the *window* in
  which a navigation can hit that, from ~13 s to ~3.5 s. Pinned by `test/unit/prefetchPlan.test.ts`
  (the pure policy), `test/unit/prefetchWave.test.ts` (the real provider on a 10-modality grid) and
  a webview spec for the strip the webview must report; seven mutations. The webview half — that
  `tupleFullyLoaded` carries the display order, the current column and the hidden set — is pinned
  only by Playwright, which the mutation harness cannot run (it is Vitest-only), so it was broken by
  hand instead.

- **A prefetch wave head-of-line blocked the carousel on remote sessions** *(fixed)* — the work pool
  ordered host-side reads but nothing bounded the extension→webview channel, so on a remote window
  one wave (~60-106 MB, one image 16.7 MB) queued ahead of a 1.2 MB thumbnail sweep and the image the
  user was looking at, on a single serialized link. Fixed by transport backpressure
  (`transportBudget.ts` + `postImage`): speculation parks while a bulk sweep drains and is otherwise
  capped in *bytes in flight*, user-facing pushes are never withheld
  (docs/loading-architecture.md: user-pushes-never-withheld, speculation-yields-the-wire). Guarded by
  `test/unit/transportFairness.test.ts`, which drives the real provider over a simulated 5 MB/s
  serialized wire — last thumbnail 12 649 → 749 virtual ms, user-facing image 12 524 → 624 ms, with a
  control run (budget off) in the same file proving the harness still reproduces the pathology.

- **Thumbnails cost 33% more wire than they carry** *(fixed)* — every `thumbnail` message shipped a
  `data:image/jpeg;base64,…` string while full images had been binary for years. Measured on the
  repo's photo fixtures at the production encode (200px inside, JPEG q70, 8 977 B/tile average): the
  serialized message is 1.33× the binary one, so a 1000-tile session posts 11.50 MB instead of
  8.64 MB, plus ~3 ms of synchronous `toString('base64')` per 1000 tiles on the extension host
  (measured cold, single pass) and the matching data-URL parse in the renderer. Fixed by posting `{bytes, mime}` (extension and standalone alike)
  and blob-URLing in the webview (docs/loading-architecture.md: image-payload-normalized,
  thumb-url-owned-by-cache). The interesting half is the webview's side: an object url is a
  document-lifetime root, so it is owned by the slot map — `test/unit/thumbUrlCache.test.ts` pins
  revoke-exactly-the-superseded-url and the adopt-before-revoke ordering, and
  `test/webview/thumbnail-binary.spec.ts` proves it end to end in a real renderer (a tile paints from
  a blob url, a replacement decodes while its predecessor is released, four pooled-row rebinds revoke
  nothing, and a re-init releases everything).

- **The not-yet-loaded half of the carousel filled with broken-image glyphs** *(fixed)* — reported in
  both products: below the open-time sweep, glyphs interspersed with correctly blank tiles. Not a
  revoked object url (an instrumented `URL.revokeObjectURL` found that no revoke ever aborted a load
  or left a tile *painting* a revoked url, and no image `error` event fired anywhere; the reported
  scenario performs zero revocations at all): `bindCarouselRow`
  emptied a recycled tile with `img.removeAttribute('src')`, which leaves an element that already
  loaded one in the browser's *broken* state — Chromium paints the glyph and fires no `error`, so the
  ✕ fallback never runs and the DOM cannot tell it from a blank tile (`naturalWidth` 0, `complete`
  true in both). Pool rows recycle from delivered rows onto undelivered ones on every scroll, so the
  glyph followed the scroll while rows that never held an image stayed blank — exactly the
  interspersing reported. Fixed by giving an empty slot the shared transparent `BLANK_THUMB`
  (docs/loading-architecture.md: empty-tile-never-broken). The paint is the whole bug, so
  `test/webview/carousel-empty-tile.spec.ts` compares a recycled empty tile against a never-filled
  one *in the same run* (no golden file, no theme/OS dependence) and pins the DOM rule that every
  visible tile carries a src that decodes; `test/unit/thumbUrlCache.test.ts` pins the blank's bytes.
- **The work pool dispatched 16 wide on a 4-vCPU host, and the priority ladder stopped meaning
  anything** *(fixed)* — `os.cpus().length` reports the machine's 256 logical cores through a
  4-vCPU cgroup/affinity limit, so `min(16, cpus - 1)` gave width 16 while Sharp decodes were
  serialized by libuv's 4 threads; measured, a `VISIBLE` decode behind 15 sweep tasks took 2799 ms
  (283 ms solo) and an unpooled `fs.stat` 2201 ms, for the same wall time as width 6. Fixed by
  sizing from `os.availableParallelism()` and capping at the libuv ceiling + 2
  (docs/loading-architecture.md: pool-width-hides-latency); `test/unit/workPool.test.ts` pins the
  rule, the source preference, and the `imageCompare.maxConcurrentReads` override, with four
  mutations in `scripts/mutation-check.mjs`.

- **The existence poll re-stat'ed every file every 10s — 7 407 pooled tasks per cycle** *(fixed)* —
  found in the field: a 746×10 comparison on NFS logged `queued=[1,0,0,0,0,5932,7407,0]` while ~6 000
  thumbnails waited, one `fs.access` task per tracked file per cycle, when the same cycle already
  listed every directory and `diffSnapshots` already returned `removed`. Fixed by deriving the
  deletion candidates from that listing (`planDirSweep` in `pollPlan.ts`), so a quiet cycle costs one
  pooled task per watched dir (11 here, measured) and zero per file
  (docs/file-watching.md: sweep-derives-deletions-from-listings); the two cases a listing alone would
  lose — an unlistable directory and a dangling symlink — are rules of the planner, not of the
  provider. Guarded by `test/unit/pollCost.test.ts` (the real `runDeleteSweep`, counting its pooled
  tasks) and `test/unit/pollPlan.test.ts`, with seven mutations in `scripts/mutation-check.mjs`.

- **The open-time sweep delivered rows the user was not looking at first, and could not be re-aimed**
  *(fixed)* — found in the field: a 746×10 remote-SSH session logged `[IC-SWEEP] start slots=7460`,
  `[IC-POOL] sweeping 2022ms … queued=[0,0,0,0,0,7293,0,4]` and `[IC-SWEEP] done 21184ms …
  pack=7398/34.4MB generated=0` — the whole grid handed to the pool at once, in scanline order, with
  nothing decoded at all: 21 s of pure ordering cost. Fixed by dispatching centre-out from the host's
  live current tuple and feeding the pool 32 slots at a time (`SweepCursor` + the chunk pump in
  `thumbnailPlan.ts`, the centre supplied by `imageCompareProvider.ts` and `standalone/adapter.ts`;
  docs/loading-architecture.md: thumbnails-centre-out, sweep-covers-every-slot-once,
  sweep-dispatch-bounded). On a virtual-clock harness calibrated to that log (it reproduces its
  21 184 ms wall), the current row ±1 after a jump to row 500 lands in 174 ms instead of 12 256 ms,
  total sweep time is unchanged, and peak queued `THUMBNAIL_BULK` falls from 7 394 to 28. Guarded by
  `test/unit/sweepCentre.test.ts` (the cursor's order and its exactly-once coverage under repeated
  jumps, plus a seeded fuzz — 350 LCG-generated schedules of `NaN`/`±Infinity`/out-of-range/fractional
  centres over the cursor, and 24 runs of the whole runner with rejections, null settles and a centre
  that moves on every dispatch) and `test/unit/sweepProviderCentre.test.ts` (the real provider's
  dispatch order, its live re-aim on `setCurrentTuple`, and the bound), with eight mutations in
  `scripts/mutation-check.mjs`. The fuzz is seeded, not random: an unseeded failure that reproduces
  once in fifty runs gets deleted by whoever hits it — and the runner fuzz counts what it generated
  (dispatches, rejections of both shapes, silent drops, missing slots) against floors well under the
  measured run, so a re-seed or a resize cannot quietly turn it into a fuzz over nothing.
  What it does *not* fix, measured in the same harness: when the extension can produce tiles faster
  than the channel drains them, the backlog sits on the wire queue, which no scheduler here re-orders.

- **The re-aimed sweep still delivered ~28 tiles at the row the user had left** *(fixed)* — the
  chunk bound above was calibrated against a 120 ms/slot "cold" model; the field's real cold cost is
  16× that. A 115×9 comparison generating thumbnails from source logged `queued=[0,0,0,0,0,28,0,6]
  run=[0,0,0,0,0,4,0,0]` with `wire thumbs=604` at +68 s and `710` at +110 s — 106 tiles in 42 s,
  i.e. 1 586 ms per thumbnail, so the 28 queued dispatches were ~13 s of stale tiles after every
  jump ("scroll down, click — tiles don't load from that place"). Fixed by dropping the
  queued-but-unstarted dispatches on re-aim and returning each dropped slot to the cursor
  (`io.dropQueued`/`SWEEP_REQUEUE`/`SweepCursor.putBack` in `thumbnailPlan.ts`, the pool key and the
  disposed/closed discriminator supplied by `imageCompareProvider.ts` and `standalone/adapter.ts`;
  docs/loading-architecture.md: sweep-cancels-on-reaim, sweep-covers-every-slot-once). On the cold
  115×9 calibration: first tile at the new row 12 690 ms → 1 590 ms (one running batch), the whole
  row 15 862 ms → 4 762 ms, total sweep wall and total thumbnail reads unchanged (410 774 ms,
  1 035) — cancelled work never started, so nothing is re-done. Guarded by
  `test/unit/sweepCentre.test.ts` (the cursor's return path, and the runner over a real `WorkPool`:
  the new centre served after one batch, exactly-once delivery with the centre moving on every
  batch) and `test/unit/sweepReaimCancel.test.ts` (the real provider at the field's pool width: the
  same latency bound, the poll task on `poolKey` surviving the drop, and a disposed panel's
  cancellations settling instead of re-dispatching), with six mutations in
  `scripts/mutation-check.mjs`.

- **A closed panel's sweep read the rest of the grid, and a non-idempotent `centre()` livelocked the
  pump** *(fixed, one round — both were `pump()` mishandling host state)* — after a dispose (or a
  standalone re-open) the host cancelled the sweep's queue and every settle came back `null`, but
  `pump()` kept pulling from the cursor and dispatching: on the maintainer's remote NFS sessions,
  746×10 warm from the pack was ~34.4 MB and ~21 s of pool time after the close, and a cold 115×9
  closed a minute in left ~5 more minutes of reads running behind a window that was gone. Measured
  on the pure runner over a real `WorkPool` (120×4 grid, width 5): **448 of 480 slots read after the
  close, now 0**; on the real provider (30×2 at the field's pool width, where dispose cancels the 28
  queued dispatches itself) **28 further reads after the dispose, now 0**. Fixed by a second host predicate beside `centre` — `abandoned()`, `state.disposed` /
  `s.closed` — that stops the pump at a batch boundary, plus the two exits that keep an early stop
  from hanging the sweep promise (docs/loading-architecture.md: sweep-stops-when-host-abandons; the
  coverage invariant `sweep-covers-every-slot-once` now says out loud that coverage holds for a
  *live* host only). The second defect was latent: `pump()` read `centre()` inside its `while`, so a
  centre computed on read (the backlogged viewport-derived one) both dropped the slots the same pass
  had just dispatched and turned every requeue-settle into a fresh drop — a microtask cascade that
  never yields, reproduced as `timeout 25 node` → exit 124 with only 4 reads ever started. The
  one-line hoist the backlog proposed is **not sufficient** — measured, not assumed: hoisted-only
  still hung (exit 124). The requeue must also decline to re-aim (`pump(requeued ? aimed :
  centre())`), after which the same grid finishes in 83 ms with every slot delivered once
  (docs/loading-architecture.md: sweep-aims-once-per-pass). Guarded by
  `test/unit/sweepAbandon.test.ts` (reads counted across the close, the sweep promise resolving, the
  abandon path held apart from the re-aim path), `test/unit/sweepAim.test.ts` (the first chunk as one
  centre-out band on one centre read; a livelock case that trips a `dropQueued` circuit breaker
  instead of hanging the runner), `test/unit/sweepReaimCancel.test.ts` (the real provider's dispose)
  and `test/unit/transportLifetime.test.ts` (exactly one `[IC-SWEEP] done`, the wire claim released,
  nothing left parked), with five mutations in `scripts/mutation-check.mjs`.

- **The open scanned the modality directories one at a time** *(fixed)* — found in the field on a
  remote/NFS session: three opens logged `scan=2431ms/7398f` over 11 dirs, `3890ms/1390f` over 11,
  and `3640ms/984f` over 10 — 7x fewer files taking 50% *longer*: 221 ms per directory warm against
  364 ms cold, a spread that tracks the cache and not the file count. Serialized by a `for` loop of
  `readDirectory` awaits. Fixed by overlapping the listings
  under a cap (`listModalityDirectories` in `fileService.ts`; docs/tuple-matching.md:
  dir-listings-overlap), assembled in the caller's dir order because `modalityFiles`'s insertion order
  *is* the column order (docs/tuple-matching.md: modality-order-is-callers). On the model the fix
  targets (11 dirs, 350 ms injected per-listing latency, the real `scanForImages`): 3900 ms → ~385 ms.
  Guarded by `test/unit/parallelScan.test.ts` (max listings in flight, caller order under
  slowest-first completion, the cap, the preserved empty-dir/sort/failure behaviour, the caller order
  as it reaches the init payload), with
  eight mutations in `scripts/mutation-check.mjs`. The cap is pinned *exactly* (40 dirs must list 16 at a
  time, not "at most 16"): an upper bound alone left `DIR_LISTING_CONCURRENCY` free to fall to 11
  — a silent halving of the open-path parallelism — with every test and every mutation still green.

- **Two of the poll round's own coverage gaps closed, two written down** *(test-only)* — the
  verifier notes in `dev_backlog/poll-test-hardening.md`. (1) The standalone dir-rename spec pinned
  cycle *order* probabilistically; a held-timer spec now fires exactly one cycle over a rename that
  is already fully on disk (numbers under "The suites" above: the racing spec escapes 10-30% depending
  on how the suite is invoked, the held-timer spec 0 of 20). (2) `entry-type-is-a-bitmask` was cited from `thumbnailService.cleanupOldCache` with no
  test behind the citation: reverting that gate to `===` broke nothing. It is now killed by
  `test/unit/thumbCacheExpiry.test.ts` ("a symlinked cache entry expires by age…", a real symlink in
  a real cache dir through the fs-backed mock) plus the matching `symlink: thumbnail cache-age sweep
  back to strict equality` mutation, with `test/integration/cacheSweep.test.ts` pinning the same
  site against the **real** `vscode.workspace.fs` — the only layer that can say the real API types a
  linked cache entry `File|SymbolicLink`. That integration file has never been run on a developer
  machine here (no X server for Layer 2); it is type-checked via
  `tsc -p test/integration/tsconfig.integration.json` and CI is its only proof, exactly like the
  dangling-symlink premise in `scan.test.ts`. (3) and (4), the standalone snapshot prune and
  `extension.ts`'s session prune, are recorded under "What nothing covers" above as accepted gaps
  with the reason each cannot be pinned from a test.

- **The webview suite sized itself from the wrong core count** *(fixed)* — Playwright's default
  `workers` is 50% of `os.cpus().length`, which on a cgroup-limited, SLURM-allocated or container
  host is every core on the *machine* (256 reported, 4 usable on the box where this was found).
  The suite then ran dozens of Chromiums on a handful of cores, every spec took ~10x its
  uncontended time, and the slowest ones hit their 30 s timeout — red for a reason unrelated to
  the change under test. GitHub runners report their true count, so CI was never exposed; this was
  a local trap only. Fixed in `test/webview/playwright.config.ts` by pinning `workers` to 50% of
  `os.availableParallelism()` — the same call, and the same reasoning, as the extension's own pool
  width (`docs/loading-architecture.md: pool-width-hides-latency`). The shape is Playwright's own
  default, so any host where the two counts agree keeps its existing sizing; `--workers=N` still
  overrides. The same commit gave the suite an explicit `outputDir` (`test/webview/test-results/`,
  what `.github/workflows/test.yml` already uploads) so the HTML report at
  `test-results/webview-html-report` is no longer nested inside it — that nesting is what printed
  `Configuration Error: HTML reporter output folder clashes with the tests output folder` on every
  run. Both paths are covered by the existing `test-results/` line in `.gitignore`.
  Guarded by `test/unit/playwrightConfig.test.ts` and two mutations — CI cannot catch a revert
  here on its own, because a runner's `cpus().length` and `availableParallelism()` are equal.

- **Playwright's three JSON-report env vars do not share an anchor** *(fixed)* — a Playwright JSON
  report landed at `test/webview/test/dashboard/results/webview.json` (note the doubled `test/`),
  untracked and un-ignored, carrying this machine's username, home directory and checkout root in
  every `config.argv` entry; a `git add .` would have published it. The cause is not a wrong cwd:
  in `resolveOutputFile` (`node_modules/playwright/lib/runner/index.js`), `PLAYWRIGHT_JSON_OUTPUT_FILE`
  and `PLAYWRIGHT_JSON_OUTPUT_DIR` resolve against `process.cwd()`, but `PLAYWRIGHT_JSON_OUTPUT_NAME`
  resolves against the **config-file directory** — so a repo-root-relative value passed as `_NAME`
  with `--config test/webview/playwright.config.ts` lands under `test/webview/`. The generator now
  passes `_OUTPUT_FILE` (cwd-anchored, agreeing with the `cwd: ROOT` it forces on every suite) from
  `test/dashboard/suiteCommands.mjs`, whose `assertAbsolute` refuses a relative report path at import
  time — an absolute path means the same thing under every anchor, so the trap cannot be re-armed by
  a one-word edit. Guarded by `scripts/check-generated-output.mjs`, which was re-armed with the
  original `_OUTPUT_NAME` value and confirmed to go red on both of its halves.

- **Standalone cropping was broken 100% of the time, and 274 mutations over 578 tests could not see
  it** *(fixed)* — `src/cropFlow.ts` is SHARED, and it calls `Buffer.isBuffer`; `standalone/shims/buffer.ts`
  attached only `from`, `alloc` and `concat`, so in the browser the call threw, `cropFlow`'s own
  per-image `catch` swallowed it, every modality returned `undefined` and the user got
  `Crop failed: Failed to crop any images` — for every crop since the shared crop flow landed
  (`6ad145e`, the standalone's first commit: standalone cropping has never worked). **The class, not the
  typo:** shared code compiles against node's `Buffer`/`path`/`vscode` **types** and runs against a
  hand-rolled **shim**, and nothing proved the two agree. `tsc` cannot: the types are node's. The unit
  layer could not either — a test importing `cropFlow` gets node's real `Buffer`, so the bug is
  invisible at exactly the layer that pins the crop transcript, which is why `test/unit/crop*` is
  green with the shim's `isBuffer` deleted (verified: both new mutations SURVIVE when judged by
  `test/unit/crop`). Two things close it. `test/unit/shimParity.test.ts` runs the real `performCrop`
  with `globalThis.Buffer` stubbed to the real shim — the same substitution esbuild's `inject` makes
  for the bundle — against a `renderCrop` returning a plain `Uint8Array`, as a canvas blob does; it
  reproduces `cropError` on the unfixed shim and kills both mutations. And `scripts/check-sidedness.mjs`
  gate (d) makes the class mechanical: it walks the standalone bundle's closure (which it already
  derives) and resolves every `Buffer.x` / `path.x` / `vscode.a.b` chain against the shim's **real**
  runtime surface, obtained by bundling and evaluating the shim with esbuild rather than parsing it.
  Confirmed red on the unfixed tree, naming `src/cropFlow.ts` and `Buffer.isBuffer`, and it is
  noise-free on the current tree: 26 bundled modules, 3 shims, exactly the one true gap. What it does
  **not** check is behaviour — a shim static that exists and lies is a test's job, which is why the
  mutation that flips `isBuffer` to answer `true` for a plain `Uint8Array` is there too.
  (`docs/standalone.md: shim-covers-bundled-calls`)

- **Deleting a comparison's folder left a spinner over the last image it happened to have**
  *(fixed)* — and the layer could not see it, because **no webview spec anywhere asserted anything at
  zero tuples or zero modalities**: 71 specs, all of them on a comparison that still had content. The
  two shapes an emptying comparison arrives in both ended badly and for different reasons — at zero
  rows `handleTupleDeleted` skipped `loadTuple`, and `render()` is the only writer of the canvas, so
  the last frame simply stayed; at zero columns `loadTuple` turned the spinner on and then found the
  vacuously-complete cache and returned, issuing no request, and a reply is the only thing that turns
  a spinner off. Two more traps were found by *writing* the test rather than by reasoning: the row and
  column add handlers each shift the cursor past the insertion point, which lands off the end when
  the list was empty, so re-adoption after the folder returned would have stranded the view (the
  recovery test caught both), and the guard had to go **ahead of** `loadTuple`'s `index >= tuples.length`
  early return, which at zero rows returns before anything could render. A probe against the unfixed
  bundle recorded the symptom in both shapes (`spinnerActive: true`, canvas visible, status stuck at
  `Loading...`) before a line changed. Pinned by `test/webview/empty-comparison.spec.ts` (the rendered
  end state and the recovery), `test/unit/emptyNotice.test.ts` (the decision, five mutations) and
  three cases in `test/unit/pollCost.test.ts` driving the real `runDeleteSweep` (the root-existence
  edge, six mutations). (`docs/loading-architecture.md: empty-comparison-is-terminal`,
  `docs/file-watching.md: root-loss-reported-as-an-edge`)

  Two further defects, both found by *driving* the scenario rather than reading it, and both worse
  than the bug being fixed. **The notice was a dead end in exactly its own repro**: after a total
  `rm -rf` the scan empties, and `adoptNewModalityDir` read the URI scheme from
  `tuples[0].images[0]`, so it returned before its first filesystem call and no recreated directory
  was ever adopted — the panel would have said "Nothing left to compare" forever while the job wrote
  a new epoch beside it. A first bed missed this and reported the recovery healthy, because it left
  `watchersByDir` empty: `unwatchModalityDir` then returns *before* dropping the dir from
  `watchedDirs`, the sweep keeps leaf-listing a released directory, and the arrival lands through a
  route production does not have. Fixed with a `?? state.baseUri.scheme` fallback at
  `adoptNewModalityDir`'s scheme read — the one site on the path an emptied scan can reach; the
  sibling read in `addNewModality` needs none, and the mutation that pretended otherwise survived
  (`docs/file-watching.md: root-return-re-adopts`) — pinned by `test/unit/rootReadoption.test.ts`
  with two mutations. **And the stale image survived on a second surface**: the report said "a preview of
  the very last image it saw", and the floating panel's minimap (`#thumb-canvas`) is exactly that —
  a full 150x94 minimap, 14 100 opaque pixels of the last frame, still on screen with the main canvas
  hidden, in both shapes.
  The spec now counts opaque pixels on that canvas (0 after, non-zero before, so it cannot pass
  vacuously) rather than trusting a class.

- **A bed that shut a provider down without awaiting what the shutdown starts — Windows-only, and the
  third of that shape** *(fixed)* — `test/unit/rootReadoption.test.ts` passed every assertion on all
  three OSes and was still reported FAILED on Windows: its `afterAll` threw
  `ENOTEMPTY: directory not empty, rmdir '…\globalStorage\thumbnail-cache'`. The bed called
  `provider.dispose()` and returned. `dispose()` is synchronous **by contract** and only *starts* the
  pack write (`docs/image-backends.md: thumb-pack-survives-close`); `deactivate` is the one shutdown
  path that awaits it, via `provider.flush()`. Measured on Linux, `thumbs.pack` and `thumbs.idx`
  landed **1-3 ms after `dispose()` returned** — inside the `rmSync` that followed, which on POSIX
  merely recreates files under a directory being walked and on Windows fails the `rmdir` outright.
  The teardown *pattern* was not the differentiator (`pollCost.test.ts` uses byte-identical teardown
  and is green): `rootReadoption` is the only bed that drives a **provider** into writing its
  thumbnail cache at all. Instrumenting the `vscode` mock's `writeFile` across the whole unit layer
  recorded **139 writes, none failed**, from exactly seven suites (grouped by their temp roots): the
  six that construct `ThumbnailService` directly — `thumbSharedWait`, `thumbPackFlush`,
  `thumbTierStats`, `thumbCacheExpiry`, `thumbCacheKeying`, `jimpFallback` — plus this one. Every *other* provider bed —
  `pollCost` included, 12 beds snapshotted after teardown, 0 changed, no `globalStorage` present at
  all — never requests a thumbnail, so no write is even attempted.

  Two claims in earlier drafts of this paragraph were wrong, and both are recorded here because the
  paragraph's whole job is to tell the next author where the trap is. The first said the other beds'
  writes *fail with ENOENT*: they do not happen at all — right conclusion, invented mechanism. The
  second said the six direct-`ThumbnailService` suites "all already `await flush()`", which was
  another claim asserted rather than measured, and **two of them did not**. `jimpFallback` calls
  `initialize()` (`:79`), which creates the cache directory, then writes a `.jpg` into it un-awaited,
  with no `flush()` or `dispose()` anywhere and the same recursive `afterAll` `rmSync`: under a 3 s
  write delay it went green in 716 ms with the write outstanding and `rmSync` running against the
  directory the file was about to appear in. `thumbPackFlush` — the suite that owns this rule —
  ended with three writes still outstanding, because the tests that exercise the fire-and-forget
  `dispose()` deliberately await nothing and its `afterAll` slept 100 ms instead. Both are fixed the
  same way rather than documented around: each bed keeps the services it built and `afterAll` awaits
  `flush()` on every one before removing the roots (which also retires that `sleep(100)` — a flush is
  what the sleep was approximating).

  What replaces the assertion is a measurement, and it is the one to repeat when this comes up again:
  run the whole unit layer with every `.jpg` write delayed 500 ms at the `node:fs` seam — a setup file
  wrapping `fs.promises.writeFile` that logs each write's issue and completion. Two practical notes,
  both learned by getting them wrong. `fs.rmSync` **cannot** be wrapped the same way (non-configurable
  on the module namespace: `TypeError: Cannot redefine property`), so the file boundary has to come
  from the runner — register the wrapper through `setupFiles`, which means either a temporary entry in
  `test/vitest.config.ts` or a second config passed with `-c`; the probe itself is the only part that
  can live outside the tree. Against **both pre-image beds**: 78 writes issued, 74 completed,
  **4 outstanding at exit** — three from `thumbPackFlush`, one from `jimpFallback`. After both fixes
  (plus the writes the two new tests issue): **82 issued, 82 completed, 0 outstanding, 0 failed,
  627/627 green**, reproduced at 200 ms, 500 ms and 1000 ms — i.e. no unit bed now ends with a cache
  write in flight, on any OS. A first draft of this paragraph said 3, because the count had been taken
  after `jimpFallback` was already fixed — a before/after pair whose "before" was not re-derived from
  the "before" tree. The lesson to carry is exactly that: a census is evidence only if every row is
  read, and against the state it claims to describe. `ic-jimp` was in the first measurement's own
  output all along.

  Both bed teardowns now go through `settleServices` in `test/helpers/providerQuiesce.ts` rather than
  each hand-rolling the loop, and `thumbPackFlush` pins it (a 200 ms write must have landed when it
  returns, asserted on the write's own completion flag rather than on a file, so it cannot pass by
  timing) with a mutation entry that removes the flush and is verified SURVIVING without that test.

  Fixing the bed was **not enough, and the first attempt to stop there is the instructive part**. A
  bed-only fix drains the work pool, then runs `deactivate`'s order — `await flush()`, `dispose()`,
  a trailing `await flush()` for the write `dispose()` queues — and asserts the temp tree does not
  move for 250 ms. That is causal for the *pack* write and was verified so. It is **not** causal for
  the per-entry `.jpg`: `getThumbnail` issued `saveToDiskCache` un-awaited and returned on the next
  line, so the pooled task settles — `pending`/`running` both 0 — while the write is still in flight,
  and no drain can see it. Probed by making every `.jpg` write take 3 s at the mock's `writeFile`
  seam: teardown returned in **256 ms with 0 of 2 files written**, both landing 4 s later, i.e. during
  `afterAll`. Everything separating that from the Windows error was a wall-clock margin that shrinks
  under load. A 250 ms window against a 1-3 ms write is `maxRetries` in better clothes.

  So the writer was made awaitable in the product, where the leak actually lives:
  `ThumbnailService` registers each fire-and-forget cache write and `flush()` settles them
  (`src/thumbnailService.ts`, `docs/image-backends.md: thumb-pack-survives-close`). This is a real if
  minor production defect in its own right — `deactivate` awaits `flush()`, and a `flush()` that
  returns with writes outstanding loses the newest thumbnails when the host exits. The generate path
  is unchanged (still un-awaited; a thumbnail must not wait on a disk round-trip), and `flush()`
  queues the pack snapshot **before** its first `await` so the synchronous entry capture that
  `thumb-pack-survives-close` depends on survives the new wait — the pre-existing
  `clearMemoryCache`-race test caught that ordering immediately when it did not. Under the same 3 s
  probe, teardown now takes **3014 ms and returns with the files on disk**. Pinned by
  `test/unit/thumbPackFlush.test.ts` ("flush() also waits for the per-entry .jpg writes it started"),
  which fails against the old code with the same delay injected, plus the bed's own quiet-window
  assertion in `test/helpers/providerQuiesce.ts` — which fails on all three `rootReadoption` tests
  against the old teardown, for the exact files the Windows error named. Three mutations in
  `scripts/mutation-check.mjs` — `flush()` dropping its per-entry settle, the queued pack write no
  longer awaited, and the shared bed teardown skipping its flush — each verified KILLED with the new
  tests and SURVIVING without them.
  The pool drain stays, for the one thing no flush can reach backwards in time — a generate still
  running would re-dirty the pack and register a new write after the flush had settled — and not for
  the `.jpg`, which it never covered; on this runner it measures `pending=0 running=0` at every
  teardown, which is exactly the luck a loaded Windows runner does not owe us.

  The durable lesson is the *class*, and it is now three deep: a POSIX-only mental model — `fs.watch`
  given a URI path, `fs.access` on a dangling symlink, and now an un-awaited write racing a recursive
  `rm` — is invisible to a green Linux suite every time. The two earlier ones were closed by faking
  the platform's verdict at the `node:fs` seam; this one cannot be, because nothing about the *call*
  differs — what differs is whether a concurrent write is tolerated. The rule that replaces it:
  **make the async work finish, and assert that it did, rather than pick a window and hope**. If the
  code offers no way to await it, that is the bug — fix it there, not in the bed. The next bed that
  gives a provider a real `thumbnail-cache` directory inherits all of this: tear it down through
  `test/helpers/providerQuiesce.ts`, and a bed holding a bare `ThumbnailService` must `await flush()`
  before its temp root goes. Both warnings sit where the next author will be standing rather than only
  here — `test/unit/pollCost.test.ts`'s `finish()` and `test/unit/jimpFallback.test.ts`'s `afterAll`.

## The generated-output rule

**A generator writes only into a directory `.gitignore` already covers — and it writes.** Not a style
preference: un-ignored generated output is one `git add .` from being published, and reporter JSON
routinely embeds absolute machine paths. `node scripts/check-generated-output.mjs` enforces both
halves mechanically, in the CI gates:

- **Placement.** It snapshots `git status --porcelain -uall` — each listed path stamped with its size
  and mtime, so a generator overwriting a file that already reads ` M` registers too — runs each
  generator (the dashboard with `--reuse`, the webview JSON leg with `--list`, both a second or two),
  snapshots again, and fails on any path the listing gained or whose stamp moved; ignored paths never
  appear there, so a difference *is* an un-ignored write.
- **Liveness.** Placement alone passes vacuously when a generator dies before writing a byte: the
  listing is untouched either way, so a broken generator would silently disable the gate on every
  push and PR. Each generator therefore declares the artifact it must land — `dashboard.html` for the
  dashboard, the report at the absolute path the checker hands the webview leg — and the run must
  leave that exact path existing and newer than the run's start. A suite that *runs and fails* still
  emits its report and stays green here; a generator that never ran does not.

Re-arming the original bug — the report path passed as Playwright's `_OUTPUT_NAME`, which re-anchors
against the config directory — trips both halves: the report lands at
`test/webview/test/dashboard/results/webview.json`, 49 KB carrying this machine's home directory and
checkout root, and never at the absolute path the checker asked for. For the placement half to see it
at all, that path must not be pre-ignored, so the two lines added to `.gitignore` in the aftermath of
the incident (`test/webview/test/`, `test/dashboard/results/`) are gone: they rendered the original
leak inert and the gate blind to a repeat of it, and nothing writes either directory today. The
word-list pre-commit guard, by contrast, caught the original leak only by luck — that file happened
to embed a username.

This rule is enforced from `scripts/`, which `check-invariants.mjs` deliberately does not accept as a
citation site, so it is stated here as a rule rather than registered as an invariant key.

Its companion `scripts/check-no-personal-refs.mjs` (`.githooks/pre-commit` only — it needs the
gitignored `.words-to-check.txt`) checks *content* instead of placement: the listed words, the runtime user and
group names, and this machine's home directory and checkout root as literal **prefixes**. Prefixes,
never a bare `/home/` or `^/` rule: invented absolute paths are the assertion in dozens of unit tests
(`/base/logs` memo keys, `C:\data\exp1\GT` on a Linux runner, `/home/u/data/results`), a general rule
flags ~200 of them and none is a bug, and a guard that cries wolf teaches `--no-verify` on day one.

## Viewing the generated reports

Two artifacts are meant to be opened by a developer (both regenerated by the test commands; neither
ships in the extension; both are republished to GitHub Pages on every main push):

- **`test/dashboard/dashboard.html`** — the feature-coverage dashboard (generated by
  `npm run test:dashboard`, not versioned); open in any browser.
- **`test/demos/gallery/index.html`** — the captioned demo gallery (generated by
  `npm run test:demos`, not versioned; also uploaded as the `demo-gallery` artifact on every CI
  run); open in any browser. Clips are H.264 MP4, so they play in Safari, Chrome, and VS Code's
  built-in preview alike. Keep the sibling `*.mp4` files next to the HTML.

`test/webview/harness/index.html` is generated at test time and git-ignored — it's the internal
Playwright harness, not for reading.

## Manual checks

Failures here are invisible to CI, so they are worth walking before a release. Two former entries
are automated now and dropped from the walk: three-mode scanning/commands run in the headless
integration layer (`npm run test:integration`), and placeholder rendering plus the webview
interactions run in the Playwright layer (`npm run test:webview`) — both on every PR and every
`main` push via `.github/workflows/test.yml`. What remains manual:

1. In a real panel, right-click the image and a modality pill: the comparison's own menu must be the
   only one that appears (no VS Code menu over or instead of it), Copy Path and Reveal in Explorer
   must act on the right file, and Hide Modality must gray the pill. Then export a PPTX: the toast
   must name the file and its Reveal must work. This is the one half of the menu contract no layer
   can see — see "What nothing covers".
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

## What changed in the app to enable testing

- `src/webviewShell.ts` — extracted the static styles+body (one source of truth for the panel and
  the harness).
- `window.__ic_test` read-only state hook in `webview/main.ts` (inert unless a test sets
  `__ic_test_enabled`).
- `export` added to a few pure functions so tests import **real** code instead of copies.

## Debug logging

Enable `imageCompare.debug`, reopen the comparison, then read **View > Output > ImageCompare**. That
output channel is the sink for everything below, and it is the one to attach to a "why is this slow"
report — it works over SSH, where the webview dev console does not.

```jsonc
// settings.json
"imageCompare.debug": true,
"imageCompare.debugVerbose": false,  // one line per thumbnail and per outbound message
"imageCompare.debugConsole": false   // also mirror to the developer console
```

Every line is `+<ms since activation> [TAG] …`, so a channel dump is a timeline without needing wall
clocks correlated across processes.

| Tag | What it traces |
|---|---|
| `[IC-MATCH]` | Tuple matching: per-modality file counts, the elected reference, exact hits, fuzzy candidates and scores, then the final tuple summary. |
| `[IC-EXT]` | Watcher events, the existence sweep, adoption, and handler error paths. Also mirrored to the webview console (bounded to the last 200 lines if the webview is not ready yet). Its `pool …` snapshot is printed only when the pool is busy or the snapshot changed, so an idle window goes quiet instead of repeating itself every 10 s (`docs/loading-architecture.md`: `idle-poll-logs-nothing-new`). |
| `[IC-OPEN]` | One line per open **that reaches the sweep**, printed as the sweep starts: total wall time split into `scan` (with the files scanned and the matcher's nested time), `watchers`, `boot` (html assignment → the webview's `ready`), `init` (assembly + the serialized payload size, and the `sizing` pass debug itself adds), `toSweep` (hand-off, ending on the sweep's own clock), and `other` for whatever no span claims (`docs/loading-architecture.md`: `open-spans-account-for-the-whole-open`). An open that aborts first — closed during the scan, nothing matched, a throw, a webview that never posts `ready` — prints nothing at all. |
| `[IC-SWEEP]` | The open-time thumbnail sweep: `start` (slots, items, missing, grid, pool state) and `done` (wall ms, items/s, payload bytes posted, tier histogram, the shared pack read, pool state, running wire totals). |
| `[IC-THUMB]` | Verbose only: one line per `getThumbnail` — which tier served it, its own ms, `+<n>ms packLoad wait` when it queued behind the shared pack read, output bytes, path. |
| `[IC-POOL]` | A `WorkPool.stats()` + wire-total snapshot every 2 s while a sweep is draining. |
| `[IC-WIRE]` | Verbose only: one line per outbound `thumbnail` and `image`, with the running per-panel total. Both figures are raw payload bytes and directly comparable — thumbnails ship binary like images, so the `(b64)` marker (and the ~33% inflation it stood for) is gone. A thumbnail line also names its mime, which differs by product: JPEG from the extension, PNG for `.png` sources in the standalone build. |
| `[IC-PREFETCH]` | A prefetch wave when issued (centre tuple, slots, pool state) and again when it drains (wall ms, bytes actually loaded). Bytes are unknowable at issue time — the files have not been read yet — so the rollup is where they appear. |

Reading it:

- **Mis-grouped comparison** → `[IC-MATCH]`: read the final tuple summary and look for `MISSING:`
  entries; those are the modalities that found no file for a row.
- **A window that stays blank before any thumbnail appears** → the single `[IC-OPEN]` line, *if there
  is one*: it splits the whole pre-sweep wall time into scan / watchers / webview boot / init payload /
  hand-off, so the answer is one term rather than a gap between two timestamps. `other=` large means the
  slow step has no mark yet — add one instead of guessing. **No `[IC-OPEN]` at all** means the open
  never reached the sweep (impatient close, an empty scan, a throw, or a webview that never booted);
  read the last `[IC-MATCH]`/`[IC-EXT]` lines instead — the line cannot report an open that never ended
  (`docs/loading-architecture.md`, "When the line is absent").
- **Slow carousel population** → the four tiers in the `[IC-SWEEP] done` histogram say whether the
  session was warm (`pack`/`memory`) or paid for decoding (`generated`); `[IC-POOL]` says whether the
  pool was saturated or idle-waiting; and interleaved `[IC-PREFETCH]`/`[IC-WIRE]` totals say whether
  full-image traffic is crowding the thumbnails off a serialized remote channel.
- **How to read a tier's `ms`, and the `packLoad=` term next to it.** Each `<tier>=<count>/<bytes>/<ms>`
  reports the **work those items did themselves**; time spent blocked on the one `thumbs.pack` read
  they all share is *not* in it. That read is reported once, separately, as
  `packLoad=<reads>x<ms>/<bytes> blocked=<callers>/<summed wait>` — so
  `pack=83/385.1KB/122ms packLoad=1x612ms/1.4MB blocked=83/8118ms` reads as "83 map lookups costing
  122 ms between them, all of them stuck behind a single 612 ms file read". `packLoad=0` means this
  sweep did not pay for a pack load (a second sweep in the same session, or a cache with no pack).
  The distinction is the whole point: before it existed the same session printed
  `pack=83/385.1KB/8118ms` for a sweep that finished in 658 ms wall, which invites the wrong fix
  (attack the pack tier) instead of the right one (one slow read on a slow mount). Tiers *below* the
  pack inherit the same wait — a `generated` figure is likewise decode work, not queueing. Sanity
  check: no tier's `ms` should exceed the sweep's own wall ms by more than the pool's width.
- **Is the transport budget doing anything?** (remote sessions; it is inert locally —
  `docs/loading-architecture.md`: `wire-budget-remote-only`). Read the `images=` term of the `wire`
  totals on the `[IC-SWEEP] done` line: it counts every full image that crossed the channel *while
  the sweep was draining*, so with backpressure on it should show only images the user asked for
  (typically the opening tuple), never a whole wave. A `[IC-PREFETCH] wave … done` line whose
  `loaded=` is tens of MB followed by a sweep rollup that still reads `images=1/…` is the policy
  working: the wave was read and cached, and its pushes waited for the sweep to finish. The
  opposite shape — `[IC-SWEEP] done … images=43/59.6MB` — is the bug this replaced, and is still the
  expected (harmless) shape on a local window or with `imageCompare.prefetchTransportBudgetMB: 0`.
  `[IC-POOL]` snapshots taken mid-sweep show the same story in progress: `images=` should stay
  roughly flat across them while `thumbs=` climbs.

One sweep of a 20×6 session, warm pack, one new file. **Captured before thumbnails went binary**, so
its `thumbs=`/`posted=` figures are data-URL string lengths (hence the `(b64)` marker), and today's
counters report the JPEG bytes themselves. Read the sample for the *shape* of the lines, not as
calibration: its `posted=1.4MB(b64)` is 2.7× its own tier histogram (`pack=117/512.9KB` +
`generated=1/4.4KB`), which no version of the code can produce — both figures derive from the same
buffers — so one of the two was mis-transcribed when the sample was captured. It also predates the
shared-load split, so its `pack=117/512.9KB/486ms` is 117 copies of one pack read; today the same
open prints a much smaller `pack=…ms` plus a `packLoad=1x…ms/… blocked=117/…ms` term. It predates
prefetch scoping too: a wave then covered every modality of every neighbour, where today it covers
the on-screen column and its nearest two siblings, so a comparable session's `slots=` is smaller:

```
+412ms [IC-MATCH] === TUPLE MATCHING START ===
+416ms [IC-MATCH] Modalities: ["gt","ours","baseline"]
+498ms [IC-MATCH] === TUPLE MATCHING END ===
+901ms [IC-SWEEP] start slots=120 items=118 missing=2 grid=20x6 pool active=0/15 run=[0,0,0,0,0,0,0] queued=[0,0,0,0,0,0,0]
+2903ms [IC-POOL] sweeping 2002ms pool active=15/15 run=[0,0,0,0,0,14,1] queued=[0,0,0,0,0,63,0] wire thumbs=41/512.4KB(b64) images=2/24.1MB
+3110ms [IC-PREFETCH] wave panel-1-prefetch-1 center=0 slots=6 pool active=15/15 run=[0,0,0,0,3,11,1] queued=[0,0,0,0,3,40,0]
+4905ms [IC-POOL] sweeping 4004ms pool active=15/15 run=[0,0,0,0,0,15,0] queued=[0,0,0,0,0,19,0] wire thumbs=93/1.1MB(b64) images=4/48.7MB
+5418ms [IC-PREFETCH] wave panel-1-prefetch-1 done 2308ms slots=6 loaded=71.9MB pool active=9/15 run=[0,0,0,0,0,9,0] queued=[0,0,0,0,0,7,0] wire thumbs=101/1.2MB(b64) images=6/71.9MB
+6002ms [IC-SWEEP] done 5101ms items=118 23.1/s posted=1.4MB(b64) memory=0 pack=117/512.9KB/486ms disk=0 generated=1/4.4KB/38ms pool active=0/15 run=[0,0,0,0,0,0,0] queued=[0,0,0,0,0,0,0] wire thumbs=118/1.4MB(b64) images=6/71.9MB
```

The shape to look for is right there: 118 thumbnails cost 1.4 MB on the wire and 524 ms of *waiting*
(under today's accounting most of that 486 ms is the one pack read, reported as `packLoad=`), but took
5.1 s of wall time while 71.9 MB of prefetched full images shared the channel. That is a
*local* capture, where the transport budget is deliberately inert; on a remote window the same
session's sweep rollup reads `images=` in the single digits, because the wave's pushes are parked
until the sweep drains (`docs/loading-architecture.md`, "Transport backpressure"). The `[IC-PREFETCH]
… done` line is unchanged either way — it reports bytes *read*, which backpressure does not defer.

One `[IC-PREFETCH]` wave prints exactly two lines — issue and rollup — whatever the tuple's shape; a
slot whose modality has no file still counts toward `slots=` and settles at zero bytes.
