# Pointer Input: Pill Drag and the Touch Layout

Mouse and finger input beyond the keyboard: dragging a modality pill to reorder the columns, and
the touch layout of phones and tablets. Both live in the webview bundle: the extension panel, the
standalone page and a published comparison behave the same.

Code:
- `webview/pillReorder.ts`: pure; the move permutation, the drop slot, the per-pill shift.
- `webview/pillDrag.ts`: the pill row's pointer gestures.
- `webview/touchInput.ts`: the image's and the strip's touch gestures.
- `webview/main.ts`: `moveModality`, `setupTouch`, `carouselOffsetPx`.
- `webviewShell.ts`: the `touch-ui` styles, the ▦ button, the help rows.

Pinned by:
- `test/unit/pillReorder.test.ts` (Vitest, mutation-gated);
- `test/webview/pill-drag.spec.ts` and `test/webview/touch-layout.spec.ts` (Playwright on the real
  bundle).

## A reorder is one move

`[` / `]` move the current modality one slot; dropping a dragged pill moves *that* pill to the slot
it was dropped on. Both go through `moveModality(from, to)`. It splices every display-ordered array
(`modalities`, `modalityColors`, `modalityPaths`, `modalityOrder`). It remaps every display index
held anywhere else through the same permutation (`movedIndex`): each tuple's vote, the Space-peek
target, the current modality.

A move is not a swap: the pills between `from` and `to` close up by one. A swap-shaped remap gets
this wrong. Votes are stored by display index, so it would re-attribute votes in
`results.txt` without any visible error. The shown modality follows its modality: dragging some
other pill never changes what is on screen.

## The drag

- **Mouse**: a press on a pill becomes a drag once the pointer has moved 5 px; less is a click,
  which selects the pill as before.
- **Pen**: a mouse, with one difference: the row clicks a tap itself, as it does a finger's (below).
- **Finger**: a press on a pill lifts it after a 300 ms hold within 8 px. A finger that moves first
  pans the row instead, with a fling on release; one lifted before the hold is a tap, which selects.

While the pill is lifted nothing is rebuilt. It follows the pointer, clamped to the row's ends with
its lift scale included. It scales about its centre, whatever origin a resting end pill has.
`dropSlot` finds the target slot by binary search over pill midpoints cached at the lift. Only pills
that change side get a new transform (`slotShift`), so a move costs the same with five pills or five
hundred.

The clamp, the midpoints and the slide are read from the pills' rects. A hover scale or a landed
pill's glide is undone in arithmetic from the computed transform. `offsetLeft` and `offsetWidth`
round to whole px, and pills sit between them. Clearing the transforms to measure would snap a glide
still running from the last drop.

The slot is searched from where the *pointer* puts the pill, not from the clamped drawing. A clamped
centre can never pass the midpoint of an end pill no narrower than the dragged one, so that end slot
would be unreachable.

Near the row's edges the row auto-scrolls. The drop commits once: one `moveModality`, one rebuild of
the row and the strip. It keeps the row where the user left it, and the landed pill glides from
where it was let go. A rebuild per move both stutters on a long row and destroys the element under
the pointer.

**The row owns its touches.** It is `touch-action: none` and cancels every `touchstart`. A pan the
browser has claimed cannot be handed back to a pill lifted mid-gesture. Chrome's own long press, a
haptic then a `pointercancel`, grows from an uncancelled `touchstart`; on Android it ended every
drag at the lift. Cancelling `touchstart` also cancels the browser's tap-to-click, so the row clicks
the pill itself for a tap.

**Only the row's capture ends a drag.** The lift captures the pointer to the row so the drag survives
the finger leaving it. A real Android WebView has already captured a touch to the pressed pill. The
hand-over then fires `lostpointercapture` *at the pill*, which bubbles to the row. Read as a release,
that ended every drag at 0 px on the phone. Headless Chromium's touch emulation fires no
implicit-capture events at all, which is why every emulated run passed. The spec dispatches the
pill's `lostpointercapture` by hand.

The `pointerup` that ends a drag or a pan is not a click on the pill under it. Chromium, probed,
sends no click at all after a drop that rebuilds the row (the pressed pill is gone). After a drag
dropped where it started, it clicks the row, the capture target, never the pill. Another engine may
click the pill beneath, so a mouse or pen drag arms a swallow.

The swallow eats only a click a pointer made (`detail` ≥ 1), and the next press anywhere disarms it.
A release that no click follows — Chromium's usual case — must not leave it waiting for the user's
next real click. A programmatic `click()` or a keyboard activation (`detail` 0) was never the
release's.

A finger arms nothing: a cancelled `touchstart` sends no click, so a finger's swallow would eat the
row's own click for the next tap. A pen tap is the row's to click: an engine that also fires touch
events for a stylus sends no click (the row cancels `touchstart`). An engine that clicks anyway, as
Chromium does, has that click swallowed, so the pill sees exactly one.

## The touch layout

Chosen once at load, from `(pointer: coarse)`: the *primary* pointer. A touchscreen laptop driven by
its trackpad, and VS Code on a desktop, keep the desktop layout unchanged. There is no host flag: the
device decides, not the host. A device in the touch layout adds `touch-ui` to `body`.

- **The strip** is a full-width, opaque picker over the image, hidden until the ▦ button in the bar
  opens it. The image area spans the whole viewer: `carouselOffsetPx()` is 0 in this
  layout, where the desktop strip sits beside the image. A single-tuple comparison has no strip and
  no ▦. The button's box shows only while `#viewer` carries `has-carousel`, the class main.ts sets
  beside `#carousel.active`. The gate is not `:has()`, which Safari < 15.4 and Firefox < 121 lack.
  Hidden, the button takes no room in the bar, as on desktop.
- The strip takes the viewer's width and refits on resize and rotation; tiles have a 56 px floor,
  and columns that don't fit scroll sideways. A finger drags it (the same paths the wheel and the
  horizontal scrollbar drive). A tile tap navigates as a click does and closes the strip.
- **On the image**, a one-finger swipe steps once when it crosses 40 px. Sideways switches modality
  (skipping hidden ones, as ← / → do); up or down switches tuple (up is next). Touch and hold
  (350 ms within 10 px) flips to the previous modality until the finger lifts, as holding Space
  does. Two fingers pinch-zoom about their midpoint and pan; lifting one never turns the other
  into a swipe. A tap on the zoom readout resets zoom and pan.
- **Gestures load nothing.** Each calls the action its key calls (`stepModality`, `loadTuple`, the
  Space swap), so dwell, priorities and column reports apply exactly as they do to keys.
- **Off in this layout**:
  - the Tools panel (and with it crop and PPTX);
  - the strip's resize handle;
  - the vote circles on tiles;
  - the pill path tooltip;
  - every context menu: Android opens one on any long press, and here a long press is the flip or
    the pill lift;
  - text selection, the long-press callout, the tap highlight, image dragging, and the browser's own
    pinch and pan.
- The pills' hover look applies only under `(hover: hover)`, so a tapped pill is not left enlarged.
- The strip's inner horizontal scroller says `touch-action: none` itself. An ancestor's `none` stops
  at a scroll container; below it, the browser claimed the first vertical move and cancelled the
  finger.
- **A finger never reaches the mouse handlers** on the image. A touch `pointerdown` is cancelled,
  so no compatibility mouse events follow, and mouse pan and crop never see a finger.
- Larger targets (40 px bar buttons, larger pills); in portrait the pill row takes its own line.
  The help modal shows a Touch section instead of the keyboard rows. Keys still work, for a tablet
  with a keyboard.

## Invariants

- **`reorder-is-one-move`** — every reorder, `[` / `]` and a pill drop alike, goes through
  `moveModality(from, to)`, and every display index outside the spliced arrays (votes, the Space-peek
  target, the current modality) is remapped through `movedIndex`; the modalities between `from` and
  `to` shift by one. A swap-shaped remap re-attributes votes in `results.txt` silently.
- **`drag-commits-once`** — while a pill is lifted only inline transforms change, and only on pills
  that change side; the row and the strip are rebuilt once, on the drop.
- **`row-owns-touch`** — the pill row is `touch-action: none` and cancels `touchstart`; it pans, flings
  and clicks for taps itself. Without either half, Chrome claims the gesture and cancels the drag.
- **`only-row-capture-ends-drag`** — only a `lostpointercapture` whose target is the row ends a drag;
  a pill's own (a real touch's implicit capture handed to the row) bubbles there too.
- **`drag-is-not-a-click`** — the `pointerup` that ends a drag or a pan never clicks the pill under it.
- **`touch-layout-by-primary-pointer`** — the touch layout is decided once at load from
  `(pointer: coarse)` and nothing else; under a fine primary pointer the desktop layout is unchanged.
- **`strip-offset-from-one-helper`** — the strip's horizontal offset into the image area comes only
  from `carouselOffsetPx()`; the phone strip covers the image instead of standing beside it, and a
  site that still reads `CAROUSEL_WIDTH` misplaces zoom, pan and the crop overlay by the strip's width.
- **`gestures-load-nothing`** — a touch gesture calls the action its key calls and nothing else; it
  never requests images or touches the loading machinery itself.
- **`touch-opens-no-menu`** — in the touch layout no long press opens a context menu, anywhere.
