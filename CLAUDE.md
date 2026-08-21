# ImageCompare VSCode Extension - Development Guide

## Git Commit Rules

- Never add Co-Authored-By lines to commits.

## Documentation Rules

Document **invariants and non-obvious "why"** — not mechanics the code already states. A list of
message types or keyboard shortcuts rots and adds nothing; "the poll must never be synchronous" or
"crop refs are deprioritized so they never steal matches" is what saves the next person.

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
- **Every invariant in `docs/` is referenced from the code or config that could break it**, by a one-line
  comment naming the doc and the invariant's key: `(docs/file-watching.md: rename-never-guessed)`.
  Invariants are **named**, not numbered — each `## Invariants` bullet leads with a kebab-case key
  (`- **`rename-never-guessed`** — …`). A key never renumbers, so deleting an invariant just breaks a
  link the checker catches, reordering is free, and the slug means something to a reader where a
  number didn't. An invariant you cannot reach from the source is one nobody will honour — read once
  at design time, never at the moment someone is about to violate it; if no code site could break it,
  it is not an invariant, so merge/rephrase/delete it. A mention from another *doc*, from `scripts/`, or from a test does not count
  as coverage. Packaging invariants legitimately live in `.vscodeignore`, `webpack.config.js` or the
  workflow — those count. **Mark every site the invariant names**: if its text says "reads *and*
  writes" or "Sharp *and* Jimp must agree", one citation leaves the other trap unmarked behind a green
  check. `node scripts/check-invariants.mjs` enforces this (uncited key, dangling citation, duplicate
  key) and runs in CI. Keys are kebab-case and unique within a doc; that is the only naming rule.
- **A code comment is one line. If it doesn't fit, it belongs in `docs/`.** Not a style preference: a
  paragraph in a source file is documentation hiding where nobody maintains it, it drifts from the
  code beside it, and it is invisible to anyone reading the design. Put the explanation in the
  relevant `docs/` file and leave a one-line comment — ideally naming the doc. Applies to JSDoc too:
  state the contract, don't narrate the rationale. `node scripts/comment-lint.mjs` enforces it (a run
  of 2+ consecutive `//` lines fails) and runs in CI. It reads `src/**/*.ts` **and**
  `scripts/**/*.{mjs,js}` — the gate scripts are held to the rule they gate. `test/` is exempt **on
  its merits, not by an accident of scope**: a comment explaining why a fixture triggers an edge case
  is correctly co-located with the fixture, and the rule exists to keep *production* code from
  carrying design prose that belongs in `docs/`. `webpack.config.js` and `.github/` stay outside —
  convention there, not a gate. Exempt in both scanned scopes: banner (`// ----`) and directive
  (`// eslint-`, `// @ts-`) runs. Exempt in `scripts/` **only**: the leading file-header block — the
  `//` run starting at the file's first non-shebang, non-blank line and ending at the first
  non-comment line, nothing else that is merely near the top. A gate script's header documents the
  file, and `docs/` describes subsystems, not individual scripts, so it has no better home; `src/`
  files say that in `/** */` JSDoc instead and so keep the plain threshold with no header carve-out.
  The checker never looks inside `/** */` at all — deliberate, and stated in its own header, so the
  "state the contract, don't narrate" half of the rule is review-enforced rather than gated.
  Widening the gate to `test/` was **considered and declined** on measurement: 192 runs across 93
  files, none of them the failure the rule exists to prevent, against 10 in `scripts/`. The reason
  the scope matters at all is the diagnosis that produced this gate — **gates shape agent behaviour;
  prose does not.** A rule expressed as a scoped gate is obeyed exactly to its scope: close-out
  audits correctly reported "comment-lint: n/a, scans only `src/`" and moved on, and no amount of
  wording here changed that. If a rule should hold somewhere, the *checker* has to say so.

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point; registers the `openInCompare` command (which persists the selection as a session file) and the `.imagecompare` custom editor; prunes old generated session files on activation
- **`sessionFile.ts`** - Pure helpers (no vscode dependency): session file parsing/validation, label application, session file name suggestion
- **`watcherLogic.ts`** - Pure helpers (no vscode dependency) for the file-watching subsystem — rename disambiguation, index re-shifting on removal, natural-order row insertion, and mode-aware modality insertion; unit-tested in `test/unit/watcherLogic.test.ts`
- **`pollPlan.ts`** - Pure (no vscode dependency): poll-cycle decisions — barren-dir listing policy, snapshot name/fingerprint diffing, same-cycle rename pairing — shared by the provider's existence sweep and the standalone poll → `docs/file-watching.md`
- **`workPool.ts`** - Pure: the bounded priority pool every image read/decode is scheduled through, crop and PPTX export included → `docs/loading-architecture.md`
- **`transportBudget.ts`** - Pure (extension-only): backpressure for outbound image bytes — the pool orders *work*, this orders *bytes on the wire* so speculation cannot starve a remote session → `docs/loading-architecture.md`
- **`debugLog.ts`** - Pure (no vscode dependency): the `imageCompare.debug` sink — cached flags, an injected line sink, elapsed stamping and the byte/tier/throughput formatters; shared with the standalone build → `docs/testing.md`, `docs/loading-architecture.md`
- **`debugChannel.ts`** - The extension's half of that sink: the "ImageCompare" `OutputChannel` and the config-change refresh → `docs/testing.md`
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading, PPTX export, crop handling
- **`webviewShell.ts`** - The webview's static HTML shell (styles + body), single source of truth for the production panel and the Playwright test harness (`test/webview/harness.ts`)
- **`fileService.ts`** - Directory/file scanning, mode detection, trie-based image matching across modalities → `docs/tuple-matching.md`
- **`thumbnailService.ts`** - Image processing (thumbnails, full-image loading, cropping) → `docs/image-backends.md`
- **`sharpLoader.ts`** - Dynamic Sharp loader with the "Unsupported CPU" workaround → `docs/image-backends.md`
- **`pngText.ts`** - Pure (no vscode dependency): PNG tEXt chunk reader/writer, CRC-32, and the crop-metadata wire format → `docs/crop-and-pptx.md`
- **`modalityNames.ts`** - Pure (no vscode dependency): shortest-unique-tail naming of modality columns from directory paths → `docs/session-files.md`
- **`thumbPack.ts`** - Pure (no vscode dependency): the thumbnail packfile wire format (build/parse, uuid pairing) → `docs/image-backends.md`
- **`wireFormat.ts`** - Pure (no vscode dependency): image payload normalization for extension→webview transfer → `docs/loading-architecture.md`
- **`resultsFile.ts`** - Pure (no vscode dependency): `results.txt` parse/serialize plus the persist flow (empty votes delete the file), shared with the standalone build → `docs/standalone.md`
- **`cropPlan.ts`** - Pure (no vscode dependency): `_cropNN` output naming and crop-rect scale/clamp → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`cropFlow.ts`** - Pure (no vscode dependency): the whole crop sequence (`performCrop` — one name, relative rect, per-modality render/inject/write, arrivals, `cropComplete`, thumbnails) over per-product IO, shared with the standalone build → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`pptxDeck.ts`** - Pure (no vscode dependency): PPTX slide selection, parent/crop pairing and layout over an injected IO, `comparison_NN` export-file numbering, and the export flow (`exportDeck` — name, build, save, exactly one answer) over per-product IO → `docs/crop-and-pptx.md`, `docs/standalone.md`
- **`prefetchPlan.ts`** - Pure (extension-only, no vscode): what a prefetch wave speculates on — the
  tuple band `prefetchCount` names, the on-screen modality column plus the nearest siblings (reusing
  `tupleLoadPlan`'s own rule), and the column-major issue order → `docs/loading-architecture.md`
- **`sweepAimPolicy.ts`** - Pure (no vscode/DOM): where the open-time sweep aims and when that moves — the raw `setCurrentTuple` stream trailing-edge dwelled into a settled tuple, the strip un-permuted into a column, over host-supplied timer primitives; shared, so neither product can dwell differently → `docs/loading-architecture.md`, `docs/standalone.md`
- **`thumbnailPlan.ts`** - Pure (no vscode dependency): open-time thumbnail-sweep planning and running (slot order, missing slots, progress ticks, sweep wire traffic over injected IO), shared with the standalone build → `docs/loading-architecture.md`, `docs/standalone.md`
- **`imageServe.ts`** - Pure (no vscode dependency): full-image serving — passthrough-vs-convert branch, payload normalization, the single terminal reply, and the current-tuple refresh loop — shared with the standalone build → `docs/loading-architecture.md`, `docs/standalone.md`
- **`initPayload.ts`** - Pure (no vscode dependency): `init`-message assembly (dense tuples, positional color defaults, winners record, product version for the help modal), shared with the standalone build → `docs/standalone.md`
- **`arrivalPlan.ts`** - Pure (no vscode dependency): new-file placement (slot-fill vs new tuple, shifts, wire payloads) for provider watcher arrivals and standalone crop writes → `docs/file-watching.md`, `docs/standalone.md`
- **`adoptionPlan.ts`** - Pure (no vscode dependency): modality-dir adoption decisions (which dirs qualify, the imageful gate, the column-insert mutations and `modalityAdded` payload), shared by the provider's three detectors and the standalone poll → `docs/file-watching.md`, `docs/standalone.md`
- **`removalPlan.ts`** - Pure (no vscode dependency): the tuple-delete sequence (step order, emptied columns, re-save points) and the whole delete flow (per-file disk deletes before the live-index re-plan), executed by both products through injected IO → `docs/file-watching.md`, `docs/standalone.md`
- **`imageMime.ts`** - Pure (no vscode dependency): the passthrough-mime table → `docs/image-backends.md`
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces and message types
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation, floating panel, winner voting)
- **`webview/modalityVisibility.ts`** - Pure (no vscode/DOM): hidden-pill keyboard-cycling target selection → `docs/session-files.md`
- **`webview/tupleLoadPlan.ts`** - Pure (no vscode/DOM): what a tuple arrival requests — visible-now vs dwell-gated siblings, distance order, nearest-two split → `docs/loading-architecture.md`
- **`webview/crop.ts`** - Crop mode module (rectangle drawing, resize handles, coordinate mapping)
- **`standalone/adapter.ts`** (+ `standalone/shims/`, `standalone/compose.mjs`) - Browser IO backend + protocol host that reuses the real webview bundle and pure modules to build the single-file standalone page → `docs/standalone.md`

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
| `docs/standalone.md` | Touching the standalone browser build: `standalone/`, `scripts/build-standalone.mjs`, or any pure module the adapter shares with the provider (results format, crop plan, deck layout). |
| `docs/testing.md` | Adding or changing a test, or trusting one: the three layers, what each suite pins, the copy-trap history, what nothing covers, and the manual checks. |

Everything below is operating instructions — conventions, commands, release. Subsystem *design*
belongs in `docs/`, not here.

## Routine procedures (the catalogue)

The two canonical loops, in order — each step is a procedure below:
- **New feature** → `/implement-feature` (contract → docs/invariants + gray dashboard row *first* →
  adversarial implementer/verifier build) → verification battery → (demo clip only if a new
  user-visible flow is worth showing).
- **Bug** → `/fix-issue` (formalize → adversarial build: failing test → minimal fix → docs) → the
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
| Open image comparisons programmatically | `/imagecompare` skill |

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

**Where a new test goes** (decision rule, in order):
1. Webview DOM/interaction behavior → a Playwright spec in `test/webview/` (drive via
   `loadInited`/`__ic_send`, assert via `window.__ic_test` and locators).
2. Real VS Code API behavior (fs scanning, commands, activation) → `test/integration/`.
3. Pure logic → Vitest in `test/unit/` importing the real module. An invariant-grade rule whose
   silent breakage corrupts data or violates a documented contract additionally gets a mutation
   entry in `scripts/mutation-check.mjs`, because only that harness proves the test bites. Matcher
   tests go in `test/unit/`, importing the real `matchTuplesWithTrie` — full stop.
Demos (`test/demos/`) are not tests: add one only when a new user-visible flow is worth a gallery
clip; bug fixes need a test, never a demo.

- **Layer 1** (`test/unit/`) imports real production functions via a `vscode` mock
  alias (`test/mocks/vscode.ts`); no hand-copied logic.
- **Layer 3** (`test/webview/`) loads the real `dist/webview.js` against a harness
  that reuses the production shell (`src/webviewShell.ts`) and stubs
  `acquireVsCodeApi`. Specs assert via the `window.__ic_test` state hook —
  deterministic logic checks (no pixel snapshots), so the layer runs in CI on all
  three OSes. See docs/testing.md.
- **Layer 2** (`test/integration/`) exercises vscode-API-coupled code (e.g.
  `scanForImages`) on temp fixtures.

### Verification — run all of these after any change

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.webview.json
npm test                            # the Vitest unit layer (test/unit/)
node scripts/check-invariants.mjs   # every docs/ invariant cited from code, every citation resolves
node scripts/comment-lint.mjs       # no multi-line // blocks in src/ or scripts/ (test/ exempt)
node scripts/check-sidedness.mjs    # module sidedness from real imports; no dead src/ modules; no host hand-building a shared runner's injected decision
node scripts/check-generated-output.mjs  # generators write only into ignored dirs (nothing to `git add .`)
node scripts/mutation-check.mjs     # the suites actually fail when the rules they pin are broken
npm run compile                     # both webpack targets
```

**Running the mutation harness.** It must run to completion and report its **own** exit status.
Never signal it, never `pkill` it — the pattern matches your own shell, which is how a run was once
orphaned onto SIGHUP — and never attach a tool deadline that can cut it: a full run is ~10 minutes
and sits right at the 600 s agent tool ceiling, so it is over the line as often as under. Launch it
detached, await its completion marker, and read the status it recorded. A run that was cut is **not**
a pass: the `Mutations: N killed: K` summary and the only exit-0 path are both after the loop, so a
truncated run prints no verdict at all. A `MUTATION_CHECK_TEST` subset run is never the gate — it
says so itself and exits 2.

CI's `test` job (`.github/workflows/publish.yml`) runs all of these but the first: compile, the four
checker scripts, the suites, the mutation check. (`check-no-personal-refs.mjs` is a fifth checker but
runs only in the pre-commit hook — it needs the gitignored `.words-to-check.txt`.) The `gates` job in `test.yml` runs all three
`tsc --noEmit` configs (src, webview, and `tsconfig.test.json` for `test/`) on every push/PR; the publish-path `test` job still has **no `tsc --noEmit`
step** of its own — there, `src/` type errors surface only because ts-loader type-checks during
`npm run compile`, so a `src/` file no bundle reaches would go unchecked on that path. Vitest itself
transpiles with esbuild and type-checks nothing; `tsconfig.test.json` in the gates job is what
catches test-file type errors. Adding a test means also adding its mutation to `scripts/mutation-check.mjs` — a test
nothing can break is decoration. To audit the docs against the code (drift a script cannot see), use the `verify-docs`
skill.

**The copy era is over.** `tupleMatching` and `pngTextChunk` were once ts-node suites testing
hand-copies of the shipped functions — that is exactly how a crop-breaking bug shipped green. Both
are now Vitest suites in `test/unit/` importing the real code (`matchTuplesWithTrie`/`scanForImages`
from `fileService.ts`, `modalityNames.ts`, `pngText.ts`) via the `vscode` mock alias, so they cannot
drift. For `vscode`-free logic, prefer extracting a pure module (`pngText.ts`, `watcherLogic.ts`,
`workPool.ts`, `modalityNames.ts`) over ever copying it.

**A green suite is not evidence.** When you add a test, break the code it covers and watch it fail —
this suite has passed with a tie-break inverted and with the row sort reversed. Pin values that come
from outside the implementation; comparing the code to itself proves nothing. See `docs/testing.md`.

> The **Layer 1** Vitest tests in `test/unit/` (`tupleMatching.test.ts`,
> `pngTextChunk.test.ts`) are the *only* pinning for the matcher and the PNG
> tEXt writer — the old ts-node copies are deleted, and the mutation gate kills
> every suite through `vitest run`. Run with `npm test`.

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

`test/demos/` records a short, captioned clip of each feature being used (on
real photo fixtures from `test/fixtures/images/`, processed into fake CV
modalities by `test/demos/photoFixtures.ts`), via Playwright → ffmpeg → small
H.264 MP4 (plays in every browser incl. Safari and VS Code's preview).
The gallery builds to `test/demos/gallery/index.html` (generated, not versioned; every CI run also uploads it as the `demo-gallery` artifact).

```bash
npm run test:demos            # record + rebuild the gallery
open test/demos/gallery/index.html   # after running test:demos, or download the CI artifact
```

Note: the `<video>` gallery plays in a browser, not inline in GitHub markdown.

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions. The workflow first runs the `test` job (ubuntu) — compile, the four checker scripts, the suites, the mutation check — then builds one VSIX per platform target. The runner need not match the target — each build installs the target's Sharp binaries with `npm install --os/--cpu` — so the ARM64 Linux and Windows targets cross-compile on x64 runners.

### Release Checklist (for Claude)

When the user asks to "release" or "prepare a release", perform ALL of the following steps automatically:

1. **Read current version** from `package.json` — this is the baseline
2. **Bump version** — increment patch version in `package.json` (e.g., 0.1.8 → 0.1.9)
3. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z]` section describing all changes since the last release (check `git log` and `git diff` against the last tag)
4. **Compile and verify** — `npm run compile` must succeed with no errors
5. **Commit all changes** (version bump + changelog + code):
   ```bash
   git add package.json CHANGELOG.md src/ ...
   git commit -m "Release vX.Y.Z - short description"
   git push
   ```
6. **Create and push a tag** (this triggers the CI publish workflow):
   ```bash
   git tag vX.Y.Z
   git push --tags
   ```

### Release Checklist (manual verification after CI)

7. **Verify CI** — check GitHub Actions for green builds on all 6 platforms
8. **Verify marketplace listings** — confirm the new version appears on both VS Code Marketplace and Open VSX

The workflow will automatically build for all 6 platforms and publish to both Open VSX and VS Code Marketplace.

### What the CI does for each platform

1. `npm ci` — installs all dependencies (including jimp, which webpack will bundle)
2. Removes native Sharp, reinstalls for target platform (`--os=X --cpu=Y`)
3. Installs `@img/sharp-wasm32` via `npm pack` + extract — the WASM fallback for older CPUs.
   **This is the only way the tier ships**: npm always skips the `optionalDependencies` entry, so a
   locally built VSIX has no WASM at all. The step order here is load-bearing; step 6 is what catches
   you if you get it wrong. See `docs/image-backends.md`
4. Installs `@emnapi/runtime` (WASM runtime dependency)
5. Runs `npx vsce package --target <platform>` which triggers webpack (bundles Jimp into `dist/extension.js`)
6. **Verifies the WASM fallback is in the VSIX** — scans the packed zip's entry names for
   `@img/sharp-wasm32/lib/sharp-wasm32.node.wasm` and `@emnapi/runtime/`, and fails the build if
   either is missing. This is the artifact check for steps 3-4; it does *not* cover the rest of the
   `.vscodeignore` un-ignore list (`docs/image-backends.md`)
7. Uploads the VSIX as artifact `vsix-<target>`; the `publish` job downloads all six and pushes each
   to Open VSX and the Marketplace

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
2. **Version every local install as `<next-patch>-alphaN`** (repo at 0.3.0 → local builds are
   `0.3.1-alpha1`, `-alpha2`, …; increment only N, in the packaging step, never committed).
   Reinstalling the version the window currently has loaded is refused ("Please restart VS Code
   before reinstalling") and `--force` does not lift it, so every install needs a fresh N. The
   *next-patch* base is load-bearing, both ways: semver puts `-alphaN` below its base release, so
   an alpha of the *current* version would be silently auto-updated back to the marketplace build,
   and a bare bumped patch (the old convention) outranks the next real release so auto-update
   never delivers it. `vsce package` accepts the suffix. **Use `npm run alpha -- <N>`** — it bumps
   `package.json` (the single version source: the provider reads it at runtime, the standalone
   stamps it at build time) and builds VSIX + standalone in one window so the pair always agree.
   The bump then STAYS in the working tree for the whole testing period — a transient bump loses
   the race against test-driven rebuilds, which re-stamp the base version (learned when an alpha
   install shipped beside a stale `v0.3.0` standalone twice in one day). `npm run alpha -- --restore`
   reverts before committing; the CI gates job fails on any committed prerelease version, so a
   forgotten restore cannot ship.
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

### Package Size

Almost all of it is libvips, and everything else is rounding error. On Linux, Sharp splits
`libvips-cpp.so` by libc — glibc *and* musl, ~17 MB each uncompressed — so two land in a single
Linux VSIX; macOS ships one per arch and Windows has no separate `@img/sharp-libvips-win32-*` at all
(the binary lives inside the platform package). `dist/extension.js` (Jimp bundled in) is under 1 MB.
A CI build adds the wasm32 tier on top; a locally built VSIX has no WASM at all (see Publishing
above).

Don't trust a size quoted here — measure the artifact: `ls -la *.vsix`, `unzip -l <vsix> | sort -rn`
for what actually costs. The rule to hold on to: if a VSIX grows or shrinks by more than ~1 MB and
you did not add a native dependency, a libvips tier was added or dropped — check that before
believing the build is fine.
