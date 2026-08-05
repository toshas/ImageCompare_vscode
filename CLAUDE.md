# ImageCompare VSCode Extension - Development Guide

## Git Commit Rules

- Never add Co-Authored-By lines to commits.

## Documentation Rules

Document **invariants and non-obvious "why"** — not mechanics the code already states. A list of
message types or keyboard shortcuts rots and adds nothing; "the poll must never be synchronous" or
"crop refs are deprioritized so they never steal matches" is what saves the next person.

- **Plans are disposable, decisions are durable.** Delete an implementation plan once executed —
  it describes intent, some of which always changes, and a reader can't tell intent from truth.
  Fold anything durable (the diagnosis, the invariants) into the relevant `docs/` file.
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
  of 2+ consecutive `//` lines fails) and runs in CI. It reads only `src/**/*.ts`: `src/test/` is
  exempt, since a comment explaining why a fixture triggers an edge case is correctly co-located with
  the fixture, and `scripts/`, `webpack.config.js` and `.github/` are outside its scope entirely — the
  rule there is convention, not a gate. Banner (`// ----`) and directive (`// eslint-`, `// @ts-`)
  runs are exempt too.

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point; registers the `openInCompare` command (which persists the selection as a session file) and the `.imagecompare` custom editor; prunes old generated session files on activation
- **`sessionFile.ts`** - Pure helpers (no vscode dependency): session file parsing/validation, label application, session file name suggestion
- **`watcherLogic.ts`** - Pure helpers (no vscode dependency) for the file-watching subsystem: `matchDeletedFile` (rename disambiguation) and `shiftIndexAfterRemoval` (index re-indexing on tuple/modality removal), unit-tested in `src/test/watcherLogic.test.ts`
- **`workPool.ts`** - Pure: the bounded priority pool every image read/decode is scheduled through, crop and PPTX export included → `docs/loading-architecture.md`
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading, PPTX export, crop handling
- **`fileService.ts`** - Directory/file scanning, mode detection, trie-based image matching across modalities → `docs/tuple-matching.md`
- **`thumbnailService.ts`** - Image processing (thumbnails, full-image loading, cropping) → `docs/image-backends.md`
- **`sharpLoader.ts`** - Dynamic Sharp loader with the "Unsupported CPU" workaround → `docs/image-backends.md`
- **`pngText.ts`** - Pure (no vscode dependency): PNG tEXt chunk reader/writer, CRC-32, and the crop-metadata wire format → `docs/crop-and-pptx.md`
- **`modalityNames.ts`** - Pure (no vscode dependency): shortest-unique-tail naming of modality columns from directory paths → `docs/session-files.md`
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces and message types
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation, floating panel, winner voting)
- **`webview/modalityVisibility.ts`** - Pure (no vscode/DOM): hidden-pill keyboard-cycling target selection → `docs/session-files.md`
- **`webview/crop.ts`** - Crop mode module (rectangle drawing, resize handles, coordinate mapping)

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
| `docs/testing.md` | Adding or changing a test, or trusting one: what each suite pins, the one suite that still tests a *copy* of the shipped code, what nothing covers, and the manual checks. |

Everything below is operating instructions — conventions, commands, release. Subsystem *design*
belongs in `docs/`, not here.

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
# Press F5 in VSCode to launch Extension Development Host
```

## Testing

Seven `ts-node` suites, no framework. `npm test` runs them, and CI gates the build on it; the `test`
script in `package.json` is the list CI executes, and `docs/testing.md` repeats it only to show the
per-suite invocation. What each suite pins, what nothing covers, the manual checks worth walking
before a release, and `imageCompare.debug` logging: `docs/testing.md`.

### Verification — run all of these after any change

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.webview.json
npm test                            # the suites listed in package.json
node scripts/check-invariants.mjs   # every docs/ invariant cited from code, every citation resolves
node scripts/comment-lint.mjs       # no multi-line // blocks in production code
node scripts/mutation-check.mjs     # the suites actually fail when the rules they pin are broken
npm run compile                     # both webpack targets
```

CI's `test` job (`.github/workflows/publish.yml`) runs all of these but the first: compile, the two
checker scripts, the suites, the mutation check. There is **no `tsc --noEmit` step**. Type errors
still turn CI red today — ts-loader type-checks both tsconfigs during `npm run compile`, `ts-node`
type-checks each suite, and between them every `src/` file is covered — but that is a side effect of
two other steps, so a file neither bundles nor a suite imports would go unchecked in CI. Adding a
test means also adding its mutation to `scripts/mutation-check.mjs` — a test nothing can break is
decoration. To audit the docs against the code (drift a script cannot see), use the `verify-docs`
skill.

**`tupleMatching` tests a *copy* of the matching functions, not the functions** — `modalityNames.ts`
is the exception, imported from the shipped source. Change the matcher in `fileService.ts` and update
the copy in the same edit, or the suite passes while pinning code that no longer exists.
`pngTextChunk` used to be a copy too — that is exactly how a crop-breaking bug shipped green. Prefer
extracting pure logic (`pngText.ts`, `watcherLogic.ts`, `workPool.ts`, `modalityNames.ts`) over
copying it.

**A green suite is not evidence.** When you add a test, break the code it covers and watch it fail —
this suite has passed with a tie-break inverted and with the row sort reversed. Pin values that come
from outside the implementation; comparing the code to itself proves nothing. See `docs/testing.md`.

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions. The workflow first runs the `test` job (ubuntu) — compile, both checker scripts, the suites, the mutation check — then builds one VSIX per platform target. The runner need not match the target — each build installs the target's Sharp binaries with `npm install --os/--cpu` — so the ARM64 Linux and Windows targets cross-compile on x64 runners.

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
2. **Bump the version for every local install.** Reinstalling the version the window currently has
   loaded is refused ("Please restart VS Code before reinstalling"), and `--force` does not lift it.
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
