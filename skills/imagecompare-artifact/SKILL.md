---
name: imagecompare-artifact
description: Publish a side-by-side image comparison as a shareable web page — a Claude artifact or any static host — using the ImageCompare standalone page unmodified, staged by one script from a folder or a `.imagecompare` session. Use when the user wants to show, share or embed a comparison of image sets (model outputs, variants, before/after) outside VS Code. No viewer code is written.
---

# imagecompare-artifact — publish a comparison as a web page

The ImageCompare standalone page opens a comparison by itself when an `imagecompare.json` sits next
to it. One script stages everything to publish; you never edit the page, write a viewer, or touch
the images.

## 1. Lay out the comparison

Either a folder in ImageCompare's own layout — one directory per column, the same image name in
every column:

```
comparison/
  01_input/scene_001.png
  01_input/scene_002.png
  02_ground_truth/scene_001.png
  03_model_a/scene_001.png
  ...
```

or a `.imagecompare` session file, as the VS Code extension opens it (several directories become
columns, named by the session's `labels` when it has them; a list of files becomes one row). One
difference: the published page orders a session's columns by name, not in the session's order.

- A directory is a column and its name is the column's label. Columns and rows are sorted by name
  in natural order, so number-prefix the directories to fix the column order.
- A row is the files that share a name across columns (names that share a stem also pair:
  `scene_001_gt.png` with `scene_001_pred.png`).
- For a Claude artifact the images must be `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`. Columns may
  differ in resolution. `results.txt` and any non-image file are never published.
- Names need no cleaning up. A character a file name or a published page cannot carry (`/ : \ * ?
  " < > |`, e.g. a label `Model: A`, or the `a/pred` name the extension derives for two directories
  sharing a tail) is replaced by a fixed lookalike (`Model꞉ A`, `a∕pred`), the same everywhere so rows
  still pair. Only a name nothing can fix (a control character, a trailing dot or space) is refused.
- A list of files is published flat, where the page reads it as a folder of loose images and sets
  `_cropNN` crops aside; a list the page would read back short is refused.

## 2. Stage it

In a checkout of [toshas/ImageCompare_vscode](https://github.com/toshas/ImageCompare_vscode) after
`npm ci`:

```bash
node scripts/share-comparison.mjs <folder | session.imagecompare> --out <empty dir> [--host claude-artifact|static] [--title "<name>"]
```

The script first builds the page from the checkout (about ten seconds), so the page always matches
the code that stages it. `--host` is where the page will be published: `claude-artifact` (the default) or `static` (GitHub
Pages, a bucket, an intranet share, `python3 -m http.server`). The script stages into `--out`:
`image_compare.html` (titled after the comparison), `imagecompare.json`, every image byte for byte at
its layout path, `imagecompare.thumbs.*.json` (prebuilt strip thumbnails, so viewers do not download
every full image to see the strip) and `publish-plan.json`.

**If the script refuses, stop.** It checks the whole comparison against what the host accepts — image
types, the per-image, per-file and total size limits, the file counts — and on any violation prints
every one, stages nothing and exits non-zero. Relay that report to the user as printed. Never work
around it: do not convert, re-encode, resize, drop or rename images to make a comparison fit, and do
not switch `--host` on your own. What to share instead is the user's decision.

## 3. Publish

**As a Claude artifact.** Publishing uploads the page and every image to claude.ai; make sure the
user means to share them. Read `publish-plan.json`: its `batches` are in order, each within what one
publish call accepts, and each starts with `image_compare.html`. Publish every batch the same way:
`image_compare.html` as the artifact page and every other file in that batch as the page's supporting
files, at exactly the relative paths the plan lists (the staged folder is the publish root). Batch 0
creates the artifact; each further batch goes, in order, to the same artifact URL, and files already
published are kept. Give the user the link.

**Anywhere else** (`--host static`). Upload the staged folder as it is and link to
`image_compare.html`; locally, `python3 -m http.server` in the folder and open
`http://localhost:8000/image_compare.html`. Opening the file straight from disk (`file://`) shows the
folder picker instead, because browsers block reading neighbouring files there.

## What the viewer gets

The full ImageCompare viewer: zoom and pan kept across columns, `←`/`→` columns, `↑`/`↓` rows, hold
`Space` to flip back, `1`–`9` to jump, a film strip of every row.

- **Votes** (`Enter`) are each viewer's own, kept in their browser for this comparison, and survive a
  reload. Nothing is sent anywhere: the **results.txt** button in the Tools panel copies them to the
  clipboard, exactly as `results.txt` would hold them, for the viewer to send back.
- **Crops** (`C`) are each viewer's own too, kept in their browser and deletable.
- **The published images are read-only**: Delete is greyed out on them.
- **PPTX export** is offered on a static host only. A Claude artifact blocks every download a page
  starts, so there it is not offered at all.

If the page shows the folder picker with an `imagecompare.json: ...` message, the manifest is
malformed, names a path outside the folder, or names a host the page does not know; stage it again
with step 2. With no message, no manifest was found next to the page. A single image that fails to
load shows "Image not available" in its own slot: check that it was uploaded at the path the plan
lists.

For the VS Code extension, the same folder layout opens through a session file — see the
`imagecompare` skill.
