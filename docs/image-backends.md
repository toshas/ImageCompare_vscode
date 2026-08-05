# Image Backends

How ImageCompare turns bytes into pixels, and the traps in the fallback chain.

Code: `sharpLoader.ts` (`getSharp`, the CPU workaround), `thumbnailService.ts` (`getJimp`,
`createSharpInstance`, `createJimpImage`), `ppmxParser.ts`, plus two packaging inputs —
`webpack.config.js`/`.vscodeignore` and `.github/workflows/publish.yml`. Pinned by
`src/test/ppmxParser.test.ts` (the decode half only); see [Testing](#testing).

## The intended chain

Sharp native → Sharp WASM → Jimp. Sharp (libvips) does resize/encode/metadata at native speed; Jimp
is a pure-JS backstop that always works but costs seconds per large image. The WASM tier exists to
keep pre-2009 x86 machines off Jimp.

`getSharp()` returns the module or `null`; every call site in `thumbnailService.ts` branches on that
one value. There is no per-operation feature detection — the decision is made once, at first load,
process-wide.

## Why Sharp is externalized but Jimp is bundled

Sharp is `externals: { sharp: 'commonjs sharp' }` in `webpack.config.js` and ships as real
`node_modules/`. This is not a preference: Sharp resolves its native binary at runtime by inspecting
platform/libc and `require`-ing a sibling `@img/sharp-<platform>` package. Bundling would freeze that
resolution at build time and strip the `.node` binaries — and that same runtime resolution is what
the "Unsupported CPU" workaround below hooks into, so bundling would make the workaround impossible,
not merely inconvenient.

What actually puts Sharp in the VSIX is the un-ignore list in `.vscodeignore`: `sharp`, `@img/*`,
`@emnapi/*`, plus Sharp's transitive runtime deps `detect-libc` and `semver` (sharp@0.34's colour code
lives under `@img/**`; see the file for the live list). Those transitive deps look droppable and are
not — trimming them breaks Sharp at runtime *in the VSIX only*, which no local test and no local run
catches.

Jimp has no native code, so webpack bundles it into `dist/extension.js` and `.vscodeignore` need not
mention it. It is loaded via a lazy `require('jimp').Jimp` inside `getJimp()`, not a static import —
a static import would pay Jimp's parse cost on every activation for a path that almost never runs.

Local gotcha: the same runtime resolution means a dev tree can silently hold the wrong platform's
binary — after cross-platform installs, or moving between machines. The symptom looks like a code
bug. Recovery: `npm rebuild sharp`, or `rm -rf node_modules && npm install`.

## The "Unsupported CPU" monkey-patch (`sharpLoader.ts`)

Sharp's native binaries require x86-64-v2 (SSE4.2+). On an older CPU the correct
`@img/sharp-linux-x64` package is present and does resolve — the `.node` loads, and sharp then
invalidates it and throws `Unsupported CPU`. Sharp's own fallback chain only reaches `@img/sharp-wasm32` when the native
package is *missing*. A present-but-throwing package is a case Sharp does not handle, so without
intervention an old CPU lands on Jimp.

The workaround: catch that error, purge every `sharp`/`@img` entry from `require.cache` so Sharp's
platform detection re-runs from scratch, then temporarily replace `Module._resolveFilename` with one
that throws `MODULE_NOT_FOUND` for any `@img/sharp-*` request that isn't `wasm32` — turning "present
but broken" into "absent", which Sharp *does* handle. The patch is restored in a `finally`, because
it is a process-global mutation and any leak would break unrelated `require`s.

Both halves are load-bearing. Node evicts the modules that threw, but the native `@img/sharp-*`
binding loaded *fine* — Sharp rejected it on a CPU check afterwards — so it stays in `require.cache`,
and `Module._load`'s `relativeResolveCache` fast path returns it before `Module._resolveFilename` is
consulted, bypassing the block. Without the resolver block it finds the native package again.

## The WASM tier ships from CI only — never from a local build

`@img/sharp-wasm32` declares `cpu: ["wasm32"]`. No real machine matches, so npm always skips it —
listing it under `optionalDependencies` installs nothing, ever. After a normal install it is absent
from `node_modules/@img/`, `node_modules/@emnapi/` is an empty directory (no `runtime/` at all), and
a locally produced VSIX has zero wasm32
files: a local VSIX is Sharp → Jimp, so never hand one to someone on an old CPU or use it to judge
fallback behaviour.

`.github/workflows/publish.yml` delivers the tier: it `npm pack`s `@img/sharp-wasm32`, untars it into
`node_modules/@img/`, and installs `@emnapi/runtime`. The order is load-bearing: one might worry that
`npm install @emnapi/runtime` *after* the manual extraction reconciles the tree and prunes the
hand-placed `cpu: wasm32` package — it doesn't, but reordering the steps would silently drop the tier.

A CI step after `vsce package` scans the VSIX's zip entries and fails the build if
`@img/sharp-wasm32/lib/sharp-wasm32.node.wasm` or `@emnapi/runtime/` is missing — which transitively
guards the `!node_modules/@img/**` and `!node_modules/@emnapi/**` un-ignores, but not the rest of the
list (`vsix-modules-hand-assembled`). To check any published build without cutting a release:

```bash
curl -sL -o v.vsix "https://open-vsx.org/api/obukhovai/image-compare/linux-x64/<VERSION>/file/obukhovai.image-compare-<VERSION>@linux-x64.vsix"
unzip -l v.vsix | grep wasm32   # expect lib/sharp-wasm32.node.wasm
```

## Why PPMX needs a custom path

PPMX is a bespoke float32 grayscale format that no image library knows.

Wire format (`ppmxParser.ts` is the only reader; this is the contract):

```
line 1:  PPMX | P7              magic — both spellings are PPMX, not two formats
line 2:  <width> <height>       ASCII decimal, space-separated
line 3:  <flags>                OPTIONAL; only '00000000000' is known, others warn and parse on
body:    width*height float32   little-endian, row-major, no padding
```

Either magic may appear with or without the flags line — all four combinations are the same format.
Real-world producers emit `PPMX` with no flags line, the only combination observed in the wild, but
the parser accepts all four because the format never specified which.

Size decides *whether* to look for a flags line: if the bytes after line 2 already equal
`width*height*4`, there is none. When they do not match, one line is consumed as flags — but only if
it is non-empty and printable (`looksLikeFlags`). That printable guard is load-bearing: a float pixel
of `1.4e-44` is the bytes `0A 00 00 00`, whose first byte is a bare `\n` that size alone would read
as an empty flags line, consuming a real pixel byte. Size never trusts the magic; the printable check never trusts the raw
bytes. Test 11 pins it.

Where the format came from: the parser originally required the `P7` magic *and* a flags line, so it
threw `Unexpected PPMX header` on every real file and PPMX had never once rendered. Nothing caught
it — no test fed the parser real bytes, and a `.ppmx` slot fails as an unresolved image rather than a
visible error.

`ppmxParser.ts` also min/max normalizes the float range to 0-255, because the values are unbounded
physical quantities (depth), not display intensities. The output is a headerless RGB buffer, so it
cannot be handed to `sharp(buffer)` or `Jimp.fromBuffer()`; it must be injected with explicit
dimensions (`raw: {width, height, channels: 3}` for Sharp, `fromBitmap` with an RGBA-expanded copy
for Jimp). That asymmetry is why `createSharpInstance()` / `createJimpImage()` exist: they keep the
PPMX special case in two places instead of at every call site.

Two places, not one, is already optimistic: `createSharpInstance` is `private`, so
`handleExportPptx`'s `loadImageBase64Unpooled` carries a hand-copied duplicate of the Sharp branch
that nothing keeps in sync (`ppmx-through-helpers`).

## A Sharp instance is reusable (this looks like a bug and isn't)

`loadFullImage`'s TIFF/PPMX path calls `.metadata()` and then `.png().toBuffer()` on the same
instance. Every streaming intuition (Node streams, single-use pipelines) says the first call consumes
it — it doesn't: Sharp re-reads from the input buffer internally, so the instance is safe to reuse.
Don't "fix" this by constructing a second instance: that adds a silent second decode of the same
bytes on the pool, for nothing.

## Why the sync/base64 work matters

Every backend result crosses into the webview as a base64 data URL. `toString('base64')` is
synchronous and unyieldable on the extension-host thread, and its cost scales with payload size — so
the size of what a backend emits is an extension-host responsiveness question, not just a memory one.
This is why `loadFullImage` passes browser-decodable formats (jpg/png/gif/webp/bmp) through as
original bytes and only decodes TIFF/PPMX: re-encoding a 12MP JPEG to PNG both burned Sharp pool time
and inflated the string being synchronously encoded ~10x. See `docs/loading-architecture.md` for the
scheduling side of this.

Thumbnails are cached on disk as raw `.jpg`; a disk hit is re-base64'd, an in-memory hit returns the
stored string. That re-encode is cheap only because the images are small — `thumbnailSize` (default
100) is decoded at 2x, so 200px by default and 400px at the setting's maximum.

## Testing

Of the suites `publish.yml` gates on (`docs/testing.md`), only `ppmxParser.test.ts` touches this
subsystem, and only the pure decode half. `pngTextChunk.test.ts` uses Sharp to mint a fixture PNG and
re-read it, so a native Sharp must load for it to run at all — but that exercises Sharp incidentally,
not the loader or the tiers. Nothing tests Jimp or `sharpLoader.ts`, so the fallback chain is
verified by hand or not at all. `sharpLoader.ts` is ordinary bundled source — of the npm packages only `sharp`
is external (`vscode` aside, which the host provides) — so the shipped bundle is precisely what exercises the loader, against a real installed
`node_modules/sharp`. That is what makes a test awkward: there is no seam to stub, so a test would have
to simulate the `Unsupported CPU` throw (no CI runner is old enough to produce one naturally) and would
then hit a wasm32 tier that a normal install does not have (above).

## Invariants

- **`sharp-externalized`** — Sharp stays externalized. Bundling it breaks native binary resolution
  and disables the `Module._resolveFilename` workaround entirely.
- **`resolver-always-restored`** — `Module._resolveFilename` is always restored, on every path,
  including throws.
- **`jimp-lazy-required`** — Jimp stays lazily required. No static `import` from `jimp` anywhere in
  the extension host.
- **`ppmx-through-helpers`** — any backend call that must handle PPMX goes through
  `createSharpInstance()` / `createJimpImage()`, or PPMX breaks on that call site only — silently and
  per-format. Two exceptions today: `readCropMetadata` calls `sharp(buffer).metadata()` directly,
  safe *only* because crops are always PNG (widen its inputs and it must move behind the helper); and
  `handleExportPptx`'s `loadImageBase64Unpooled` re-implements the PPMX branch inline, because
  `createSharpInstance` is `private` to `thumbnailService`. The second is a *duplicate*, not an
  opt-out: a change to the PPMX→Sharp injection needs edits in both `thumbnailService.ts` and
  `imageCompareProvider.ts`, and nothing — no compiler, no test — connects the two.
- **`backends-agree-output`** — Sharp and Jimp must agree on output: JPEG quality 70 for thumbnails,
  and identical dimensions, or the backend in use becomes user-visible.
- **`metadata-written-twice`** — crop metadata is written twice — EXIF (Sharp only) *and* a PNG
  `tEXt` chunk — because the Jimp path cannot write EXIF and the tEXt chunk is the cross-tool
  contract. Readers must accept either.
- **`passthrough-no-backend`** — browser-decodable formats never touch a backend in `loadFullImage`,
  not even for `metadata()`.
- **`vsix-modules-hand-assembled`** — the VSIX's `node_modules` is hand-assembled and only checkable
  in the artifact. Two lists build it — the `.vscodeignore` un-ignores and the wasm32 steps in
  `publish.yml` — and dropping from either passes every test and every local run while shipping users
  a silent Jimp fallback (or no Sharp at all). The CI VSIX scan covers *part* of the un-ignore list:
  requiring `@img/sharp-wasm32/lib/sharp-wasm32.node.wasm` and `@emnapi/runtime/` in the artifact
  transitively pins `!node_modules/@img/**` and `!node_modules/@emnapi/**`, since nothing else ships
  them. It does **not** cover `!node_modules/sharp/**` or the transitive deps (`detect-libc`,
  `semver`) — drop one of those and CI still passes green. Narrowing `!node_modules/@img/**` to just
  the wasm32 subtree would also pass while killing the native tier.
