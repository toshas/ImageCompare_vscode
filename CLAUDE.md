# ImageCompare VSCode Extension - Development Guide

## Git Commit Rules

- Never add Co-Authored-By lines to commits.

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point, registers commands
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading
- **`fileService.ts`** - Directory/file scanning, mode detection, image matching across modalities
- **`thumbnailService.ts`** - Image processing (thumbnail generation, full image loading) with fallback chain
- **`sharpLoader.ts`** - Dynamic Sharp loader with native → WASM → Jimp fallback
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation)

## Image Processing Backends

The extension uses a three-tier fallback chain for image processing (resize, encode, metadata):

### 1. Sharp Native (fastest)
Default on modern CPUs. Uses libvips native binaries. Sharp is **externalized** in webpack (`externals: { sharp: 'commonjs sharp' }`) and loaded at runtime from `node_modules/`.

### 2. Sharp WASM (fast, fallback for older CPUs)
Sharp's native binaries require x86-64-v2 (SSE4.2+). On older CPUs, the native `@img/sharp-linux-x64` package is *present* but fails with "Unsupported CPU". Sharp only auto-falls back to WASM when the native package is completely *absent*.

**`sharpLoader.ts`** works around this: on "Unsupported CPU" error, it clears the require cache, monkey-patches `Module._resolveFilename` to block native `@img/sharp-*` resolution, and retries — forcing Sharp to discover only `@img/sharp-wasm32`.

### 3. Jimp (slowest, guaranteed to work)
Pure JavaScript image processing library. Used when both Sharp native and WASM fail. Jimp is **bundled** by webpack (not externalized) since it has no native dependencies. Loaded lazily — only `require()`'d when Sharp is unavailable, so there's zero cost on the happy path.

### Key Design Decisions
- Sharp is externalized in webpack; Jimp is bundled (pure JS, ~1.4MB in bundle)
- Jimp is lazy-loaded via dynamic `require('jimp').Jimp` (not a static import)
- PPMX handling is shared via `createSharpInstance()` / `createJimpImage()` helpers
- Jimp JPEG quality is set to 70 to match Sharp's thumbnail output
- Sharp pipelines are safe to reuse (`.metadata()` then `.png().toBuffer()` on same instance) — Sharp re-reads from the input buffer internally
- A warning notification is shown to the user when running on the Jimp fallback

### Files involved
- **`sharpLoader.ts`** — `getSharp()` returns the Sharp module or `null`; `getSharpError()` returns the reason
- **`thumbnailService.ts`** — calls `getSharp()`, falls back to `this.getJimp()`, shared helpers for PPMX
- **`webpack.config.js`** — Sharp externalized, Jimp bundled
- **`.vscodeignore`** — Sharp + `@img/*` + `@emnapi/*` explicitly included; Jimp is in the webpack bundle so not listed
- **`.github/workflows/publish.yml`** — CI installs both native Sharp binaries AND `@img/sharp-wasm32` for each platform

## Three Operation Modes

The extension supports three ways to open images for comparison:

### Mode 1: Single Directory with Subdirectories
**Trigger**: Right-click on a single directory containing 2+ subdirectories with images

```
selected_folder/
├── modality_a/
│   ├── image001_suffix.png
│   └── image002_suffix.png
└── modality_b/
    ├── image001_differentsuffix.png
    └── image002_differentsuffix.png
```

- Each subdirectory becomes a modality
- Images matched by filename across modalities
- `baseUri` is set to the selected directory
- File watcher monitors all subdirectories

### Mode 2: Multiple Directories Selected
**Trigger**: Select 2+ directories (can be in different paths) and right-click

```
/path/to/folder_a/     <- becomes modality "folder_a"
├── modality_a/
│   ├── image001_suffix.png
│   └── image002_suffix.png
/different/path/folder_b/   <- becomes modality "folder_b"
    ├── image001_differentsuffix.png
    └── image002_differentsuffix.png
```

- Each selected directory becomes a modality (using directory name)
- Images matched by filename across directories
- `modalityDirs` map tracks modality → directory URI
- Multiple file watchers (one per directory)

### Mode 3: Multiple Image Files Selected
**Trigger**: Select 2+ image files and right-click

- Creates a single tuple with selected images
- Modality names derived from filename differences
- No directory structure to track
- File watchers monitor parent directories of selected files

### Invalid: Single Directory with Only Files
**Prevented**: Opening a single directory that contains only image files (no subdirectories) is **not allowed**. This would create a nonsensical comparison with each file as a separate "modality".

User should instead:
- Use a directory with subdirectories (mode 1)
- Select multiple directories (mode 2)
- Select specific files to compare (mode 3)

## Filesystem Event Handling

The extension watches for file changes and updates the view dynamically.

### Events by Mode

| Event | Mode 1 | Mode 2 | Mode 3 |
|-------|--------|--------|--------|
| **File deleted** | ✅ Marks slot as deleted | ✅ Marks slot as deleted | ✅ Marks slot as deleted |
| **File created (restore)** | ✅ Restores if URI matches | ✅ Restores if URI matches | ✅ Restores if URI matches |
| **File renamed** | ✅ Detected via delete+create | ✅ Detected via delete+create | ✅ Detected via delete+create |
| **File modified** | ✅ Reloads image | ✅ Reloads image | ✅ Reloads image |
| **New file added** | ✅ Adds to existing/new tuple | ✅ Adds to existing tuple | ❌ Not supported |
| **New modality dir** | ✅ Creates new modality | ❌ N/A (dirs fixed at open) | ❌ N/A |
| **Modality dir deleted** | ✅ Removes modality | ✅ Removes modality | ❌ N/A |

### Implementation Details

**Rename Detection**: When a file is deleted, it's tracked in `recentlyDeleted` for 500ms. If a create event follows in the same directory, it's treated as a rename rather than delete+create.

**Multiple Watchers**: For mode 2, separate `FileSystemWatcher` instances are created for each directory since VS Code's glob patterns can't span unrelated paths.

**State Tracking**:
- `baseUri`: Set in mode 1 (single directory), undefined otherwise
- `modalityDirs`: Map populated in mode 2, empty otherwise
- `watchedDirs`: Set of all directory paths being watched

## WebView Communication

Messages flow between extension and webview via `postMessage`:

**Extension → WebView**:
- `init`: Initial data (tuples, modalities, config, winners, votingEnabled)
- `thumbnail`/`thumbnailError`: Thumbnail data
- `image`/`imageError`: Full image data
- `fileDeleted`/`fileRestored`: File state changes
- `tupleDeleted`/`tupleAdded`: Tuple changes
- `modalityAdded`/`modalityRemoved`: Modality changes
- `winnerUpdated`/`winnersReset`: Winner state changes

**WebView → Extension**:
- `ready`: WebView initialized
- `requestThumbnails`: Request thumbnail batch
- `requestImage`: Request full image
- `navigateTo`: Jump to tuple
- `setCurrentTuple`: Update current position
- `setWinner`: Set or clear winner for a tuple

## Winner Voting

Available only in directory-based modes (mode 1 and 2). Allows declaring one modality as the "winner" for each tuple.

### User Interaction
- **Enter key**: Toggle winner for current tuple/modality
- **Click circle**: Small circle appears on top-right of each carousel thumbnail
  - Semi-transparent gray = no winner
  - Green with white outline = winner

### Persistence
Winners are saved to `results.txt` alongside modality folders:
```
# ImageCompare Results
# Generated: 2026-01-27T12:00:00.000Z
# Modalities: modA, modB, modC
#
# Format: tuple_key = winner_modality
# Delete a line to remove the vote, edit modality name to change vote

image001 = modA
image002 = modB
```

### Implementation
- `fileService.ts`: `readResultsFile()`, `writeResultsFile()`, `mapWinnersToIndices()`
- `imageCompareProvider.ts`: `PanelState.winners`, `PanelState.votingEnabled`, `handleSetWinner()`, `saveResults()`
- Winner indices are adjusted when modalities are added/removed

## Key Algorithms

### Image Matching (in `fileService.ts`)

Images are matched across modalities using `matchTuplesWithTrie()`:

1. **Reference modality**: Picks modality with most files as reference
2. **Trie construction**: Builds trie from reference filenames - each node tracks which files pass through it
3. **LCP matching**: For each file in other modalities, walks trie to find longest common prefix (LCP)
4. **LCS tie-breaking**: When multiple reference files share the same LCP, uses Longest Common Subsequence (LCS) to pick best match

Complexity: O(N × L) for trie operations, O(ties × L²) for LCS tie-breaking

This handles:
- Different naming conventions across modalities (e.g., `img_00001_gt.png` matches `img_00001_pred_v2.png`)
- Missing files in some modalities (gracefully creates partial tuples)
- Single-file modalities (matches to best LCP/LCS candidate)
- Identifiers embedded in middle of filenames (LCS catches common substrings)

### Modality Naming

- **Mode 1 & 2**: Directory names become modality names
- **Mode 3**: Uses `findDifferingParts()` to extract unique portions of filenames

### Aspect Ratio Handling

Images with different aspect ratios are handled using **"contain" scaling**:
- Each image is scaled to fit within the viewport: `scale = Math.min(viewportW / imageW, viewportH / imageH)`
- Images maintain their original aspect ratio (no stretching/distortion)
- Different aspect ratios will display at different sizes
- Zoom and pan are synchronized across modality switches (position preserved)
- When switching modalities, if the new image has a different aspect ratio, the visible region may shift slightly

## Development

```bash
npm install          # Install dependencies
npm run watch        # Watch mode (rebuilds on changes)
npm run compile      # One-off build
# Press F5 in VSCode to launch Extension Development Host
```

## Testing

### Image Backend Tests

To verify the Sharp → WASM → Jimp fallback chain works, create a test script in the project root (it needs access to `node_modules/`):

```bash
# The test should exercise:
# 1. Sharp native — thumbnail + full image
# 2. Sharp WASM — block native @img/sharp-* via Module._resolveFilename, verify Sharp still loads
# 3. Jimp thumbnail — fromBuffer + scaleToFit + getBuffer('image/jpeg', {quality:70})
# 4. Jimp full image — fromBuffer + width/height + getBuffer('image/png')
# 5. Jimp PPMX — fromBitmap with RGBA buffer
# 6. Dimension consistency — Sharp and Jimp return same width/height
# 7. sharpLoader.ts — simulate "Unsupported CPU" error, verify WASM retry succeeds
# 8. Full fallback — verify Jimp works end-to-end when Sharp is null
node test_image_backends.js
```

To test sharpLoader.ts directly (not via webpack bundle), compile TypeScript to a temp dir first:
```bash
npx tsc --outDir /tmp/test_out --declaration --declarationMap --skipLibCheck
# Then require('/tmp/test_out/sharpLoader.js') in the test
```

### File Watching Tests

1. Test all three modes with file add/delete/modify operations
2. Test rename detection (quick delete+create)
3. Test partial tuples (some modalities missing images)
4. Test with remote filesystems (SSH, WSL)

### Debug Logging

Enable `imageCompare.debug` in VS Code settings to log file watcher events, polling results, and other diagnostics to the webview developer console (prefixed with `[IC-EXT]`).

```jsonc
// settings.json
"imageCompare.debug": true
```

Open the webview dev console via **Help > Toggle Developer Tools** (or `Cmd+Shift+I`), then look for `[IC-EXT]` messages. Events logged include:
- `onDidCreate` / `fs.watch` events (file system watcher activity)
- `poll delete detected` (polling-based deletion detection)
- `fs.watch setup OK` / `fs.watch error` (watcher initialization)
- Error details from `handleFileDeleted`, `handleFileCreated`, `handleFileChanged`

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions. The workflow builds on native runners for each platform.

### Release Checklist

Before publishing a new version, complete every item:

1. **Code changes are done and tested locally** (F5 in VSCode, manual QA)
2. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z]` section describing changes
3. **Bump version in `package.json`**:
   ```bash
   npm version patch   # 0.1.5 -> 0.1.6
   # or manually edit "version" in package.json
   ```
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
7. **Verify CI** — check GitHub Actions for green builds on all 6 platforms
8. **Verify marketplace listings** — confirm the new version appears on both VS Code Marketplace and Open VSX

The workflow will automatically build for all 6 platforms and publish to both Open VSX and VS Code Marketplace.

### What the CI does for each platform

1. `npm ci` — installs all dependencies (including jimp, which webpack will bundle)
2. Removes native Sharp, reinstalls for target platform (`--os=X --cpu=Y`)
3. Installs `@img/sharp-wasm32` via `npm pack` + extract (WASM fallback for older CPUs)
4. Installs `@emnapi/runtime` (WASM runtime dependency)
5. Runs `npx vsce package --target <platform>` which triggers webpack (bundles Jimp into `dist/extension.js`)

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
vsce package --allow-missing-repository      # Create .vsix package
```

### Install Locally

```bash
code --install-extension image-compare-X.Y.Z.vsix
# Or for Cursor:
cursor --install-extension image-compare-X.Y.Z.vsix
```

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

The VSIX is ~8-9 MB: Sharp native binaries (~7MB) + Jimp bundled in webpack (~1.4MB).

## Native Module Notes

### Sharp (externalized, in node_modules/)

- **`webpack.config.js`**: Sharp is externalized (`externals: { sharp: 'commonjs sharp' }`) — loaded at runtime, not bundled
- **`.vscodeignore`**: Sharp and its dependencies (`@img/*`, `@emnapi/*`, `detect-libc`, `semver`, `color*`, etc.) are explicitly included
- When switching between platforms locally, you may need `npm rebuild sharp` or `rm -rf node_modules && npm install`

### Jimp (bundled by webpack)

- Pure JavaScript — no native dependencies, so webpack can bundle it
- All ~27 `@jimp/*` sub-packages and their transitive deps are resolved by webpack at build time
- Not listed in `.vscodeignore` (it's inside `dist/extension.js`)
- Only loaded at runtime when Sharp is unavailable (lazy `require('jimp').Jimp`)
