# Changelog

All notable changes to the ImageCompare extension will be documented in this file.

## [0.1.7] - 2026

### Added
- **Crop tool**: Draw a rectangle on the image to crop all modalities at the same coordinates, saved as `_cropNN.png` files
- **Delete button**: Delete all files for the current tuple from the Tools panel
- **Floating Tools panel**: Draggable, collapsible panel with minimap, crop, and delete controls (click header to collapse, drag to move)
- **Polling-based file deletion detection**: Reliably detects file deletions on all filesystems including Google Drive/FUSE
- **Debug logging setting**: `imageCompare.debug` enables file watcher diagnostics in webview console

### Fixed
- **Tuple matching with crop files**: Two-pass matching (exact then fuzzy) prevents crop files from stealing matches
- **Winner re-indexing on tuple add/delete**: Voting annotations no longer shift to wrong tuples after crop or delete
- **results.txt persistence on deletion**: Winners file updates immediately when tuples or files are deleted
- **Duplicate file watcher events**: Fixed overlapping watchers in single-directory mode

## [0.1.6] - 2026

### Fixed
- **Sharp load failure on older CPUs**: Extension no longer crashes when Sharp native binaries fail (e.g., "Unsupported CPU: Prebuilt binaries for linux-x64 require v2 microarchitecture")

### Added
- **Three-tier image processing fallback**: Sharp native → Sharp WASM → Jimp (pure JS)
  - `sharpLoader.ts`: dynamic loader that retries with WASM when native Sharp fails
  - Jimp fallback: bundled pure-JS image library as last resort (slower but guaranteed to work)
  - Warning notification shown when running on the Jimp fallback
- **Jimp dependency**: Pure JavaScript image processing library (~1.4MB bundled by webpack)

## [0.1.5] - 2026

### Fixed
- **Cross-platform Sharp binaries**: Fixed native module loading on all platforms (Windows, Linux, macOS)
  - Platform-specific packages now correctly include the appropriate Sharp/libvips binaries

### Added
- **Cursor IDE support**: Extension now available on Open VSX for Cursor users

## [0.1.1] - 2026

### Added
- **Winner voting**: Declare a winner for each tuple in directory-based modes
  - Press Enter or click the circle on thumbnails to toggle winner
  - Winners are persisted to `results.txt` alongside modality folders
  - Win counts shown in parentheses after modality names in status bar
  - Human-readable and editable results file format

### Changed
- **Tuple matching**: Replaced regex-based `extractMatchingKey()` with trie-based `matchTuplesWithTrie()` algorithm
  - Uses longest common prefix (LCP) for efficient matching via trie
  - Falls back to longest common subsequence (LCS) for tie-breaking

## [0.1.0] - 2026

### Added
- Multi-modality image comparison (compare 2+ images)
- Batch mode: select a folder with subdirectories, each becomes a modality
- Remote support: works with VSCode Remote
- Flip comparison: hold Space to flip between current and previous image
- Zoom and pan: mouse wheel to zoom, drag to pan
- Carousel navigation with visual thumbnail grid
- Background thumbnail generation with progress indicator
- Keyboard shortcuts for efficient navigation
- Configurable thumbnail size, prefetch count, and cache settings
