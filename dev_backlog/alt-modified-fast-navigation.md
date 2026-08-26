# Backlog: Alt as a "move faster" modifier

**Status: not started.** Raised 2026-08-26 from
[ImageCompare_standalone#4](https://github.com/toshas/ImageCompare_standalone/pull/4). The smallest
item of the five and the one most likely to be worth its cost.

## What the user gets

- **Alt+scroll over the image** — zooms ~5x faster per notch.
- **Alt+scroll over the carousel** — scrolls the thumbnail list ~5x faster.
- **Wheel over the modality button row** — scrolls it sideways when the buttons overflow, and the
  active button scrolls itself into view.

The third is not an Alt feature and is the one that matters most: at 136 modalities the button row
overflows badly, and today there is no way to reach the buttons at the far end with the wheel.

## Why it is nearly free

`altKey` appears in `webview/main.ts` only as a negative guard (`!e.altKey` on the Ctrl+S and C
bindings), so the modifier is unclaimed. Nothing else needs to move.

## Decisions worth making rather than copying

- **The multiplier.** The PR uses a flat `5`. Zoom is multiplicative (`1 ± 0.03 * fast`) and carousel
  scroll is linear (`deltaY * fast`), so one constant means two very different accelerations. Pick
  each on feel, and put them next to the other tunables rather than inline.
- **Alt is a menu key on Windows and Linux.** Alt+scroll is usually safe, but confirm the webview
  does not surrender the keystroke to the host, and that Alt-drag does not collide with an existing
  pan. The extension and the standalone may differ here — the standalone is a plain browser tab, the
  extension is a webview inside an application with its own accelerators.
- **Discoverability.** A hidden 5x modifier that nobody knows about is worth little. The help modal
  (`webviewShell.ts`) lists shortcuts; if it goes anywhere, it goes there.

## Traps

- The image wheel handler is `passive: false` and calls `preventDefault()`. Adding a branch must not
  change when the default is prevented, or normal page scroll behaviour shifts underneath.
- The modality row's sideways scroll converts vertical wheel to horizontal. Only do it when the row
  actually overflows — otherwise a wheel over the pills stops scrolling whatever the user meant to
  scroll. The PR gets this right (`scrollWidth > clientWidth`); keep the check.
- `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the active pill can fight the user
  mid-drag. Confirm it only fires on a modality *change*, not on every render.

## Acceptance

- Alt-modified zoom and scroll are pinned at Layer 3 (Playwright drives the real wheel events), with
  the multipliers as external literals rather than re-derived from the handler.
- The modality row scrolls sideways only when it overflows, pinned the same way.
- Both new bindings appear in the help modal.
- Nothing regresses in the existing wheel handlers' `preventDefault` behaviour.
