# Plan: ImageCompare_standalone as a generated artifact (future work — not started)

This is a plan, not a description of anything built. Delete or fold into real docs when executed.

## Goal

`ImageCompare_standalone/image_compare.html` (today an independent, hand-written ~4.4k-line
implementation) becomes a build artifact of this repo: every push to main regenerates and pushes it,
and extension logic changes reach the standalone with **zero standalone-side code changes**.

## The one invariant that makes it worth doing

**The adapter contains no logic — only an IO backend.** It implements a narrow interface
(list directory, read file, write file, poll clock) over the browser's File System Access API, and
wires the existing message protocol (`types.ts`) to the existing webview bundle. Everything that
*decides* anything is imported from the same modules the extension uses: `fileService`'s exported
matcher, `modalityNames`, `pngText`, `ppmxParser`, `sessionFile` (parsing), the webview bundle
itself via `webviewShell.ts`. If a feature's logic lives only in `imageCompareProvider.ts`, it is
not available to the standalone until that logic is extracted into a pure module parameterized over
the IO interface — which is this repo's existing extraction discipline, applied with one more
motivation. **If the adapter starts accumulating standalone-only logic paths, stop: extract the
logic instead.** An adapter that re-implements behavior is the failure mode that makes the whole
byproduct idea pointless.

## Steps

1. **Audit** the current standalone against the extension: list features whose logic is
   provider-locked (watchers→polling, pool, burst gate, PPTX orchestration, crop write path) vs
   already-pure. The provider-locked list is the extraction backlog, each item its own small PR.
2. **`standalone/adapter.ts`** in this repo: the IO backend + protocol wiring. Feature flags via
   the init message: mode 1 + drop zone only, no Save Session, no Sharp (canvas decode; TIFF
   degrades, PPMX via the real parser), results.txt via FSA write, pptxgenjs from CDN.
3. **`scripts/build-standalone.mjs`**: esbuild adapter + `dist/webview.js`, inline both plus
   `webviewShell.ts` markup into one self-contained `image_compare.html`.
4. **CI**: a job on push to main builds the file and pushes it to `toshas/ImageCompare_standalone`
   via a deploy-key secret. The standalone repo becomes artifact-only (README + generated file).
5. **Cutover** only after a parity pass: the standalone's current hand-rolled matcher/features may
   have drifted from the extension's; diff behavior on shared fixtures before replacing it.

## Non-goals

Modes 2/3, the session-file entry point, NFS sweep semantics, marketplace packaging.
