# ImageCompare VSCode Extension - Development Guide

## Git Commit Rules

- Never add Co-Authored-By lines to commits.

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point, registers the `openInCompare` command
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading, PPTX export, crop handling
- **`fileService.ts`** - Directory/file scanning, mode detection, trie-based image matching across modalities
- **`thumbnailService.ts`** - Image processing (thumbnail generation, full image loading, cropping) with Sharp → WASM → Jimp fallback chain
- **`sharpLoader.ts`** - Dynamic Sharp loader with native → WASM fallback and CPU detection
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces and message types
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation, floating panel, winner voting)
- **`webview/crop.ts`** - Crop mode module (rectangle drawing, resize handles, coordinate mapping)

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
├── image001_suffix.png
└── image002_suffix.png
/different/path/folder_b/   <- becomes modality "folder_b"
├── image001_differentsuffix.png
└── image002_differentsuffix.png
```

- Each selected directory becomes a modality (using directory name)
- Images matched by filename across directories
- `modalityDirs` map tracks modality → directory URI
- Multiple file watchers (one per directory)
- If multiple directories share the same basename, parent path is appended for disambiguation

### Mode 3: Multiple Image Files Selected
**Trigger**: Select 2+ image files and right-click

- Creates a single tuple with selected images
- Modality names derived from filename differences via `findDifferingParts()`
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

**Polling-based Deletion**: In addition to VS Code's `FileSystemWatcher`, a polling mechanism detects deletions reliably on all filesystems (Google Drive, FUSE mounts, etc.).

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
- `thumbnailProgress`: Thumbnail generation progress
- `image`/`imageError`: Full image data
- `fileDeleted`/`fileRestored`: File state changes
- `tupleDeleted`/`tupleAdded`: Tuple changes
- `modalityAdded`/`modalityRemoved`: Modality changes
- `winnerUpdated`/`winnersReset`: Winner state changes
- `cropComplete`/`cropError`: Crop operation results
- `pptxComplete`/`pptxError`: PPTX export results
- `_debug`: Debug logging messages

**WebView → Extension**:
- `ready`: WebView initialized
- `requestThumbnails`: Request thumbnail batch
- `requestImage`: Request full image
- `navigateTo`: Jump to tuple
- `setCurrentTuple`: Update current position (cancels stale loads)
- `tupleFullyLoaded`: All images loaded (trigger prefetch)
- `setWinner`: Set or clear winner for a tuple
- `cropImages`: Crop all modalities at given rectangle coordinates
- `deleteTuple`: Delete current tuple files
- `exportPptx`: Export voted tuples to PowerPoint (includes `modalityOrder` for display order)
- `log`: Debug messages from webview

## WebView UI Structure

```
body
├── #loading (shown before init)
├── #viewer
│   ├── #carousel (left panel, scrollable grid of tuple thumbnails)
│   ├── #carousel-resize (drag handle)
│   ├── #progress-container (thumbnail loading progress bar)
│   ├── canvas#canvas (main image display)
│   ├── #image-loader (spinner during full image load)
│   ├── #floating-panel (navigator + tools)
│   │   ├── #fp-header (draggable, click to collapse)
│   │   └── #fp-body
│   │       ├── #fp-minimap (canvas + viewport rectangle)
│   │       └── #fp-actions (Crop, Delete, PPTX buttons)
│   └── [crop overlay - dynamically added in crop mode]
├── #info (status bar)
│   ├── #reorder-buttons ([ ] keys)
│   ├── #modality-selector (colored pills with tooltips)
│   ├── #status (tuple name + dimensions + zoom)
│   └── #help-btn (? → keyboard shortcut modal)
└── #help-modal
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Switch between modalities |
| `↑` `↓` | Previous/next tuple |
| `Space` (hold) | Flip to previous modality |
| `1-9` | Jump to modality N |
| `[` `]` | Reorder current modality left/right |
| `Enter` | Toggle winner for current modality |
| `Scroll` | Zoom in/out |
| `Drag` | Pan image |
| `C` | Toggle crop mode |
| `Esc` | Reset zoom / cancel crop |
| `Del` | Delete current tuple files |

### Floating Panel (Navigator)

Draggable, collapsible panel in the top-right corner:

- **Header**: "Tools" label + collapse button (▾/▸). Click to collapse, drag to reposition.
- **Minimap**: Always-visible thumbnail of the current image. When zoomed in, a magenta viewport rectangle shows the visible region.
- **Actions**: Three buttons — Crop, Delete, PPTX.

The minimap canvas starts at 160×100 to avoid size jumping during load. The viewport rectangle is hidden by default (`display: none`) and only shown when `zoom > 1.05`.

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

## Crop Tool

### User Flow
1. Press `C` or click "Crop" button → enters crop mode (cursor becomes crosshair)
2. Click+drag on image → draws green rectangle with 4 semi-transparent dim regions outside
3. Release → shows 8 resize handles (corners + edge midpoints) and confirm/cancel toolbar
4. Drag handles to resize (minimum 4×4 image pixels)
5. Drag inside rectangle to move it
6. Double-click cardinal handle (N/S/E/W) to snap rectangle to square
7. `Enter` or click "✓ Crop" → saves cropped images for all modalities
8. `Esc` or click "✗" → cancels

### Output
- Cropped files saved as `{basename}_cropNN.png` in the same directory as originals
- Auto-incremented numbering: scans for existing `_cropNN` files, uses max+1
- Crop metadata embedded in PNG for later use in PPTX export (see below)
- New files trigger file watcher → appear as new tuples in the carousel

### Coordinate Mapping
Crop coordinates are tracked in image-pixel space of the current modality:
```
baseScale = Math.min(viewerW / imgW, viewerH / imgH)
displayScale = baseScale * zoom
imageX = (screenX - viewerCenterX - panX) / displayScale + imgW / 2
imageY = (screenY - viewerCenterY - panY) / displayScale + imgH / 2
```

When saving, the pixel-space rect is converted to relative coordinates (0–1) based on the source image dimensions, then scaled to each modality's actual resolution. This handles modalities with different image sizes (e.g., 4K vs 1080p). The webview sends `srcWidth`/`srcHeight` alongside the crop rect in the `cropImages` message.

### Implementation
- **`webview/crop.ts`** — Crop mode state, overlay DOM, mouse/key handlers, coordinate conversion
- **`imageCompareProvider.ts`** — `handleCropImages()`, `getNextCropNumber()`, message handling
- **`thumbnailService.ts`** — `cropImage()` method (Sharp `.extract()` or Jimp `.crop()`)

## Crop Metadata (PNG tEXt Chunks)

Crop files embed their source coordinates for PPTX export callouts.

### Format
- **Keyword**: `ImageCompare:CropRect`
- **Value**: `x,y,w,h,srcW,srcH` (comma-separated integers)
  - `x, y` — crop rectangle top-left in source image pixels
  - `w, h` — crop rectangle dimensions
  - `srcW, srcH` — original source image dimensions

### Writing
- **Sharp path**: EXIF `ImageDescription` field via `.withMetadata({ exif: { IFD0: { ImageDescription: ... } } })` **plus** PNG `tEXt` chunk via `pngInjectText()` for cross-compatibility with the standalone HTML tool
- **Jimp path**: Manual PNG `tEXt` chunk injection via `pngInjectText()` — builds the chunk bytes (keyword + null + value + CRC32) and inserts before IEND

Both paths always produce a PNG tEXt chunk, ensuring crops are readable by both the VSCode extension and the standalone HTML tool.

### Reading (`readCropMetadata()`)
1. Try EXIF `ImageDescription` via Sharp (fast path when Sharp is available)
2. Fallback: Parse PNG `tEXt` chunks via `pngReadText()` (works for all writers)

Both `pngInjectText` and `pngReadText` are standalone functions in `thumbnailService.ts` that operate on raw PNG buffers. They scan PNG chunk structure properly (not hardcoded offsets).

## PPTX Export

Exports all voted tuples to a PowerPoint file. Triggered by the "PPTX" button in the floating panel.

### Layout
- 16:9 slides (10" × 5.625")
- One slide per modality per voted tuple
- Modalities appear in the user's display order (after `[]` key reordering)

### Caption Bar
- Semi-transparent gray bar (0.35" height) at the top of each slide
- Left-aligned: tuple name (bold, black, 10pt Arial)
- Right-aligned: modality name (bold, 10pt Arial)
  - Winner: green (#008800) with ✓ prefix
  - Non-winner: black

### Slide Types

**Simple (no crops)**: Full image "contain"-fit to the slide, centered. Also used when parent and crop are both voted (voted crops get their own slides).

**Voted crop tuple**: Automatically finds the parent tuple (strips `_cropNN` suffix) and creates a crop slide even if the parent wasn't voted for.

**Smart parent/crop logic**: When only parent is voted with exactly one crop child, auto-expands as crop slide. When parent and crop are both voted, parent becomes simple slide (crops handled separately).

**Crop slide layout**:
- Main area: cropped image fit to slide (bottom-anchored when shifted to avoid overlap)
- Bottom-right corner: small full image with red rectangle overlay showing crop region
- Non-overlapping: main image shifts left, thumbnail shrinks if needed, accepts overlap only for near-16:9 crops
- Crop region coordinates read from PNG tEXt metadata

### Image Loading
- All images converted to PNG base64 via Sharp (or raw base64 fallback)
- PPMX files handled via `parsePpmx()` → Sharp raw input

### Output
- Saved as `comparison_NN.pptx` in the parent directory of modality folders
- Auto-incremented numbering

## Key Algorithms

### Image Matching (in `fileService.ts`)

Images are matched across modalities using `matchTuplesWithTrie()`:

1. **Reference modality**: Picks modality with most files as reference
2. **Trie construction**: Builds trie from reference filenames - each node tracks which files pass through it
3. **Pass 1 - Exact matches**: Files with identical basenames across modalities are matched first (e.g., crop files with same name in all folders)
4. **Pass 2 - Fuzzy matches**: For remaining files, walks trie to find longest common prefix (LCP)
5. **Tie-breaking** (when multiple reference files share the same LCP):
   - Prefer non-crop reference over crop reference (`_crop\d+$` pattern)
   - Then prefer smaller length difference (`|refLen - queryLen|`)
   - Then prefer higher LCS (Longest Common Subsequence)

Complexity: O(N × L) for trie operations, O(ties × L²) for LCS tie-breaking

This handles:
- Different naming conventions across modalities (e.g., `img_00001_gt.png` matches `img_00001_pred_v2.png`)
- Missing files in some modalities (gracefully creates partial tuples)
- Single-file modalities (matches to best LCP/LCS candidate)
- Identifiers embedded in middle of filenames (LCS catches common substrings)
- **Crop files**: Original and cropped files coexist — crop references are explicitly deprioritized so they never steal matches from originals, regardless of query length

### Modality Naming

- **Mode 1 & 2**: Directory names become modality names (disambiguated with parent path if duplicates)
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

### Tuple Matching Tests

Run the standalone tuple matching tests:
```bash
npx ts-node src/test/tupleMatching.test.ts
```

These tests exercise `matchTuplesWithTrie()` logic with real-world filename patterns:
- **Test 1**: User tree with originals + crop01 files (5 modalities, 5 tuples)
- **Test 2**: Originals + crop01 + crop01_crop01 (nested crops)
- **Test 3**: Baseline (no crop files)
- **Test 4**: `_pred` should match `_gt`, not `_crop01` (equal lenDiff, prefer shorter ref)
- **Test 5**: Long modality name should match `_gt`, not `_crop01` (crop explicitly deprioritized)

The tests use pure TypeScript copies of the matching functions (no vscode dependency) for fast execution.

### PNG tEXt Chunk Tests

Run the PNG metadata injection/reading tests:
```bash
npx ts-node src/test/pngTextChunk.test.ts
```

Tests verify:
- Basic keyword/value round-trip injection and reading
- Crop metadata format (`x,y,w,h,srcW,srcH`) round-trip with parsing
- Missing/wrong keyword returns null
- Multiple tEXt chunks coexist independently
- PNG structure preserved (signature, IEND intact)
- Sharp validates modified PNGs (still a valid image)
- Large coordinate values

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

**Tuple Matching Debug** (appears in Output > Extension Host or Debug Console, prefixed with `[IC-MATCH]`):
- Modality list and file counts per modality
- Reference modality selection
- Pass 1: Exact matches (identical basenames)
- Pass 2: Fuzzy matches (LCP + LCS scoring, candidates, crop detection, final selection)
- Final tuple summary with any MISSING modalities highlighted

To debug tuple matching issues:
1. Enable `imageCompare.debug: true` in settings
2. Open the folder/files in ImageCompare
3. Check **Output > Extension Host** or **Debug Console** for `[IC-MATCH]` logs
4. Look for `MISSING:` entries in the final tuple summary to identify unmatched files

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions. The workflow builds on native runners for each platform.

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
