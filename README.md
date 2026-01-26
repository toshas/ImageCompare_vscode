# ImageCompare VSCode Extension

Compare multiple images (tuples) with multiple modalities within VSCode.

## Features

- **Multi-Modality Comparison**: Compare 2+ images as a tuple (e.g., input/output/reference)
- **Batch Mode**: Select a folder with subdirectories - each subdirectory becomes a modality
- **Remote Support**: Works with VSCode Remote (SSH, WSL, Containers)
- **Flip Comparison**: Hold Space to flip between current and previous image
- **Zoom & Pan**: Mouse wheel to zoom, drag to pan
- **Carousel Navigation**: Visual thumbnail grid for navigating tuples
- **PPMX Format**: Support for custom float32 grayscale format
- **Background Thumbnails**: Thumbnails generated in background with progress indicator
- **Live File Watching**: Automatically updates when files are added, removed, or modified

## Usage

1. **Right-click on a directory** in the Explorer → "Open in ImageCompare"
   - If the directory contains 2+ subdirectories with images, each subdirectory becomes a modality
   - Otherwise, all images in the directory form a single tuple

2. **Select multiple directories** (from different paths) → Right-click → "Open in ImageCompare"
   - Each selected directory becomes a modality
   - Images are matched by filename across directories

3. **Select multiple image files** → Right-click → "Open in ImageCompare"
   - Selected images form a single tuple
   - Modality names derived from filename differences

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← → | Switch modality |
| ↑ ↓ | Previous/next tuple |
| Space (hold) | Flip to previous modality |
| 1-9 | Jump to modality N |
| [ ] | Reorder current modality |
| Scroll | Zoom in/out |
| Drag | Pan image |
| Esc | Reset zoom |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `imageCompare.thumbnailSize` | 100 | Size of thumbnails in carousel (px) |
| `imageCompare.prefetchCount` | 3 | Number of tuples to prefetch ahead/behind |
| `imageCompare.cacheMaxAgeDays` | 7 | Max age of cached thumbnails (days) |

## Supported Formats

PNG, JPG, JPEG, GIF, BMP, WebP, TIFF, TIF, PPMX

## Development

```bash
# Install dependencies
npm install

# Build (one-time)
npm run compile

# Watch mode (rebuilds on changes)
npm run watch

# Then press F5 in VSCode to launch Extension Development Host
```

## How It Works

- **Extension Host**: Runs on remote machine in SSH/Container scenarios
  - File discovery via `vscode.workspace.fs` (handles remote transparently)
  - Thumbnail generation using `jimp` (pure JavaScript, cross-platform)
  - Image prefetching (configurable tuples ahead/behind)

- **WebView**: Renders in VSCode
  - Adapted from original HTML-based ImageCompare tool
  - Communicates via `postMessage` API
  - Requests images/thumbnails on-demand
