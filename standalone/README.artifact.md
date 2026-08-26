# ImageCompare (standalone)

A single self-contained HTML file for comparing image sets across modalities in a browser — no
install, no server, no network.

> **Generated file. Do not push to this repository, ever.**
> `image_compare.html` is built from
> [toshas/ImageCompare_vscode](https://github.com/toshas/ImageCompare_vscode) on every push to its
> `main` branch. This repository is a *build artifact* of that one: anything committed here is
> overwritten by the next build without review.
>
> **Bugs, feature requests and pull requests belong in
> [toshas/ImageCompare_vscode](https://github.com/toshas/ImageCompare_vscode/issues)** — not here.
> Issues opened against this repository cannot be fixed here, because the code that produced the
> file does not live here.

Built from `__COMMIT__` — version `__VERSION__`.

## Use

Download `image_compare.html` and open it in a browser. Pick (or drag in) a folder whose
subdirectories each hold one modality of the same image set; files are matched into tuples by name.

| | Chrome / Edge | Firefox / Safari |
|---|---|---|
| view, compare, zoom, pan | yes | yes |
| winner voting | yes, saved to `results.txt` in the folder | in-session only |
| crop written back to every modality | yes | no |
| delete | yes | no |
| PPTX export | yes | yes |
| live folder polling (new, renamed and deleted files) | yes | no |

The split is not a feature decision: writing to a folder needs the File System Access API, which
Chrome and Edge expose and Firefox and Safari do not. Those browsers fall back to a read-only
folder listing, so everything that would modify your files is disabled rather than silently failing.

Dragging a folder in gives a read-only session even on Chrome. Use the folder **picker** if you
want voting, crop or delete.

## Same code as the extension

The matcher, viewer, voting, crop, PPTX export, deletion and polling are the *same modules* the VS
Code extension ships — not a reimplementation. The two products differ only in what they are wired
to: a browser's File System Access API here, the VS Code filesystem API there. A CI gate fails the
build if either side hand-implements a decision the other shares.

## Changelog

`CHANGELOG.md` is copied verbatim from the extension repository, so most entries describe the VS
Code extension. Entries that touch the shared modules — matching, crop, PPTX, results, thumbnail
ordering — apply here too; entries about VS Code panels, commands, packaging or marketplace
publishing do not.

## License

MIT, same as the extension. See `LICENSE`.
