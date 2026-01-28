# ImageCompare

[![GitHub](https://img.shields.io/github/stars/toshas/ImageCompare_vscode?style=flat&label=GitHub)](https://github.com/toshas/ImageCompare_vscode)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/obukhovai.image-compare?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=obukhovai.image-compare)
[![Open VSX](https://img.shields.io/open-vsx/v/obukhovai/image-compare?label=Open%20VSX)](https://open-vsx.org/extension/obukhovai/image-compare)
[![Website](https://img.shields.io/badge/Website-obukhov.ai-blue)](https://www.obukhov.ai)
[![X Follow](https://img.shields.io/badge/X-@antonobukhov1-black?logo=x)](https://x.com/antonobukhov1)

**Flip between image variants instantly** — perfect for reviewing ML model outputs, A/B testing designs, or comparing renders across different settings. View one image at a time and switch between modalities with a keypress. Zoom and pan stay locked when switching, so you can compare fine details at any magnification.

![ImageCompare Demo](https://raw.githubusercontent.com/toshas/ImageCompare_vscode/main/demo.gif)

## Why ImageCompare?

- **Instant Flip Comparison** — Hold Space to flip between images. See differences that static side-by-side views miss.
- **Batch Processing** — Load hundreds of image tuples at once. Navigate with arrow keys.
- **Smart Matching** — Automatically matches images across folders by filename, even with different suffixes.
- **Remote Ready** — Works seamlessly over SSH, WSL, and Dev Containers.
- **Winner Voting** — Mark the best result for each comparison. Results saved to a simple text file.

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
| `Esc` | Reset zoom |

## Winner Voting

In batch mode, press `Enter` to mark the current modality as the winner for that image. Winners are saved to `results.txt`:

```
# ImageCompare Results
image_001 = model_v2
image_002 = ground_truth
image_003 = model_v1
```

Win counts appear in the status bar next to each modality name.

## Live Updates

The view automatically updates when files change:
- **New images** appear instantly
- **Deleted images** are marked as removed
- **Modified images** reload automatically

## Supported Formats

PNG, JPG, JPEG, GIF, BMP, WebP, TIFF

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `imageCompare.thumbnailSize` | 100 | Thumbnail size in pixels |
| `imageCompare.prefetchCount` | 3 | Images to preload ahead/behind |
| `imageCompare.cacheMaxAgeDays` | 7 | Thumbnail cache lifetime |

## Feedback & Issues

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/toshas/ImageCompare_vscode/issues)

## License

MIT
