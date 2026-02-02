# Changelog

All notable changes to the ImageCompare extension will be documented in this file.

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
