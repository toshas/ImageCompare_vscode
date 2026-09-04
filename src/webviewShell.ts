/**
 * Single source of truth for the ImageCompare webview shell (styles + body),
 * rendered identically by the production panel (imageCompareProvider.getHtmlContent)
 * and the Playwright test harness (test/webview/harness.ts).
 */

export const WEBVIEW_STYLES = `* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--vscode-editor-background, #1a1a1a);
  color: var(--vscode-editor-foreground, #fff);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground, #888);
}
#loading.hidden { display: none; }

#viewer {
  display: none;
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
}
#viewer.active { display: block; }
#viewer.dragging { cursor: grabbing; }

#canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

#image-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  z-index: 5;
  pointer-events: none;
}
#image-loader.active { display: flex; }
#viewer.has-carousel #image-loader {
  left: calc(50% + var(--carousel-offset, 0px) / 2);
}
#loader-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--vscode-editor-background, #333);
  border-top-color: var(--vscode-textLink-foreground, #0af);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
#canvas.preview {
  opacity: 0.5;
  filter: blur(2px);
}
/* Terminal notice for an emptied comparison; the canvas is hidden under it, never left showing a stale frame (docs/loading-architecture.md: empty-comparison-is-terminal). */
#canvas.hidden { display: none; }
#empty-notice {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: none;
  max-width: 80%;
  text-align: center;
  z-index: 6;
  pointer-events: none;
}
#empty-notice.active { display: block; }
/* Gated on the class, like the spinner's: the offset variable outlives the carousel it was set for. */
#viewer.has-carousel #empty-notice {
  left: calc(50% + var(--carousel-offset, 0px) / 2);
}
#empty-notice-title {
  font-size: 15px;
  color: var(--vscode-foreground, #ccc);
  margin-bottom: 6px;
}
#empty-notice-detail {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #999);
  word-break: break-all;
}

/* Floating panel (navigator + crop) */
#floating-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid var(--vscode-panel-border, #444);
  border-radius: 6px;
  z-index: 20;
  min-width: 160px;
  max-width: 168px;
  user-select: none;
}
#fp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1px 6px;
  cursor: pointer;
  background: rgba(255,255,255,0.18);
  border-radius: 6px 6px 0 0;
  font-size: 11px;
  font-weight: 600;
  color: #ccc;
  letter-spacing: 0.3px;
}
#fp-collapse-btn {
  cursor: pointer;
  font-size: 18px;
  padding: 0 2px;
  line-height: 1;
  color: #fff;
}
#fp-body { padding: 4px; }
#floating-panel.collapsed #fp-body { display: none; }
#floating-panel.collapsed { min-width: auto; }
#floating-panel.collapsed #fp-header { border-radius: 6px; }
#fp-minimap {
  position: relative;
  margin-bottom: 4px;
}
#thumb-canvas {
  display: block;
  margin: 0 auto;
  max-width: 160px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
#thumb-viewport {
  position: absolute;
  border: 2px solid #f0f;
  pointer-events: none;
  box-sizing: border-box;
  display: none;
}
#fp-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
#crop-btn {
  padding: 3px 8px;
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
#crop-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
#crop-btn.active {
  background: var(--vscode-button-background, #0078d4);
  color: var(--vscode-button-foreground, #fff);
}
#delete-btn, #pptx-btn {
  padding: 3px 8px;
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
#delete-btn:hover { background: #a33; }
#pptx-btn:hover { background: #383; }
#pptx-btn.busy {
  position: relative;
  color: transparent;
  cursor: default;
}
#pptx-btn.busy::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 10px;
  height: 10px;
  border: 2px solid var(--vscode-button-secondaryForeground, #fff);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* Crop overlay */
#crop-overlay {
  position: absolute;
  inset: 0;
  z-index: 15;
  cursor: crosshair;
}
.crop-dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.crop-rect {
  position: absolute;
  border: 2px solid #0f0;
  box-sizing: border-box;
  pointer-events: none;
}
.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border: 1px solid #333;
  border-radius: 2px;
  z-index: 16;
}
.crop-toolbar {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  z-index: 16;
}
.crop-toolbar-btn {
  padding: 3px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.crop-confirm {
  background: #2ea043;
  color: #fff;
}
.crop-confirm:hover { background: #3fb950; }
.crop-cancel {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
}
.crop-cancel:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }

#info {
  background: var(--vscode-sideBar-background, #2a2a2a);
  padding: 6px 12px;
  display: flex;
  align-items: center;
  font-size: 13px;
  flex-shrink: 0;
  min-height: 36px;
  gap: 12px;
  border-top: 1px solid var(--vscode-panel-border, #333);
}
#info.hidden { display: none; }

#modality-selector {
  display: flex;
  gap: 2px 4px;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  min-width: 0;
}

#status {
  color: var(--vscode-descriptionForeground, #888);
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  line-height: 1.2;
}
#status-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* Direct #info child so flex reserves its width — nested under #status it got squeezed under the help button. */
#status-info {
  flex-shrink: 0;
  white-space: nowrap;
  color: var(--vscode-descriptionForeground, #888);
}
#status-info:empty { display: none; }

.modality-btn {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s;
  border: none;
  color: #000;
  user-select: none;
  position: relative;
  flex-shrink: 0;
  white-space: nowrap;
}
.modality-btn:hover { transform: scale(1.05); }

/* Native title= tooltips drop on re-render and never reappear without leaving the pill, so pills use this instead. */
#pill-tooltip {
  position: fixed;
  z-index: 200;
  display: none;
  max-width: min(70vw, 700px);
  padding: 6px 9px;
  border-radius: 5px;
  background: var(--vscode-editorHoverWidget-background, #252526);
  color: var(--vscode-editorHoverWidget-foreground, #ccc);
  border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
#pill-tooltip.visible { display: block; }
#copy-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 201;
  padding: 8px 14px;
  border-radius: 6px;
  background: var(--vscode-notifications-background, #2a2a2a);
  color: var(--vscode-notifications-foreground, #ccc);
  border: 1px solid var(--vscode-panel-border, #444);
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
#copy-toast.visible { opacity: 1; }
/* The comparison's own context menu: one implementation, so the standalone offers exactly what the panel does (docs/standalone.md: affordances-rendered-by-the-webview). */
#context-menu {
  position: fixed;
  z-index: 202;
  display: none;
  min-width: 150px;
  padding: 4px 0;
  border-radius: 5px;
  background: var(--vscode-menu-background, #252526);
  border: 1px solid var(--vscode-menu-border, #454545);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
}
#context-menu.visible { display: block; }
.context-menu-item {
  display: block;
  width: 100%;
  padding: 5px 22px 5px 12px;
  border: none;
  background: none;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  color: var(--vscode-menu-foreground, #ccc);
}
.context-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, #04395e);
  color: var(--vscode-menu-selectionForeground, #fff);
}
.context-menu-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, #454545);
}
#copy-toast.has-action { pointer-events: auto; }
#copy-toast.error { color: var(--vscode-errorForeground, #f66); }
#notice-action {
  margin-left: 10px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  color: var(--vscode-textLink-foreground, #4daafc);
}
.modality-btn.active {
  opacity: 1;
  box-shadow: 0 0 0 2px var(--vscode-focusBorder, #fff);
}
.modality-btn.inactive { opacity: 0.4; }
/* Hidden modality: grayed but clickable; keyboard cycling skips it (docs/session-files.md: hidden-is-presentation-only). */
.modality-btn.hidden-modality { opacity: 0.25; filter: grayscale(1); }
.modality-btn.hidden-modality.active { opacity: 0.55; }

#reorder-buttons {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  align-items: center;
}
.reorder-btn {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.reorder-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
.reorder-btn:disabled { opacity: 0.3; cursor: default; }

#help-btn {
  background: var(--vscode-button-secondaryBackground, #444);
  color: var(--vscode-button-secondaryForeground, #fff);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 50%;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
#help-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }

#progress-container {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--vscode-notifications-background, rgba(0, 0, 0, 0.8));
  border: 1px solid var(--vscode-panel-border, #444);
  border-radius: 8px;
  padding: 12px 20px;
  z-index: 50;
  display: none;
  min-width: 250px;
  text-align: center;
}
#progress-container.active { display: block; }
#progress-text {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #aaa);
}
#progress-bar {
  width: 100%;
  height: 6px;
  background: var(--vscode-progressBar-background, #333);
  border-radius: 3px;
  overflow: hidden;
}
#progress-fill {
  height: 100%;
  background: var(--vscode-progressBar-background, #0af);
  width: 0%;
  transition: width 0.1s;
}

/* Carousel styles */
/* Not a native scroll container: the wall is transform-positioned and steps land whole row heights, keeping the grid pixel-stationary (docs/loading-architecture.md). */
#carousel {
  display: none;
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--vscode-sideBar-background, rgba(0, 0, 0, 0.85));
  border-right: 1px solid var(--vscode-panel-border, #333);
  overflow: hidden;
  z-index: 10;
}
#carousel.active { display: block; }
#carousel-wall { position: relative; will-change: transform; }
/* Horizontal scroll kicks in only when even 12px tiles cannot fit the pane width. */
#carousel-hscroll { position: absolute; inset: 0; overflow-x: auto; overflow-y: hidden; }
#carousel-hscroll::-webkit-scrollbar { height: 6px; }
#carousel-hscroll::-webkit-scrollbar-track { background: transparent; }
#carousel-hscroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-activeBackground, #444); border-radius: 3px; }
#carousel-thumb {
  position: absolute;
  top: 0;
  right: 1px;
  width: 6px;
  border-radius: 3px;
  background: var(--vscode-scrollbarSlider-activeBackground, #444);
  opacity: 0;
  transition: opacity 0.3s;
  z-index: 2;
}
#carousel:hover #carousel-thumb,
#carousel.scrolling #carousel-thumb { opacity: 1; }
/* Below 3x the circle, a tile click is a coin-flip between navigate and vote (docs/session-files.md: tiny-tiles-never-vote). */
#carousel.tiny-tiles .winner-circle { pointer-events: none; }

/* 1px top+bottom on adjacent rows = 2px vertical space, matching the 2px column gap — an equidistant wall, no separator lines. */
/* No transitions on selection styling: the wall jumps instantly, so a fading highlight pulses the center on every step. */
/* Absolutely positioned: rows are a recycled pool placed at tupleIndex * rowHeight inside the virtual wall. */
.carousel-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  gap: 2px;
  padding: 1px 6px;
  cursor: pointer;
}
.carousel-row:hover { background: rgba(255, 255, 255, 0.05); }
.carousel-row.current { background: rgba(255, 255, 255, 0.1); }

.carousel-thumb {
  object-fit: contain;
  background: #111;
  border-radius: 3px;
  border: 2px solid transparent;
  opacity: 0.6;
  flex-shrink: 0;
}
.carousel-thumb:hover { opacity: 1; }
.carousel-thumb.active { opacity: 1; }
.carousel-thumb.selected { border-color: #f0f; }
.carousel-thumb.placeholder {
  background: var(--vscode-input-background, #333);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground, #666);
  font-size: 10px;
}
.carousel-thumb.missing {
  opacity: 0.5;
  filter: grayscale(1);
}
.carousel-thumb.missing.selected {
  filter: grayscale(1) drop-shadow(0 0 2px #f0f);
  opacity: 0.8;
}
.carousel-thumb.selected {
  outline: 2px solid #f0f;
  outline-offset: -2px;
}

/* Winner voting indicators */
/* Sized by one CSS variable so a resize drag writes one style, not one per tile. */
.carousel-thumb-container {
  position: relative;
  width: var(--thumb-size, 50px);
  height: var(--thumb-size, 50px);
  flex-shrink: 0;
}
.carousel-thumb-container .carousel-thumb {
  width: 100%;
  height: 100%;
}
.winner-circle {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 7px;
  height: 7px;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: all 0.15s;
  z-index: 5;
}
.winner-circle:hover {
  background: rgba(255, 255, 255, 0.4);
  border-color: rgba(255, 255, 255, 0.6);
}
.winner-circle.winner {
  background: #0f0;
  border-color: #fff;
  box-shadow: 0 0 3px rgba(0, 255, 0, 0.5);
}
.winner-circle.winner:hover {
  background: #0c0;
  border-color: #fff;
}

#carousel-resize {
  display: none;
  position: absolute;
  left: 216px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  background: transparent;
  z-index: 11;
}
#carousel-resize.active { display: block; }
#carousel-resize:hover,
#carousel-resize.dragging { background: var(--vscode-focusBorder, rgba(0, 170, 255, 0.3)); }

#help-modal {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.8);
  align-items: center;
  justify-content: center;
  z-index: 100;
}
#help-modal.active { display: flex; }
/* Must always fit the viewport (13" laptops clipped a fixed 450px box): cap both axes and scroll inside. */
.modal-content {
  background: var(--vscode-notifications-background, #2a2a2a);
  padding: clamp(12px, 4vmin, 30px);
  border-radius: 12px;
  text-align: center;
  max-width: min(450px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  border: 1px solid var(--vscode-panel-border, #444);
}
.modal-content h3 {
  color: var(--vscode-textLink-foreground, #0af);
  margin-bottom: 15px;
}
.modal-content table {
  width: 100%;
  text-align: left;
  border-collapse: collapse;
}
.modal-content td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.modal-content td:first-child {
  color: var(--vscode-textLink-foreground, #0af);
  font-family: monospace;
  white-space: nowrap;
}
.btn {
  padding: 10px 24px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.btn-primary {
  background: var(--vscode-button-background, #0af);
  color: var(--vscode-button-foreground, #000);
}
.btn:hover { opacity: 0.9; }
#help-version {
  margin-top: 14px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
}
#help-version:empty { display: none; }`;

export const WEBVIEW_BODY = `  <div id="loading">Loading images...</div>

  <div id="viewer">
    <div id="carousel"></div>
    <div id="carousel-resize"></div>
    <div id="progress-container">
      <div id="progress-text">Loading thumbnails...</div>
      <div id="progress-bar"><div id="progress-fill"></div></div>
    </div>
    <canvas id="canvas"></canvas>
    <div id="image-loader">
      <div id="loader-spinner"></div>
    </div>
    <div id="empty-notice">
      <div id="empty-notice-title"></div>
      <div id="empty-notice-detail"></div>
    </div>
    <div id="floating-panel">
      <div id="fp-header">
        <span id="fp-title">Tools</span>
        <span id="fp-collapse-btn">&#9662;</span>
      </div>
      <div id="fp-body">
        <div id="fp-minimap">
          <canvas id="thumb-canvas" width="160" height="100"></canvas>
          <div id="thumb-viewport"></div>
        </div>
        <div id="fp-actions">
          <button id="crop-btn" title="Crop all modalities (C)">Crop</button>
          <button id="delete-btn" title="Delete current tuple files (Del)">Delete</button>
          <button id="pptx-btn" title="Export voted tuples to PPTX">PPTX</button>
        </div>
      </div>
    </div>
  </div>

  <div id="info" class="hidden">
    <div id="reorder-buttons">
      <button id="reorder-left" class="reorder-btn" title="Move modality left ([)">\u2190</button>
      <button id="reorder-right" class="reorder-btn" title="Move modality right (])">\u2192</button>
    </div>
    <div id="modality-selector"></div>
    <span id="status"><span id="status-name">Loading...</span></span>
    <span id="status-info"></span>
    <button id="help-btn" title="Keyboard shortcuts">?</button>
  </div>
  <div id="pill-tooltip"></div>
  <div id="copy-toast"></div>
  <div id="context-menu"></div>

  <div id="help-modal">
    <div class="modal-content">
      <h3>Keyboard Shortcuts</h3>
      <table>
        <tr><td>\u2190 \u2192</td><td>Switch modality (skips hidden)</td></tr>
        <tr><td>\u2191 \u2193</td><td>Previous/next tuple</td></tr>
        <tr><td>Space</td><td>Flip to previous modality (hold)</td></tr>
        <tr><td>1-9</td><td>Jump to modality N</td></tr>
        <tr><td>[ ]</td><td>Reorder current modality</td></tr>
        <tr><td>Enter</td><td>Toggle winner / confirm crop (in crop mode)</td></tr>
        <tr><td>Scroll</td><td>Zoom in/out; scroll tuples on the film strip</td></tr>
        <tr><td>Shift+Scroll</td><td>On the film strip: scroll the film strip sideways</td></tr>
        <tr><td>Drag</td><td>Pan image</td></tr>
        <tr><td>Click</td><td>Film-strip tile: go to it; its corner circle: toggle winner</td></tr>
        <tr id="help-row-contextmenu"><td>Right-click</td><td>On the image or a pill: <span id="help-contextmenu-items"></span></td></tr>
        <tr><td>Ctrl/Cmd+C</td><td>Copy current image (when no text is selected)</td></tr>
        <tr id="help-row-savesession"><td>Ctrl/Cmd+S</td><td>Save Session As \u2014 keep a copy of this comparison</td></tr>
        <tr><td>C</td><td>Toggle crop mode</td></tr>
        <tr><td>2\u00d7-click</td><td>On a crop edge handle, square the crop toward that edge (in crop mode)</td></tr>
        <tr><td>Del / Backspace</td><td>Delete current tuple files (permanent!)</td></tr>
        <tr><td>Esc</td><td>Reset zoom / cancel crop / close this help</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <button class="btn btn-primary" id="close-help-btn">Close</button>
      </div>
      <div id="help-version"></div>
    </div>
  </div>
`;


export interface WebviewHtmlOptions {
  /** CSP source for images (webview.cspSource in production). */
  cspSource: string;
  /** Nonce permitting the bundle script to run. */
  nonce: string;
  /** URI/href of the webview bundle (dist/webview.js). */
  scriptUri: string;
}

/** Render the full webview HTML document; the test harness builds its own head/stub and reuses WEBVIEW_STYLES + WEBVIEW_BODY. */
export function renderWebviewHtml(opts: WebviewHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${opts.cspSource} data: blob:; script-src 'nonce-${opts.nonce}'; style-src 'unsafe-inline';">
  <title>ImageCompare</title>
  <style>
${WEBVIEW_STYLES}
  </style>
</head>
<body>
${WEBVIEW_BODY}
  <script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}
