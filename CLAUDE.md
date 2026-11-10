# ImageCompare VSCode Extension - Development Guide

## Git Commit Rules

- Never add Co-Authored-By lines to commits. `.githooks/commit-msg` rejects a
  `Co-Authored-By`/`Claude-Session`/`Generated-By` trailer; its header says why it must be
  `commit-msg`.
- **Hooks live in `.githooks/`, and only there.** `npm run hooks:install` sets `core.hooksPath` to
  it, so a guard in `.git/hooks/` never runs.
- **A tracked hook names nobody.** The identity guard in `.githooks/pre-commit` checks that a
  repo-local `user.email` is set, never which address. `check-no-personal-refs.mjs` does not look
  for an email address, so a hardcoded one passes it.

## Documentation Rules

Document **invariants and non-obvious "why"** — not mechanics the code already states. A list of
message types or keyboard shortcuts rots and adds nothing; "the poll must never be synchronous" or
"crop refs are deprioritized so they never steal matches" is what saves the next person.

- **Write prose in Simplified Technical English** (the ASD-STE100 writing rules, as
  `agents/bloat-auditor.md` → "The prose standard" lists them). The `bloat-auditor` rewrites what
  breaks them, in each change and in a `/prune` sweep.
- **Plans are disposable, decisions are durable.** Delete an implementation plan once executed —
  it describes intent, some of which always changes, and a reader can't tell intent from truth.
  Fold anything durable (the diagnosis, the invariants) into the relevant `docs/` file. Plans
  *awaiting* execution live in `dev_backlog/`, never in `docs/` — `docs/` describes what is,
  `dev_backlog/` what might be, and a reader must be able to trust the difference.
- **After a code change, update the docs it invalidates.** Required for: new/removed files,
  changed architecture, changed behaviour of something documented, or a new invariant. Skip for:
  bug fixes with no design change, refactors, typos.
- **If a doc claim can't be verified in the code, fix it or delete it.** Several claims here were
  aspirational (a fallback tier that isn't installed; a test script that doesn't exist). An
  untrue doc is worse than no doc.
- **Every invariant in `docs/` is cited from the code or config that could break it.**
  - Cite it with a one-line comment that names the doc and the key:
    `(docs/file-watching.md: rename-never-guessed)`.
  - Invariants are **named**, not numbered: each `## Invariants` bullet leads with a kebab-case key
    (`- **`rename-never-guessed`** — …`). Keys are kebab-case and unique within a doc; that is the
    only naming rule.
  - Nobody honours an invariant that the source does not cite. If no code site could break it, it
    is not an invariant: merge it, rephrase it or delete it.
  - Code and config count as citation sites; packaging invariants legitimately live in
    `.vscodeignore`, `webpack.config.js` or the workflow. A mention from another *doc*, from
    `scripts/` or from a test does not count.
  - **Mark every site the invariant names.** If its text says "reads *and* writes" or "Sharp *and*
    Jimp must agree", one citation leaves the other trap unmarked behind a green check.
  - `node scripts/check-invariants.mjs` enforces this (uncited key, dangling citation, duplicate
    key) and runs in CI.
- **A code comment is one line. If it does not fit, it belongs in `docs/`.** A paragraph in a source
  file drifts from the code and hides from a reader of the design. Leave a one-line comment that
  names the doc. In JSDoc, state the contract and do not narrate the rationale.
  `node scripts/comment-lint.mjs` enforces the rule in `src/` and `scripts/` and runs in CI; its
  header states the scope, the exemptions and why `test/` is exempt. `webpack.config.js` and
  `.github/` follow it by convention. Widening the gate to `test/` was declined on measurement: 192
  runs across 93 files, none the failure the rule prevents, against 10 in `scripts/`. **Gates shape
  agent behaviour; prose does not.** Close-out audits reported "comment-lint: n/a, scans only
  `src/`" and moved on, so a rule that must hold somewhere needs the checker to say so.

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point; registers the `openInCompare` command (which persists the selection as a session file) and the `.imagecompare` custom editor; prunes old generated session files on activation
- **`sessionFile.ts`** - Session file parsing/validation, label application, session file name suggestion
- **`watcherLogic.ts`** - Helpers for the file-watching subsystem — rename disambiguation, index re-shifting on removal, natural-order row insertion, and mode-aware modality insertion; unit-tested in `test/unit/watcherLogic.test.ts`
- **`pollPlan.ts`** - Poll-cycle decisions — barren-dir listing policy, snapshot name/fingerprint diffing, same-cycle rename pairing — shared by the provider's existence sweep and the standalone poll → `docs/file-watching.md`
- **`workPool.ts`** - The bounded priority pool every image read/decode is scheduled through, crop and PPTX export included → `docs/loading-architecture.md`
- **`transportBudget.ts`** - Backpressure for outbound image bytes — the pool orders *work*, this orders *bytes on the wire* so speculation cannot starve a remote session → `docs/loading-architecture.md`
- **`debugLog.ts`** - The `imageCompare.debug` sink — cached flags, an injected line sink, elapsed stamping and the byte/tier/throughput formatters → `docs/testing.md`, `docs/loading-architecture.md`
- **`debugChannel.ts`** - The extension's half of that sink: the "ImageCompare" `OutputChannel` and the config-change refresh → `docs/testing.md`
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading, PPTX export, crop handling
- **`webviewShell.ts`** - The webview's static HTML shell (styles + body), single source of truth for the production panel and the Playwright test harness (`test/webview/harness.ts`)
- **`fileService.ts`** - Directory/file scanning, mode detection, trie-based image matching across modalities → `docs/tuple-matching.md`
- **`thumbnailService.ts`** - Image processing (thumbnails, full-image loading, cropping) → `docs/image-backends.md`
- **`sharpLoader.ts`** - Dynamic Sharp loader with the "Unsupported CPU" workaround → `docs/image-backends.md`
- **`pngText.ts`** - PNG tEXt chunk reader/writer, CRC-32, and the crop-metadata wire format → `docs/crop-and-pptx.md`
- **`modalityNames.ts`** - Shortest-unique-tail naming of modality columns from directory paths → `docs/session-files.md`
- **`thumbPack.ts`** - The thumbnail packfile wire format (build/parse, uuid pairing) → `docs/image-backends.md`
- **`wireFormat.ts`** - Image payload normalization for extension→webview transfer → `docs/loading-architecture.md`
- **`resultsFile.ts`** - `results.txt` parse/serialize plus the persist flow (empty votes delete the file) → `docs/standalone.md`
- **`cropPlan.ts`** - `_cropNN` output naming, crop-rect scale/clamp, and which of a folder's loose images its enumeration keeps (`enumeratedImages`, shared with the sharing script) → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`cropFlow.ts`** - The whole crop sequence (`performCrop` — one name, relative rect, per-modality render/inject/write, arrivals, `cropComplete`, thumbnails) over per-product IO → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`pptxDeck.ts`** - PPTX slide selection, parent/crop pairing and layout over an injected IO, `comparison_NN` export-file numbering, and the export flow (`exportDeck` — name, build, save, exactly one answer) over per-product IO → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`prefetchPlan.ts`** - What a prefetch wave speculates on — the tuple band `prefetchCount` names, the on-screen modality column plus the nearest siblings (reusing `tupleLoadPlan`'s own rule), and the column-major issue order → `docs/loading-architecture.md`
- **`sweepAimPolicy.ts`** - Where the open-time sweep aims and when that moves — the raw `setCurrentTuple` stream trailing-edge dwelled into a settled tuple, the strip un-permuted into a column, over host-supplied timer primitives; shared, so neither product can dwell differently → `docs/loading-architecture.md`, `docs/standalone.md`
- **`thumbnailPlan.ts`** - Open-time thumbnail-sweep planning and running (slot order, missing slots, progress ticks, sweep wire traffic over injected IO) → `docs/loading-architecture.md`, `docs/standalone.md`
- **`imageServe.ts`** - Full-image serving — passthrough-vs-convert branch, payload normalization, the single terminal reply, and the current-tuple refresh loop → `docs/loading-architecture.md`, `docs/standalone.md`
- **`initPayload.ts`** - `init`-message assembly (dense tuples, positional color defaults, winners record, product version for the help modal) → `docs/standalone.md`
- **`arrivalPlan.ts`** - New-file placement (slot-fill vs new tuple, shifts, wire payloads) for provider watcher arrivals and standalone crop writes → `docs/file-watching.md`, `docs/standalone.md`
- **`adoptionPlan.ts`** - Modality-dir adoption decisions (which dirs qualify, the imageful gate, the column-insert mutations and `modalityAdded` payload), shared by the provider's three detectors and the standalone poll → `docs/file-watching.md`, `docs/standalone.md`
- **`removalPlan.ts`** - The tuple-delete sequence (step order, emptied columns, re-save points) and the whole delete flow (per-file disk deletes before the live-index re-plan), executed by both products through injected IO → `docs/file-watching.md`, `docs/standalone.md`
- **`imageMime.ts`** - The passthrough-mime table → `docs/image-backends.md`
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces and message types
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation, floating panel, winner voting)
- **`webview/emptyNotice.ts`** - What an emptied comparison says instead of drawing — the terminal notice, and the folder-gone wording → `docs/loading-architecture.md`
- **`webview/modalityVisibility.ts`** - Hidden-pill keyboard-cycling target selection → `docs/session-files.md`
- **`webview/axisScroll.ts`** - The one rule every scrollable axis obeys — centre the selection (optionally snapped to the item pitch), clamp to the content — plus what a wheel notch is worth with Alt held, linear and multiplicative → `docs/loading-architecture.md`
- **`webview/columnWindow.ts`** - Which modality columns a row materializes for the horizontal viewport, the ring size that holds them, and where each one sits — the column axis's half of the carousel's virtualization → `docs/loading-architecture.md`
- **`webview/contextMenuModel.ts`** - Which items the comparison's context menu offers for a target, given the host's `HostCapabilities`, plus the help text derived from the same model → `docs/standalone.md`, `docs/session-files.md`
- **`webview/contextMenu.ts`** - The menu's DOM only: positioning, dismissal, click routing — it renders what the model returns → `docs/standalone.md`
- **`webview/noticeChannel.ts`** - The wording of what the user is told after a host action, and whether a reveal action rides along → `docs/standalone.md`
- **`webview/tupleLoadPlan.ts`** - What a tuple arrival requests — visible-now vs dwell-gated siblings, distance order, nearest-two split — and `ColumnReportGate`, when a column move is reported (a pick at once, a key on the same debounce) → `docs/loading-architecture.md`
- **`webview/pillReorder.ts`** - What a pill move does to every display index (`movedIndex` — a move, not a swap), the slot a lifted pill drops into (`dropSlot`) and how far each other pill slides meanwhile (`slotShift`) → `docs/pointer-input.md`
- **`webview/viewState.ts`** - A published page's saved view — built by name from the current state, and planned back onto the comparison as it lists now (`planRestore`) → `docs/standalone.md`
- **`webview/pillDrag.ts`** - The pill row's pointer gestures: mouse drag, touch hold-then-drag, the row's own pan and fling, the tap click, the one commit on the drop → `docs/pointer-input.md`
- **`webview/touchInput.ts`** - The touch layout's image and strip gestures (swipe, hold-to-flip, pinch, strip drag) and its context-menu suppression; each gesture calls an action a key already takes → `docs/pointer-input.md`
- **`webview/crop.ts`** - Crop mode module (rectangle drawing, resize handles, coordinate mapping)
- **`standalone/adapter.ts`** (+ `standalone/shims/`, `standalone/compose.mjs`) - Browser IO backend + protocol host that reuses the real webview bundle and pure modules to build the single-file standalone page → `docs/standalone.md`
- **`standalone/publishedPath.ts`** - The one rule for a published listing path, read by the page's manifest parser and by the sharing script's staging check → `docs/standalone.md`
- **`standalone/hostRegimes.ts`** - The hosting-regime table a published comparison's `host` names — the capability flags the page states and the publish limits the sharing script enforces → `docs/standalone.md`
- **`standalone/viewerLayer.ts`** - The per-viewer writable layer over a published comparison (listed files read-only, the viewer's votes and crops in IndexedDB, namespaced by the comparison's URL directory; the store is injected) → `docs/standalone.md`
- **`standalone/packedThumbs.ts`** - The packed-thumbnails format (parse, never-failing load, split within a byte limit) and the strip's thumbnail size, shared by the page and the sharing script → `docs/standalone.md`
- **`standalone/sharePlan.ts`** (+ `standalone/shareNodeIo.ts`, `scripts/share-comparison.mjs`) - The sharing script: layout per input shape, the regime's limit checks, thumbs packing and publish batches over injected IO (`sharePlan`), the node fs + sharp IO (`shareNodeIo`), argument parsing and printing (the script) → `docs/standalone.md`

## Design docs (`docs/`)

Subsystems whose design is **non-obvious** get a doc; each *subsystem* doc ends in an Invariants
section listing what a change must not break (`testing.md` is a process doc, not a subsystem one, and
has none). Read one on demand — don't load them preemptively.

| Doc | Read it when |
|---|---|
| `docs/loading-architecture.md` | Touching how images get on screen: the work pool, priorities, cancellation, prefetch, the thumbnail sweep, the existence poll, spinners/latency, or rendering (aspect ratio, zoom/pan, dimensions). **Read before "simplifying" any of it** — the pool and the async poll exist because their absence caused multi-second stalls. |
| `docs/session-files.md` | Touching how a comparison is opened: the `.imagecompare` format (`paths`/`labels`/`colors`), the three modes, the explorer-command vs CLI paths, session pruning, or where `results.txt` lands. |
| `docs/file-watching.md` | Touching how disk changes reach the view: the three detection mechanisms, rename detection, the `recentlyDeleted` window, or index re-shifting on add/remove. |
| `docs/tuple-matching.md` | Touching how files are grouped into tuples/modalities: the trie matcher, tie-breaks, crop deprioritization, modality naming/order, or the sparse-vs-dense and original-vs-display index traps. |
| `docs/image-backends.md` | Touching Sharp/Jimp/PPMX, `loadFullImage`, webpack externalization, or packaging. Documents which fallback tiers *actually* exist (not the aspirational chain) and why the CPU workaround is there. |
| `docs/crop-and-pptx.md` | Touching crop or PowerPoint export: the relative-coordinate contract, the dual EXIF+tEXt metadata write, the `_cropNN` filename contract, or parent/crop slide pairing. |
| `docs/pointer-input.md` | Touching how a mouse or finger drives the view beyond keys: dragging a pill to reorder (and what a reorder remaps), or the touch layout — its gating, the phone strip, the image gestures. **Read before trusting an emulated touch test** — the drag's worst bug was invisible to emulation. |
| `docs/standalone.md` | Touching the standalone browser build: `standalone/`, `scripts/build-standalone.mjs`, or any pure module the adapter shares with the provider (results format, crop plan, deck layout). |
| `docs/testing.md` | Adding or changing a test, or trusting one: the three layers, what each suite pins, the copy-trap history, what nothing covers, and the manual checks. |

Everything below is operating instructions — conventions, commands, release. Subsystem *design*
belongs in `docs/`, not here.

## Routine procedures (the catalogue)

The two canonical loops, in order — each step is a procedure below:
- **New feature** → `/implement-feature` (contract → docs/invariants + gray dashboard row *first* →
  implementer → bloat audit → adversarial verifier) → verification battery → (demo clip only if a
  new user-visible flow is worth showing).
- **Bug** → `/fix-issue` (formalize → adversarial build: failing test → minimal fix → docs → bloat
  audit when it is not tiny) → the
  new test joins the feature's existing `features.json` row (a new row only if the bug exposed an
  untracked feature) → verification battery.

Every recurring ritual lives in exactly one place; this list is the index. The split is
deliberate: **skills** are multi-step workflows an agent executes on demand with their own quality
gates; **CLAUDE.md sections** are checklists and ambient rules that must be in context for every
task. Don't convert a checklist into a skill unless it is invoked as a unit and has internal
verification steps.

| Procedure | Where |
|---|---|
| Classify a finished change and audit its obligations | CLAUDE.md → Change close-out |
| Verify after any change (the gate battery) | CLAUDE.md → Verification |
| Where a new test goes | CLAUDE.md → Testing (decision rule) |
| Growing the coverage dashboard | CLAUDE.md → Feature Coverage Dashboard |
| Release / publish | CLAUDE.md → Release Checklist |
| Local / remote install of a VSIX | CLAUDE.md → Install Locally |
| Manual pre-release walk | docs/testing.md → Manual checks |
| Audit docs against code | `/verify-docs` skill |
| Fix a reported bug end-to-end | `/fix-issue` skill |
| Implement a new feature end-to-end | `/implement-feature` skill |
| Cut the bloat the repo has accumulated | `/prune` skill |
| Open image comparisons programmatically | `/imagecompare` skill |
| Publish a comparison as a web page (Claude artifact, static host) | `/imagecompare-artifact` skill |

## Change close-out (mandatory)

The loops above describe the path; the close-out proves the path was walked. Before a unit of work
is committed or reported done, **classify it and audit the diff against the obligations of its
class**. The CI gates catch what *broke*; this step catches what was *omitted* — the missing
dashboard row, mutation entry, or doc update that no script can detect.

1. **Classify** the change — one or more of: **feature** (new user-visible behavior), **fix**
   (existing behavior corrected), **refactor** (behavior identical), **test-only**, **docs**,
   **infra** (CI/scripts/packaging). A mixed change takes the union of its classes' obligations.
2. **Obligations by class**:
   - *feature*: update the docs it invalidates (+ invariants, cited from code) · tests per the
     decision rule · mutation entry if invariant-grade · `features.json` row (gray if tests come
     later) · demo clip only if a new visible flow is worth showing.
   - *fix*: failing test first (`/fix-issue`) · test joins the feature's existing `features.json`
     row (new row only if the bug exposed an untracked feature) · docs only if the design changed.
   - *refactor*: no new obligations — but invariant citations must still resolve (checker enforces).
   - *test-only*: mutation entry (a test nothing can break is decoration) · dashboard mapping.
   - *docs*: every claim verifiable in code (else fix the code or delete the claim).
   - *infra*: nothing beyond the battery — but check whether a CLAUDE.md/docs claim about CI is now stale.
3. **Audit** — for any change touching `src/` or `test/`, dispatch a **subagent that did not write
   the change**, giving it the diff, the classification, and the obligation list. It must return a
   verdict per obligation: **done** / **n/a because <reason>** / **MISSING**. Fix every MISSING
   before committing. A change built through `/fix-issue` or `/implement-feature` already satisfies
   this — their `change-verifier` PASS *is* this audit; don't run a second one. For docs/infra-only
   changes an explicit inline walk of the list (stated in the final report) suffices — no subagent.
4. Run the **Verification** battery. State the classification and the audit verdicts in the report
   or commit message, so omissions are visible rather than silent.

## Agent Skills

Skills live once under `skills/<name>/SKILL.md` and are symlinked into each tool's discovery path
(`.claude/skills/`, `.agents/skills/`). **Before adding or editing a skill, read
`skills/README.md`** — do not create a skill directly under `.claude/skills/`, or it won't be shared
with Codex/other tools and the symlink convention breaks.

## Development

```bash
npm install          # Install dependencies
npm run watch        # Watch mode (rebuilds on changes)
npm run compile      # One-off build
npm run build:standalone  # Single-file browser build → dist/standalone/image_compare.html (docs/standalone.md)
# Press F5 in VSCode to launch Extension Development Host
```

## Testing

One runner: Vitest. `npm test` runs the whole unit layer (`test/unit/`, via
`test/vitest.config.ts`), and CI gates the build on it; `test:unit` is an alias of the same run.
What each suite pins, what nothing covers, the manual checks worth walking before a release, and
`imageCompare.debug` logging: `docs/testing.md`.

The unit layer is Layer 1 of the multi-layer testing bed described in
**[docs/testing.md](docs/testing.md)** (runs in its own CI workflow, `.github/workflows/test.yml`):

```bash
npm run test:unit         # Layer 1 — Vitest, pure logic on real code (fast)
npm run test:webview      # Layer 3 — Playwright drives the real webview bundle
                          #           out-of-process (run `npm run compile` first)
npm run test:integration  # Layer 2 — @vscode/test-cli inside a real VSCode
npm run test:all          # everything
```

**Where a new test goes** (decision rule, in order; prefer the lowest layer that can reproduce the
behaviour):
1. Webview DOM/interaction behavior → a Playwright spec in `test/webview/` (drive via
   `loadInited`/`__ic_send`, assert via `window.__ic_test` and locators).
2. Real VS Code API behavior (fs scanning, commands, activation) → `test/integration/`.
3. Pure logic → Vitest in `test/unit/` importing the real module. An invariant-grade rule whose
   silent breakage corrupts data or violates a documented contract additionally gets a mutation
   entry in `scripts/mutation-check.mjs`, because only that harness proves the test bites. Matcher
   tests go in `test/unit/`, importing the real `matchTuplesWithTrie` — full stop.
Demos (`test/demos/`) are not tests: add one only when a new user-visible flow is worth a gallery
clip; bug fixes need a test, never a demo.

### Verification — run all of these after any change

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.webview.json && npx tsc --noEmit -p tsconfig.test.json
npm test                            # the Vitest unit layer (test/unit/)
node scripts/check-invariants.mjs   # every docs/ invariant cited from code, every citation resolves
node scripts/comment-lint.mjs       # no multi-line // blocks in src/ or scripts/ (test/ exempt)
node scripts/check-sidedness.mjs    # module sidedness from real imports; no dead src/ modules; no host hand-building a shared runner's injected decision
node scripts/check-generated-output.mjs  # generators write only into ignored dirs (nothing to `git add .`)
node scripts/mutation-check.mjs     # the suites actually fail when the rules they pin are broken
npm run compile                     # both webpack targets
```

Which CI job runs which gate, and the gaps: docs/testing.md, "The three layers".

**Running the mutation harness.** It must run to completion and report its **own** exit status.
Never signal it, never `pkill` it — the pattern matches your own shell, which is how a run was once
orphaned onto SIGHUP — and never attach a tool deadline that can cut it: a full run is ~10 minutes
and sits right at the 600 s agent tool ceiling, so it is over the line as often as under. Launch it
detached, await its completion marker, and read the status it recorded. A run that was cut is **not**
a pass: the `Mutations: N killed: K` summary and the only exit-0 path are both after the loop, so a
truncated run prints no verdict at all. A `MUTATION_CHECK_TEST` subset run is never the gate — it
says so itself and exits 2.

**A green suite is not evidence.** When you add a test, break the code it covers and watch it fail —
this suite has passed with a tie-break inverted and with the row sort reversed. Pin values that come
from outside the implementation; comparing the code to itself proves nothing. See `docs/testing.md`.

### Feature Coverage Dashboard

`test/dashboard/features.json` maps every feature (keyboard, tools, crop, zoom,
backend) to the test(s) that cover it. The generator runs all suites with JSON
reporters and lights each feature green/red/gray from **real** results:

```bash
npm run test:dashboard        # run all suites + regenerate
npm run test:dashboard:reuse  # regenerate from the last run's JSON
open test/dashboard/dashboard.html   # generated, not versioned
```

Untested features show as gaps (not false-green), lit from real test results.

**Growing the dashboard** (do this whenever a feature or test is added):
1. Add or find the feature's entry in `test/dashboard/features.json` — an area → feature row with a
   stable `id`, a display `name`, and `tests: [{suite: unit|webview|integration, match: <substring
   of the test title>}]`. An empty `tests` array is legitimate: it renders gray, an honest gap —
   add the feature row *before* its tests exist so the gap is visible rather than invisible.
2. When the test lands, point `match` at a distinctive substring of its title (a `describe`/`it`
   string for unit, spec title for webview, mocha title for integration).
3. `npm run test:dashboard` and check the feature turned green — a `match` that matches nothing
   when its suite ran **fails the generator (and CI)**, so a stale mapping cannot merge silently.
4. Nothing else to update: CI republishes the live dashboard from `features.json` + real results on
   every main push (Pages).

### Feature Demos

`npm run test:demos` records a captioned clip per demo and builds `test/demos/gallery/index.html`
(docs/testing.md, "Viewing the generated reports").

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions.

- **A tag** runs one gating job, `test-full`, before anything is packaged. `test-full` is
  `uses: ./.github/workflows/test.yml`. It runs the `gates` battery and the whole three-OS matrix,
  so a tag cannot publish a build that fails on Windows. Then `build` makes one VSIX per platform
  target. `build` needs an `if:` because a PR skips `test-full`. An `if:` replaces the implicit
  `success()`, so the `if:` refuses a gate that failed or was cancelled.
- **A pull request builds every target and publishes nothing**
  (`docs/image-backends.md: pull-request-builds-never-publish`). The same ten-leg `build` job and
  the `codium-smoke` install check run on `pull_request`, so a packaging defect surfaces on the PR,
  not at the tag. The `publish` and `verify-openvsx` jobs are gated off by event, a fork PR
  included. A PR skips `test-full` because test.yml already runs on the PR. A PR costs eleven jobs
  here (ten legs and the smoke check) and duplicates nothing.
- **Superseded PR runs are cancelled**; a tag run never is.

The runner need not match the target. Each build installs the target's Sharp binaries with
`npm install --os/--cpu`, so the ARM64 Linux and Windows targets cross-compile on x64 runners.

### Release Checklist (for Claude)

**A release starts on a branch and is tagged only once CI is green.** Never bump-commit-tag in one
pass on `main`.

What a premature tag costs is a **public tag pointing at a commit that fails CI**, and a burned
version number: recovering means deleting a pushed tag or skipping to the next patch. The branch
step turns that into an ordinary red build on a branch nobody has released from. Since a pull
request now builds all ten VSIXes with the same recipe, the packaging half of a release is proven
before the tag too — which removes a *surprise*, not the rule: the cost above is unchanged, and a
branch with no PR open has still had none of it checked.

When the user asks to "release" or "prepare a release":

1. **Work on a branch**, never directly on `main`. If the work is already on one, stay there.
2. **Read the current version** from `package.json` — the baseline.
3. **Bump the version** in `package.json` **and `package-lock.json`**. Patch for fixes; minor when
   behaviour changed or anything user-visible was added. Sync the lockfile with
   `npm install --package-lock-only` and check the diff is the **two root version fields and
   nothing else** — the command will also re-resolve dependencies if the lockfile is stale, and a
   dependency bump has no business riding into a release PR. **Gated**: `test.yml`'s
   `gates` job fails when the two disagree.
4. **Update `CHANGELOG.md`** — a `## [X.Y.Z]` section covering everything since the last tag
   (`git log`, `git diff` against it).
5. **Run the full local battery** (Verification, above). `npm run test:integration` cannot run on a
   box with no X server — say so rather than reporting it passed.
6. **Commit and push the branch, then open the pull request.** Do NOT tag yet. **The PR is what
   starts CI**, not the push: `test.yml`'s push trigger is branch-limited (`main` and `test/**`), so
   pushing a branch named anything else — `release/0.4.1`, `fix/…` — starts *no run at all*, and a
   checks page with nothing red is indistinguishable from one that is green. Opening the PR runs
   `test.yml` (`gates`, `engines-floor`, the three-OS `test` matrix) *and* `publish.yml`'s ten-leg
   build on the tag's own packaging recipe, so both halves of a release — the suites and the VSIXes —
   are proven before the tag. (Naming the branch `test/…` also triggers on push, but then a PR runs
   everything twice; open the PR.)
7. **Wait for CI on the PR to go green.** **This is the step that exists because the local battery
   is Linux-only**: a Windows-only defect is invisible until this runs, and one shipped undetected
   for several releases precisely this way — see the Findings list in docs/testing.md. Silence is not
   success: no checks on the PR means no run happened, which is a red flag, not a green one.
8. **Fix anything red and push again.** Repeat until green. A release is not "nearly ready" while
   any platform is red.
9. **Merge to `main`** once green.
10. **Tag and push the tag** from `main` — `git tag vX.Y.Z && git push --tags`. This is what
    triggers `publish.yml`, and it is the first irreversible step: it publishes to the VS Code
    Marketplace and Open VSX, neither of which lets you unpublish a version cleanly.

**Tagging is a separate, explicit instruction.** "Push the branch" does not authorise a tag; ask, or
wait to be told.

### Release Checklist (manual verification after CI)

11. **Verify the publish run** — green builds on all 10 matrix legs (nine platform targets plus universal).
12. **Verify both marketplaces** — the new version live on VS Code Marketplace and Open VSX.

### What the CI does for each platform

Per-target recipe (install, prune, wasm32 extract, package, VSIX scan):
`.github/workflows/publish.yml`, explained in docs/image-backends.md.

### Required GitHub Secrets

Add these in your repo's Settings → Secrets → Actions:
- `OVSX_TOKEN` - Open VSX personal access token
- `VSCE_TOKEN` - VS Code Marketplace personal access token

### Manual publish

You can also trigger the workflow manually from the GitHub Actions tab → "Publish Extension" → "Run workflow".

## Building

### Local Build (current platform only)

```bash
npm run compile                              # Compile TypeScript via webpack
vsce package                                 # Create .vsix package
```

### Install Locally

```bash
code --install-extension image-compare-X.Y.Z.vsix --force   # or: cursor --install-extension ...
```
Then **reload the window** — the extension host keeps the old code until you do.

**On a remote/SSH host `code` is not on PATH.** Use the server's own CLI (no IPC needed):
```bash
SRV=$(ls -d ~/.vscode-server/cli/servers/*/server | tail -1)
"$SRV/bin/code-server" --install-extension /path/to/image-compare-X.Y.Z.vsix --force
```

Four rules, each learned by breaking the install:

1. **Never interrupt it** — no `timeout`, no Ctrl-C, no tool-level deadline. It untars ~130 files
   including two ~17 MB libvips tiers; over a network mount that can exceed two minutes. A kill
   mid-extract leaves a half-written `<id>.vsctmp` staging directory *and* has already removed the
   previous version, so you are left with no working extension. Run it in the background and wait.
2. **Version every local install as `<next-patch>-alphaN`** with `npm run alpha -- <N>`; increment
   only N. Reinstalling the loaded version is refused ("Please restart VS Code before reinstalling")
   even with `--force`. The next-patch base matters both ways: an alpha of the current version
   auto-updates back to the marketplace build, and a bare bumped patch outranks the next real
   release. The script header says what it builds, why the bump stays, and `--restore`.
3. **Copy the `.vsix` to local disk first** (e.g. `/tmp`). Installing straight off a network mount is
   what makes rule 1 bite.
4. **Interrupted leftovers can be unremovable until the window reloads.** The running extension host
   holds the old libvips `.so` files open; on NFS, deleting an open file leaves `.nfsXXXX`
   placeholders that `rm -rf` cannot clear ("Device or resource busy"), and the surviving `.vsctmp`
   makes every later install fail with a bare `code: 'Internal'`. Check with
   `find ~/.vscode-server/extensions -name '.nfs*'`. Either reload the window to release the handles,
   or install under a fresh version number so the installer never touches the poisoned path.

**Recovering from an interrupted install** (rule 1 above): the kill leaves only a `.vsctmp` staging
dir while `extensions.json` still points at the now-missing path, so the extension survives in memory
but vanishes on reload, and the CLI then refuses to reinstall. Extract the VSIX by hand into the path
`extensions.json` expects — it is a zip whose `extension/` contents are the extension directory, plus
`extension.vsixmanifest` renamed to `.vsixmanifest`. Preserve permission bits, then reload.

### Supported Platforms

| Target | Description |
|--------|-------------|
| `win32-x64` | Windows 64-bit |
| `win32-arm64` | Windows ARM64 |
| `linux-x64` | Linux 64-bit |
| `linux-arm64` | Linux ARM64 |
| `darwin-x64` | macOS Intel |
| `darwin-arm64` | macOS Apple Silicon |
| `alpine-x64` | musl libc, 64-bit — Alpine and slim container images |
| `alpine-arm64` | musl libc, ARM64 |
| `linux-armhf` | 32-bit ARM (npm calls this cpu `arm`, not `armhf`) |
| *(universal)* | no native Sharp: WASM tier, then the Jimp backstop. The floor for any host with no build of its own |

### Package Size

How to measure a VSIX, and what a size change means: docs/image-backends.md, "Nine platform targets,
and a universal one underneath".
