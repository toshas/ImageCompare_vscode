# ImageCompare (standalone)

**This repository is a build artifact.** `image_compare.html` is generated from
[toshas/ImageCompare_vscode](https://github.com/toshas/ImageCompare_vscode) on every push to its
main branch — the matcher, viewer, voting, crop and PPTX logic are the *same code* the VS Code
extension ships. Do not edit the file or open PRs here; report issues and contribute in the
extension repo.

## Use

Download `image_compare.html`, open it in a browser, pick (or drop) a folder whose subdirectories
each hold one modality of the same image set.

- **Chrome / Edge** — full features: voting saved to `results.txt` in the folder, crop written back
  to every modality, delete, PPTX export.
- **Firefox / Safari** — read-only: view and compare (folder-picker), PPTX export; anything that
  writes files is disabled (these browsers don't expose writable folder access).

## Changes vs. the old hand-written standalone

This generated version replaces the previous independent implementation. Behavior follows the
extension everywhere the two disagreed, most visibly:

- Matching edge cases can group differently (the extension's trie matcher is the single source of
  truth now).
- Rows sort by tuple name, so crops list directly under their parents.
- Modality columns sort naturally (`mod2` before `mod10`), which can shift digit-key bindings and
  colors.
- Duplicate tuple names get ` (2)`-style suffixes instead of colliding.
- Single-tuple folders are votable.
- Live folder polling (auto-detecting new/deleted files) is not yet available.
