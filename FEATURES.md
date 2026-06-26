# ImageCompare — Feature Coverage

**52/62 features tested** · 84% · generated 2026-06-26 16:05

Legend: ✅ tested · ❌ failing · ⬜ no test yet · 🟡 stale mapping


## Keyboard — navigation

| | Feature | Covered by |
|---|---|---|
| ✅ | → next modality | `webview`: Right/Left switch modality |
| ✅ | ← previous modality | `webview`: Right/Left switch modality |
| ✅ | ↓ next tuple | `webview`: Down/Up move between tuples |
| ✅ | ↑ previous tuple | `webview`: Down/Up move between tuples |
| ✅ | 1–9 jump to modality N | `webview`: number keys jump to a modality |
| ✅ | Space (hold) flip to previous modality | `webview`: Space (hold) flips to the previous modality |

## Keyboard — actions

| | Feature | Covered by |
|---|---|---|
| ✅ | ] reorder modality right | `webview`: ] key reorder also keeps tooltips correct |
| ✅ | [ reorder modality left | `webview`: reorders the current modality left |
| ✅ | Enter toggle winner | `webview`: Enter toggles a winner and posts setWinner |
| ✅ | C toggle crop mode | `webview`: C enters crop mode |
| ✅ | Esc reset zoom / cancel crop / close help | `webview`: Escape cancels crop mode<br>`webview`: wheel zooms in; Escape resets |
| ⬜ | Del delete tuple (NOTE: not actually bound — button only) | — |

## Mouse / pointer

| | Feature | Covered by |
|---|---|---|
| ✅ | Scroll wheel zoom in/out | `webview`: wheel zooms in; Escape resets |
| ✅ | Drag to pan | `webview`: drag pans the image when zoomed in |
| ✅ | Click modality pill to switch | `webview`: clicking a modality pill switches modality |
| ⬜ | Value-under-cursor (PPMX pixel readout) | — |

## Tools window (floating panel)

| | Feature | Covered by |
|---|---|---|
| ✅ | Crop button | `webview`: shows the floating panel tools<br>`webview`: C enters crop mode |
| ✅ | Delete button → deleteTuple | `webview`: shows the floating panel tools |
| ✅ | PPTX button → exportPptx | `webview`: shows the floating panel tools |
| ✅ | Show-zoom toggle | `webview`: show-zoom toggle hides the zoom readout |
| ✅ | PPMX colormap select (grayscale/jet) | `webview`: PPMX colormap select posts setPpmxColormap |
| ⬜ | Minimap navigator + viewport rect | — |
| ⬜ | Drag panel to reposition | — |
| ✅ | Collapse/expand panel | `webview`: collapse button toggles the floating panel |

## Crop tool

| | Feature | Covered by |
|---|---|---|
| ✅ | Enter crop mode (crosshair) | `webview`: C enters crop mode |
| ✅ | Draw crop rectangle | `webview`: drawing sets a crop rect |
| ✅ | Confirm → cropImages message | `webview`: Enter posts cropImages |
| ✅ | Cancel crop (Esc / ✗) | `webview`: Escape cancels crop mode |
| ⬜ | Resize via 8 handles | — |
| ⬜ | Move rectangle by dragging inside | — |
| ⬜ | Double-click cardinal handle → snap to square | — |
| ✅ | Screen↔image coordinate mapping | `unit`: viewer center maps to image center<br>`unit`: are inverses<br>`unit`: carousel offset |

## Modality reorder

| | Feature | Covered by |
|---|---|---|
| ✅ | Reorder swaps pill name | `webview`: reorder-right swaps both the pill name |
| ✅ | Reorder swaps pill tooltip (path) | `webview`: reorder-right swaps both the pill name<br>`webview`: ] key reorder also keeps tooltips correct |

## Winner voting

| | Feature | Covered by |
|---|---|---|
| ✅ | Toggle winner via Enter | `webview`: Enter toggles a winner and posts setWinner |
| ✅ | Toggle winner via carousel circle click | `webview`: clicking a carousel winner circle posts setWinner |
| ⬜ | Win counts shown on pills | — |
| ✅ | Persistence to results.txt | `integration`: write then read round-trips<br>`integration`: CRLF-encoded results |

## Carousel

| | Feature | Covered by |
|---|---|---|
| ✅ | Thumbnail grid renders | `webview`: renders the viewer and ingests fixtures |
| ✅ | Click thumbnail to navigate | `webview`: clicking a carousel thumbnail navigates |
| ⬜ | Scroll carousel | — |
| ⬜ | Drag resize handle | — |

## Viewer / status bar

| | Feature | Covered by |
|---|---|---|
| ✅ | Viewer activates on init | `webview`: renders the viewer and ingests fixtures |
| ✅ | Modality pills render (per modality) | `webview`: renders a modality pill per modality |
| ✅ | Active pill reflects current modality | `webview`: active modality pill reflects current modality |
| ✅ | Canvas renders the image (visual) | `webview`: canvas renders modality 0<br>`webview`: canvas renders modality 1 |
| ✅ | Status bar layout (visual) | `webview`: status bar + modality pills layout |
| ✅ | Zoom % readout in status | `webview`: show-zoom toggle hides the zoom readout |
| ✅ | Help modal (? open / close) | `webview`: opens the help modal and Esc closes it |

## Backend — scanning & matching

| | Feature | Covered by |
|---|---|---|
| ✅ | Mode 1: dir with modality subdirs | `integration`: mode 1: single dir |
| ✅ | Partial tuples (missing modality) | `integration`: partial tuple when a modality is missing |
| ✅ | PPMX files scanned as images | `integration`: PPMX files are scanned |
| ✅ | Trie matching: exact basenames | `unit`: matches identical basenames |
| ✅ | Trie matching: pred matches gt not crop | `unit`: _pred file matches the _gt original |
| ✅ | Path disambiguation (POSIX/Windows parity) | `unit`: same display names for equivalent POSIX paths<br>`unit`: Windows drive-letter paths disambiguate |

## Backend — formats & metadata

| | Feature | Covered by |
|---|---|---|
| ✅ | PPMX float32 parsing | `unit`: parses dimensions and float values |
| ✅ | PPMX colormap rendering (grayscale/jet) | `unit`: grayscale colormap maps<br>`unit`: jet colormap differs |
| ✅ | PPMX orientation (rotate90cw) | `unit`: rotate90cw orientation swaps |
| ✅ | PNG crop metadata round-trip | `unit`: round-trips crop metadata<br>`unit`: injects and reads back a value |

## Extension lifecycle

| | Feature | Covered by |
|---|---|---|
| ✅ | Extension activates | `integration`: extension is present and activates |
| ✅ | openInCompare command registered | `integration`: openInCompare command is registered |
| ✅ | results.txt CRLF parsing (cross-platform) | `integration`: CRLF-encoded results |
