# ImageCompare

[![GitHub Stars](https://img.shields.io/github/stars/toshas/ImageCompare_vscode?label=GitHub%20%E2%98%85&logo=github&color=C8C)](https://github.com/toshas/ImageCompare_vscode)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/obukhovai.image-compare?label=VS%20Code%20Marketplace&color=006600)](https://marketplace.visualstudio.com/items?itemName=obukhovai.image-compare)
[![Cursor, VSCodium, Windsurf](https://img.shields.io/open-vsx/v/obukhovai/image-compare?label=Cursor%2C%20VSCodium%2C%20Windsurf&color=006600)](https://open-vsx.org/extension/obukhovai/image-compare)
[![Website](https://img.shields.io/badge/%E2%99%A5%20Author%20-Website-blue)](https://www.obukhov.ai)
[![Subscribe for updates!](https://img.shields.io/twitter/follow/antonobukhov1?label=Subscribe%20for%20updates!)](https://x.com/antonobukhov1)

**Flip between image variants instantly** — perfect for reviewing ML model outputs, A/B testing designs, or comparing renders across different settings. View one image at a time and switch between modalities with a keypress. Zoom and pan stay locked when switching, so you can compare fine details at any magnification.

![ImageCompare Demo](https://raw.githubusercontent.com/toshas/ImageCompare_vscode/main/demo.gif)

## Why ImageCompare?

- **Instant Flip Comparison** — Hold Space to flip between images. See differences that static side-by-side views miss.
- **Batch Processing** — Load hundreds of image tuples at once. Navigate with arrow keys.
- **Smart Matching** — Automatically matches images across folders by filename, even with different suffixes.
- **Crop & Export** — Crop regions across all modalities, export voted comparisons to PowerPoint.
- **Winner Voting** — Mark the best result for each comparison. Results saved to a simple text file.
- **Remote Ready** — Works seamlessly over SSH, WSL, and Dev Containers.

## Installation

**VS Code**: Search for "ImageCompare" in Extensions (`Ctrl+Shift+X`)

**Cursor**: Search for "ImageCompare" in Extensions (uses Open VSX)

## Quick Start

### Compare Folders

Right-click a folder containing subfolders → **"Open in ImageCompare"**

```
my_experiment/
├── ground_truth/    → modality 1
├── model_v1/        → modality 2
└── model_v2/        → modality 3
```

Each subfolder becomes a modality. Images are matched by filename.

### Compare Specific Files

Select 2+ image files → Right-click → **"Open in ImageCompare"**

### Compare Folders from Different Locations

Select multiple folders (Ctrl+Click) → Right-click → **"Open in ImageCompare"**

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Switch between modalities |
| `↑` `↓` | Previous / next image tuple |
| `Space` (hold) | Flip to previous modality |
| `1-9` | Jump to modality N |
| `Enter` | Mark current modality as winner |
| `[` `]` | Reorder modalities |
| `Scroll` | Zoom in/out |
| `Drag` | Pan image |
| `C` | Toggle crop mode |
| `Del` | Delete current tuple files |
| `Esc` | Reset zoom / cancel crop |

## Features

### Winner Voting

In batch mode, press `Enter` to mark the current modality as the winner for that image. Winners are saved to `results.txt`:

```
# ImageCompare Results
image_001 = model_v2
image_002 = ground_truth
image_003 = model_v1
```

Win counts appear in the status bar next to each modality name.

### Crop Tool

Press `C` or click the Crop button in the floating Tools panel to enter crop mode:

1. Draw a rectangle on the image
2. Resize using corner and edge handles; double-click a cardinal handle to snap to square
3. Press `Enter` or click the checkmark to crop all modalities at the same coordinates

Cropped files are saved as `_cropNN.png` alongside the originals and appear as new tuples in the carousel.

### PowerPoint Export

Click the PPTX button in the Tools panel to export all voted tuples to a PowerPoint file. Each modality gets its own slide with a caption bar showing the tuple name and modality. Crop files include a callout thumbnail showing the crop region on the full image.

### Floating Tools Panel

A draggable, collapsible panel in the top-right corner provides:

- **Minimap** — Always-visible thumbnail with viewport indicator when zoomed in
- **Crop** — Enter crop mode to crop all modalities at the same coordinates
- **Delete** — Delete all files for the current tuple
- **PPTX** — Export voted tuples to PowerPoint

### Smart Filename Matching

Images are matched across modalities using a two-pass algorithm:

1. **Exact match** — Identical basenames are matched first
2. **Fuzzy match** — Trie-based longest common prefix with LCS tie-breaking

This handles different naming conventions (e.g., `img_001_gt.png` matches `img_001_pred.png`), missing files in some modalities, and coexisting original and crop files.

### Live Updates

The view automatically updates when files change:
- **New images** appear instantly
- **Deleted images** are marked as removed
- **Modified images** reload automatically

Works reliably on all filesystems including Google Drive, FUSE mounts, and remote connections.

## Supported Formats

PNG, JPG, JPEG, GIF, BMP, WebP, TIFF, PPMX

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `imageCompare.thumbnailSize` | 100 | Thumbnail size in pixels |
| `imageCompare.prefetchCount` | 3 | Images to preload ahead/behind |
| `imageCompare.cacheMaxAgeDays` | 7 | Thumbnail cache lifetime |
| `imageCompare.debug` | false | Enable debug logging in webview console |

## Feedback & Issues

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/toshas/ImageCompare_vscode/issues)

## License

MIT
