# ImageCompare VSCode Extension - Development Guide

## Architecture Overview

This is a VSCode extension for comparing multiple images with multiple modalities.

### Key Components

- **`extension.ts`** - Entry point, registers commands
- **`imageCompareProvider.ts`** - Main provider managing WebView panels, file watching, image loading
- **`fileService.ts`** - Directory/file scanning, mode detection, image matching across modalities
- **`thumbnailService.ts`** - Background thumbnail generation using Sharp (native libvips)
- **`ppmxParser.ts`** - Custom float32 grayscale image format parser
- **`types.ts`** - Shared TypeScript interfaces
- **`webview/main.ts`** - WebView UI (carousel, zoom/pan, keyboard navigation)

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
# Press F5 in VSCode to launch Extension Development Host
```

## Publishing (GitHub Actions)

Publishing is automated via GitHub Actions. The workflow builds on native runners for each platform.

### Steps to publish a new version:

1. **Update version in package.json** (before committing your changes):
   ```bash
   npm version patch   # 0.1.2 -> 0.1.3
   # or manually edit package.json
   ```

2. **Commit all changes** (including the version bump):
   ```bash
   git add .
   git commit -m "Release v0.1.3"
   git push
   ```

3. **Create and push a tag** (this triggers the publish workflow):
   ```bash
   git tag v0.1.3
   git push --tags
   ```

The workflow will automatically build for all 6 platforms and publish to both Open VSX and VS Code Marketplace.

### Required GitHub Secrets

Add these in your repo's Settings → Secrets → Actions:
- `OVSX_TOKEN` - Open VSX personal access token
- `VSCE_TOKEN` - VS Code Marketplace personal access token

### Manual publish

You can also trigger the workflow manually from the GitHub Actions tab → "Publish Extension" → "Run workflow".

## Building

### Local Build (current platform only)

```bash
npm run compile                              # Compile TypeScript
vsce package --allow-missing-repository      # Create .vsix package
```

The output will be `image-compare-0.1.1.vsix` in the project root.

### Install Locally

```bash
code --install-extension image-compare-0.1.1.vsix
# Or for Cursor:
cursor --install-extension image-compare-0.1.1.vsix
```

## Publishing

### Prerequisites

```bash
npm install -g @vscode/vsce    # Install vsce CLI globally
vsce login <publisher-name>    # Login to VS Code Marketplace (needs PAT token)
```

### Cross-Platform Publishing (Required for Sharp native module)

Since this extension uses Sharp (native libvips bindings), you must publish platform-specific builds:

```bash
# Build and publish for all major platforms
vsce publish --target win32-x64 win32-arm64 linux-x64 linux-arm64 darwin-x64 darwin-arm64

# Or build packages without publishing (for testing)
vsce package --target win32-x64
vsce package --target win32-arm64
vsce package --target linux-x64
vsce package --target linux-arm64
vsce package --target darwin-x64
vsce package --target darwin-arm64
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
| `alpine-x64` | Alpine Linux (musl) |

### Version Bump

Before publishing a new version:

```bash
npm version patch   # 0.1.0 -> 0.1.1
npm version minor   # 0.1.0 -> 0.2.0
npm version major   # 0.1.0 -> 1.0.0
```

### Full Publish Workflow

```bash
npm version patch                           # Bump version
npm run compile                             # Ensure it compiles
vsce publish --target win32-x64 win32-arm64 linux-x64 linux-arm64 darwin-x64 darwin-arm64
```

## Native Module Notes (Sharp)

This extension uses **Sharp** for image processing, which includes native binaries (libvips).

### Key Files

- **`webpack.config.js`**: Sharp is externalized (`externals: { sharp: 'commonjs sharp' }`) so it's loaded at runtime, not bundled
- **`.vscodeignore`**: Sharp and its dependencies (`@img/*`, `detect-libc`, `semver`) are explicitly included in the package

### Local Development

When switching between platforms (e.g., testing on both Mac and Linux), you may need to reinstall Sharp:

```bash
npm rebuild sharp
# Or full reinstall:
rm -rf node_modules && npm install
```

### Package Size

The VSIX is ~7-8 MB due to Sharp's native libvips binaries. This is normal for native image processing extensions.

## Testing Considerations

When testing file watching:
1. Test all three modes with file add/delete/modify operations
2. Test rename detection (quick delete+create)
3. Test partial tuples (some modalities missing images)
4. Test with remote filesystems (SSH, WSL)
