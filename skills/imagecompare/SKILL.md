---
name: imagecompare
description: Open a side-by-side image comparison in the ImageCompare VSCode extension by writing and opening a `.imagecompare` session file. Use when you want to compare sets of images across folders or files (variants, model outputs, before/after) in a scrollable, zoomable viewer. Domain tools that resolve which images to compare should build on this skill.
---

# imagecompare — open a comparison via a `.imagecompare` session file

The `.imagecompare` **session file is the only way to open a comparison**, and the only CLI→viewer
bridge: the remote `code` CLI can open a *file* but cannot pass a folder list to a command, so every
comparison is a file on disk that opens into the viewer. Never try to drive the viewer another way.

## The file

Plain JSON, extension `.imagecompare`:

```json
{ "paths": ["/abs/dir", "../rel/dir"], "labels": ["A", "B"], "colors": ["#0af", "#f60"] }
```

- **`paths`** — required, 1+ entries. What gets compared. Relative paths resolve against the session
  file's own directory (so a committed session file stays portable). The entries decide the mode:

  | paths are | mode | meaning |
  |---|---|---|
  | one directory (with ≥2 image subdirs) | 1 | each **subdirectory** is a column; images matched across them by filename |
  | 2+ directories | 2 | each **directory** is a column; images matched by filename |
  | 2+ image files | 3 | one row; each file is a column |

  Directories are matched by filename into rows ("tuples"); a column is a "modality". Mixing files and
  directories is rejected, as is a lone image file — but a lone *directory* is mode 1.
- **`labels`** — optional; one per path, and **unique** (a label is a column's identity, so duplicates
  silently merge columns). Sets the pill name; effective only in mode 2, like `colors`. Omit to let
  the extension name columns from the paths.
- **`colors`** — optional; one per path, `#rgb` or `#rrggbb`. Overrides the default pill palette.
  Effective only in mode 2 (where the listed paths *are* the columns).

## Opening it

Write the file anywhere (a scratch/cache dir is fine — generated files are pruned after 30 days if
placed in the extension's session storage, but any location works), then open it:

- **Explorer**: right-click a folder selection → *Open in ImageCompare* (writes a session file and
  opens it), or just open an existing `.imagecompare` file — the custom editor renders it.
- **CLI / script / remote**: `code -r path/to/compare.imagecompare` from an integrated terminal.
  Opening the file *is* opening the comparison; there is no command that takes folders directly.

## Building a tool on top of this

A domain tool ("compare these runs / these variants") should:

1. Resolve the real image folders/files itself, **verifying each path exists** (`ls`/stat) — never
   emit a guessed path.
2. Write a `.imagecompare` file with those `paths` (+ optional `labels`/`colors`), in the order you
   want the columns.
3. Open it (`code -r`), and show the user the resolved path list.

Keep all path/domain logic in the tool; keep only the *format and opening* here. If you are writing
such a tool's skill, reference this one for the mechanics rather than restating them.
