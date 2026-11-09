# Image Backends

How ImageCompare turns bytes into pixels, and the traps in the fallback chain.

Code: `sharpLoader.ts` (`getSharp`, the CPU workaround), `thumbnailService.ts` (`getJimp`,
`createSharpInstance`, `createJimpImage`), `ppmxParser.ts`, plus two packaging inputs —
`webpack.config.js`/`.vscodeignore` and `.github/workflows/publish.yml`. Tests: see
[Testing](#testing).

## The intended chain

Sharp native → Sharp WASM → Jimp. Sharp (libvips) does resize/encode/metadata at native speed; Jimp
is a pure-JS backstop that always works but costs seconds per large image. The WASM tier keeps
pre-2009 x86 machines off Jimp. The universal target ships no native binary, so WASM also keeps every
host without a VS Code platform build off Jimp (below).

`getSharp()` returns the module or `null`; every call site in `thumbnailService.ts` branches on that
one value. There is no per-operation feature detection — the decision is made once, at first load,
process-wide.

## Why Sharp is externalized but Jimp is bundled

Sharp is `externals: { sharp: 'commonjs sharp' }` in `webpack.config.js` and ships as real
`node_modules/`. This is not a preference. Sharp resolves its native binary at runtime: it inspects
platform/libc and `require`s a sibling `@img/sharp-<platform>` package. Bundling freezes that
resolution at build time and strips the `.node` binaries. The "Unsupported CPU" workaround below
hooks into that same resolution, so bundling makes it impossible, not merely inconvenient.

The un-ignore list in `.vscodeignore` puts Sharp in the VSIX (see the file for the live list):
- `sharp`
- `@img/*` (sharp@0.34's colour code lives here)
- `@emnapi/*`
- Sharp's transitive runtime deps `detect-libc` and `semver`.

Those deps look droppable and are not. Trimming them breaks Sharp at runtime *in the VSIX only*,
which no local test and no local run catches.

Jimp has no native code, so webpack bundles it into `dist/extension.js` and `.vscodeignore` need not
mention it. `getJimp()` loads it with a lazy `require('jimp').Jimp`. A static import would pay Jimp's
parse cost on every activation, for a path that almost never runs.

Local gotcha: the same runtime resolution lets a dev tree silently hold the wrong platform's binary,
after cross-platform installs or a move between machines. The symptom looks like a code bug.
Recovery: `npm rebuild sharp`, or `rm -rf node_modules && npm install`.

## The "Unsupported CPU" monkey-patch (`sharpLoader.ts`)

Sharp's native binaries require x86-64-v2 (SSE4.2+). On an older CPU the correct
`@img/sharp-linux-x64` package is present and resolves: the `.node` loads, then sharp invalidates it
and throws `Unsupported CPU`. Sharp's own fallback chain reaches `@img/sharp-wasm32` only when the
native package is *missing*. Sharp does not handle a present-but-throwing package, so without
intervention an old CPU lands on Jimp.

The workaround: catch that error and purge every `sharp`/`@img` entry from `require.cache`, so Sharp's
platform detection re-runs from scratch. Then temporarily replace `Module._resolveFilename` with one
that throws `MODULE_NOT_FOUND` for any non-`wasm32` `@img/sharp-*` request. That turns "present but
broken" into "absent", which Sharp *does* handle. A `finally` restores the resolver: it is a
process-global mutation, and any leak would break unrelated `require`s.

Both halves are load-bearing. Node evicts the modules that threw, but the native `@img/sharp-*`
binding loaded *fine*; Sharp rejected it afterwards on a CPU check. It stays in `require.cache`, where
`Module._load`'s `relativeResolveCache` fast path returns it before `Module._resolveFilename` is
consulted, bypassing the block. Without the resolver block it finds the native package again.

## The WASM tier ships from CI only — never from a local build

`@img/sharp-wasm32` declares `cpu: ["wasm32"]`. No real machine matches, so npm always skips it —
listing it under `optionalDependencies` installs nothing, ever. After a normal install:
- it is absent from `node_modules/@img/`;
- `node_modules/@emnapi/` is an empty directory (no `runtime/` at all);
- a locally produced VSIX has zero wasm32 files.

A local VSIX is Sharp → Jimp: never hand one to someone on an old CPU or use it to judge fallback
behaviour.

`.github/workflows/publish.yml` delivers the tier. On every target it installs `@emnapi/runtime`,
then `npm pack`s `@img/sharp-wasm32` and untars it into `node_modules/@img/` as the step's **last**
action. The order is load-bearing, and the hazard is npm-version-dependent. A bare `npm install` after
the manual extraction reconciles the tree and can prune the hand-placed `cpu: wasm32` package. npm 11
does (`removed 1 package`), npm 10.8.2 (Node 20, which CI pins) does not. Relying on the pinned
version is not a plan, so no install runs after the extract at all.

A CI step after `vsce package` scans the VSIX's zip entries. It fails the build if
`@img/sharp-wasm32/lib/sharp-wasm32.node.wasm` or `@emnapi/runtime/` is missing (what that does and
does not cover: `vsix-modules-hand-assembled`). To check any published build without cutting a
release:

```bash
curl -sL -o v.vsix "https://open-vsx.org/api/obukhovai/image-compare/linux-x64/<VERSION>/file/obukhovai.image-compare-<VERSION>@linux-x64.vsix"
unzip -l v.vsix | grep wasm32   # expect lib/sharp-wasm32.node.wasm
```

## Nine platform targets, and a universal one underneath

VS Code picks a platform-specific extension by matching the **server's** platform: on a remote or WSL
session, the Linux host, not the client. When no published target matches, the install is refused
with *"not compatible with the current version of Visual Studio Code"*. That message names
`engines.vscode`, pointing away from the cause: the engine range was never the problem. That is how a
six-of-nine matrix went unnoticed until a user hit it. On an Alpine, musl or 32-bit ARM host the error
reads as a version mismatch (`docs/testing.md`, Findings).

`publish.yml` now builds all nine of VS Code's node targets, plus a target-less build the marketplaces
list as **(universal)**:
- `win32-{x64,arm64}`
- `linux-{x64,arm64,armhf}`
- `alpine-{x64,arm64}`
- `darwin-{x64,arm64}`

Two naming traps live in that list. 32-bit ARM is `linux-armhf` to VS Code and `--cpu=arm` to npm.
musl is not an `--os`: `--os=linux --cpu=x64` installs *both* `@img/sharp-linux-x64` and
`@img/sharp-linuxmusl-x64`.

**`--libc=musl` does not separate them here, and the flag looks correct exactly because it works
everywhere else.** npm filters an optional dependency on the `os`/`cpu`/`libc` fields *of the
installed tree*. `package-lock.json`'s `@img/sharp-*` entries carry `os` and `cpu` but **no `libc`**
(of its 14 `libc` fields, 13 belong to `@rollup/*` and one to `@napi-rs/lzma-linux-x64-gnu`). On a
lockfile-driven install the override has nothing to filter, and the glibc tier is restored beside the
musl one. In a clean directory with no lockfile, `--libc=musl` does resolve musl alone.

Measured with CI's own npm (Node 20 / npm 10.8.2) on this repo's lockfile: `npm ci` →
`rm -rf node_modules/sharp node_modules/@img` → `npm install --os=linux --cpu=x64 --libc=musl --force
sharp` leaves `sharp-linuxmusl-x64` **and** `sharp-linux-x64`. Two ways out existed: regenerate the
lockfile on an npm that records `libc`, or prune after installing. The second ships: it is local to
the one step that has the problem, and does not make every other job depend on a regenerated
lockfile.

So the install step ends by deleting every `@img/sharp-*` that is not the target's own
`sharp-<plat>-<cpu>` / `sharp-libvips-<plat>-<cpu>` pair. `<plat>` is `linuxmusl` when the matrix
says `--libc=musl`. `@img/colour` does not match the glob, and the wasm32 tier is extracted
afterwards, so neither is in the prune's way.

The prune must come after the **last** `npm install`, not right after sharp's. `npm install
@emnapi/runtime` reconciles the tree against the lockfile and re-adds the *runner's* natives, which
on a cross-compiled leg are not the target's. Measured on a linux x64 host with CI's npm, running the
recipe without the prune loop:
- `linux-armhf` reaches that point holding `sharp-linux-x64`, `sharp-linuxmusl-x64` and both their
  libvips packages beside its own `sharp-linux-arm` pair;
- `alpine-x64` holds the glibc pair beside its musl one.

(This is about a recipe on a linux runner, not the darwin legs, which CI builds on macOS.) That is
also why the universal build no longer needs a bespoke order: every target now runs its installs,
then prunes, then hand-extracts wasm32 last.

A wrong-libc VSIX is worse than a missing one: it installs, then fails at runtime. The post-package
scan reads the VSIX's zip central directory and holds every leg to one rule. The packed `@img/*` set
is **exactly** these, no more, no less:
- `colour`
- this target's own `sharp-<plat>-<cpu>` / `sharp-libvips-<plat>-<cpu>` pair
- `sharp-wasm32`

Two shapes fall out of that one rule without cases of their own: win32 has no separate
`sharp-libvips-win32-*` package (its libvips lives inside the platform package), and universal has no
native pair. A matrix target with no entry in the expectation table fails the build rather than
passing unchecked.

**An allow-set, and that is the whole point.** The check it replaced, which 0.4.0 shipped under,
looked only for the WASM tier's two paths and never read the `@img` set, so stray natives rode along.
A per-target *deny*-list, drafted here as its replacement and rejected before commit, would not have
helped. It names strays for four of the ten legs and checks the other six only for their own binary's
presence. Measured by packaging with the pre-prune recipe:
- a `linux-arm64` VSIX carrying four libvips tiers passes both weaker checks and exits 1 under the
  allow-set. It is a local rebuild of 36,092,593 bytes reproducing the shape 0.4.0 shipped
  (published: 36,092,188 bytes; pruned: 12,528,278);
- pre-prune `linux-x64` and `linux-armhf` also pass both weaker checks and exit 1 under the
  allow-set;
- all ten pruned legs still exit 0.

The build matrix runs `fail-fast: false`, so one target's packaging defect reports itself instead of
cancelling the other nine legs mid-flight.

The universal VSIX is the backstop for whatever remains (a host VS Code names no target for, or a
registry that serves the default). It carries the WASM tier and **no** native `@img/sharp-*`, so its
chain starts one rung down: WASM, then Jimp. Its keep-set is empty, so the same prune that trims a
platform build strips it completely.

Measure a VSIX's size on the artifact: `ls -la *.vsix`, and `unzip -l <vsix> | sort -rn` for what
costs. If a VSIX grows or shrinks by more than ~1 MB and you added no native dependency, a libvips
tier was added or dropped; check that before believing the build is fine.

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
Real-world producers emit `PPMX` with no flags line, the only combination observed in the wild. The
parser accepts all four because the format never specified which.

Size decides *whether* to look for a flags line: if the bytes after line 2 already equal
`width*height*4`, there is none. Otherwise one line is consumed as flags, but only if it is non-empty
and printable (`looksLikeFlags`).

That printable guard is load-bearing. A float pixel of `1.4e-44` is the bytes `0A 00 00 00`, whose
first byte is a bare `\n`. Size alone would read it as an empty flags line, consuming a real pixel
byte. Size never trusts the magic; the printable check never trusts the raw bytes. Test 11 pins it.

Where the format came from: the parser originally required the `P7` magic *and* a flags line. It
threw `Unexpected PPMX header` on every real file, and PPMX had never once rendered. Nothing caught
it: no test fed the parser real bytes, and a `.ppmx` slot fails as an unresolved image, not a visible
error.

`ppmxParser.ts` also min/max normalizes the float range to 0-255, because the values are unbounded
physical quantities (depth), not display intensities. The output is a headerless RGB buffer that
`sharp(buffer)` and `Jimp.fromBuffer()` cannot take. It must be injected with explicit dimensions:
`raw: {width, height, channels: 3}` for Sharp, `fromBitmap` with an RGBA-expanded copy for Jimp. That
asymmetry is why `createSharpInstance()` / `createJimpImage()` exist: they keep the PPMX special case
in two places instead of at every call site.

## A Sharp instance is reusable (this looks like a bug and isn't)

`loadFullImage`'s TIFF/PPMX path calls `.metadata()` and then `.png().toBuffer()` on the same
instance. Every streaming intuition (Node streams, single-use pipelines) says the first call consumes
it. It doesn't: Sharp re-reads from the input buffer internally, so the instance is safe to reuse.
Don't "fix" this with a second instance: that adds a silent second decode of the same bytes on the
pool, for nothing.

## Why the sync/base64 work matters

Full images cross into the webview as binary: `loadFullImage` returns `Uint8Array`, and the webview
blob-URLs it and revokes after decode. Base64 delivery cost the ×1.33 inflation plus GC pauses, seen
as 10-22ms main-thread tasks in traces. Thumbnails followed for the same reason at ~1000× the message
count (`docs/loading-architecture.md`, "Thumbnails ship as bytes"). Base64 now remains on exactly one
path: PPTX slide images, because pptxgenjs takes base64. There, `toString('base64')` is synchronous
and unyieldable on the extension-host thread, and its cost scales with payload size. So the size of
what a backend emits is a responsiveness question, not just a memory one.

This is also why `loadFullImage` passes browser-decodable formats (jpg/png/gif/webp/bmp) through as
original bytes and decodes only TIFF/PPMX. Re-encoding a 12MP JPEG to PNG both burned Sharp pool time
and inflated the payload ~10x. See `docs/loading-architecture.md` for the scheduling side.

Thumbnails are cached on disk as raw `.jpg`, one file per entry. The memory cache holds raw JPEG
bytes, and `getThumbnail` hands those same bytes to the wire, with no representation change anywhere.
The images stay small on purpose: `thumbnailSize` (default 100) is decoded at 2x, so 200px by default
and 400px at the setting's maximum.

On top of the per-entry files sits the **packfile**: `thumbs.pack` + `thumbs.idx` in the cache dir.
It is a rename-only snapshot of the memory cache, so the cache cap bounds its size. A warm open costs
one sequential read instead of thousands of small ones: seconds versus sub-second on a network mount.
The pack loads lazily on the first thumbnail request. Its entries are `key → offset/length` slices
sharing one buffer (`thumbPack.ts`, pure and suite-pinned).

Per-entry files remain the only *write* path during a session; concurrent windows never append to a
shared file. The snapshot is idle-debounced, written to temp names and published by rename. The
debounce is 30s of idle, longer than a testing-style session lives. Closing the window inside it used
to *cancel* the pending write. A user who reloads often could then go many cycles with no pack on
disk, every open paying the per-entry read path. A close now publishes instead of cancelling
(`thumb-pack-survives-close`).

With the per-entry writes it settles, that is all the shutdown work this service does. It is bounded
by the memory-cache cap and safe to lose, since publication is still rename-only.

The per-entry `.jpg` write is deliberately *not* awaited where it is issued. A thumbnail is on screen
as soon as its bytes exist, never after a disk round-trip. The write is registered instead, and
`flush()` is where the wait happens. A `flush()` that returned with those writes outstanding dropped
the newest thumbnails on a host exit. In a test bed, it left files landing in a directory the
teardown was already removing.

## What the cache key sees, and when the cache dies

The key is `sha256(uri + mtime + ctime + size)` truncated to 16 hex chars, and every component pays
for itself:
- `mtime` catches an ordinary edit.
- `size` catches a changed `thumbnailSize` setting (mtime does not move when a setting does).
- `ctime`, the inode *change* time, catches what neither of the others can see.

These rewrite a file **in place** with different pixels, the same byte count and the same mtime:
- `cp -p`, `rsync --times`, `tar -p`
- any training loop that restores timestamps.

Under an mtime+size key that is a cache hit: the user sees an image no longer on disk, and no event
will ever invalidate it. Inode change time moves on every content or metadata write and no tool can
set it. It is the one field a preserving copy cannot fake.

Two caveats, both deliberate:

- **`vscode.FileStat.ctime` is not this field.** VS Code documents `ctime` as the *creation*
  timestamp, and its disk provider returns `birthtime`, which an in-place overwrite leaves untouched.
  Keying on it would look like a fix and change nothing. `statForKey` therefore stats `file:` URIs
  through node (`fs.promises.stat` → `ctimeMs`), one call *replacing* the previous
  `workspace.fs.stat`, not added to it.

  The hot path is never dearer, but for an ordinary image not cheaper either. VS Code's disk provider
  issues a single `lstat` for a regular file and adds a `stat` only for a symlink. The syscall count
  is *equal* for a regular image and one lower only for a symlinked one. What the direct call always
  drops is the `workspace.fs` provider layer, not a syscall.

  Other schemes fall back to `workspace.fs.stat`, where the key degrades to the old mtime+size
  behaviour and an in-place overwrite is invisible again.
- **Not every filesystem tracks it.** On ext4/APFS/NTFS the field is real (NTFS `ChangeTime` cannot
  be set through `SetFileTime`). On FAT/exFAT, and on network filesystems that synthesise stat, it
  can simply track mtime. There the key is no worse than before, never better. In the other
  direction `ctime` also moves on `chmod`, `chown` and rename, so those now miss where they used to
  hit. That is the right trade both ways: a spurious miss costs one regeneration, a false hit shows
  the wrong picture.

A changed key is a dead key, so `evictSuperseded` evicts the entry it replaced rather than leaving it
to age out. It drops the entry from the memory cache, the loaded pack map and (fire and forget) disk,
driven by a session-held `uri → last key` map. Without it, a producer that rewrites its outputs every
few minutes leaves one dead `.jpg` per file per rewrite until the weekly sweep. Every dead entry also
keeps occupying the byte-capped memory cache.

The map costs one short string per URI seen, noise beside the ~192 MB the entries may hold (a real
cache of 26k thumbnails at ~4.3KB of raw JPEG each is ~110MB). The eviction path costs a syscall only
when a key actually changed. A pack already published on disk can still carry a dead key. That is
harmless: nothing asks for it again, and the next snapshot (built from the memory cache) drops it.

Expiry is by last **use**, not last write. `cleanupOldCache` deletes anything in the cache dir older
than `imageCompare.cacheMaxAgeDays` (7), and a fully warm session writes nothing. The pack serving
every thumbnail used to expire *while in active use*. A daily user got one cold open a week, of the
worst kind: thousands of small reads on a network mount. The pack pair is therefore stamped on use: a
successful load calls `touchPack`, two `utimes` per session, against the thousands a touch-on-read
would cost. Per-entry `.jpg`s still expire by write time, because they are redundant once their bytes
are in the pack.

A disk-tier hit re-enters the memory cache as pack-dirty, so anything the pack lacks is published
into the next snapshot.

A stamp cannot stop a sweep that has already decided:
- `initialize` starts `cleanupOldCache` without awaiting it, so this window's sweep can stat the pack
  just before the load's `touchPack` lands;
- another window's sweep is unconstrained;
- a user can empty the cache directory by hand.

The in-memory map keeps serving in each case, but that alone is half the goal. A *fully* warm session
marks nothing dirty, the debounced snapshot is skipped, and the pack stays deleted. The next open is
the cold one this mechanism exists to prevent. So the session checks.

Whenever a publish is *considered* (the idle snapshot or the close flush) with nothing dirty to
publish, a session that loaded a pack stats the pair (`packGone`). If either half is missing, it marks
the cache dirty, and the ordinary rename-only publish puts the pack back. That costs two stats per
publish *decision*: a handful per session, against one per thumbnail. A session that never loaded a
pack, or already has something to publish, pays zero.

The guard order matters for a second reason: on the dirty path no `await` runs before the entries are
captured, so `thumb-pack-survives-close`'s synchronous capture is untouched. What comes back is the
memory cache: the entries this session served, not necessarily every entry the deleted pack held. One
residual edge is accepted: a pack lost or unparseable *before* this session could load it, with its
per-entry files already aged out, costs one cold session that rebuilds.

## Testing

`publish.yml`-gated unit suites (`docs/testing.md`) touching this subsystem:
- `test/unit/ppmxParser.test.ts`: the pure decode half.
- `test/unit/thumbPack.test.ts`: the real `thumbPack.ts` packfile wire format.
- `test/unit/thumbPackFlush.test.ts`: the pack's *lifetime*. The real `ThumbnailService` generates
  real thumbnails into a real temp `globalStorageUri` through the fs-backed `vscode` mock, then closes.
- `test/unit/thumbCacheKeying.test.ts`: a real in-place overwrite (mtime and size restored) and the
  superseded key's eviction.
- `test/unit/thumbCacheExpiry.test.ts`: a backdated cache dir swept while the pack is in use, and a
  pack deleted mid-session that the close puts back.
- `test/unit/thumbTierStats.test.ts`, `test/unit/thumbSharedWait.test.ts`: the real
  `ThumbnailService`'s tier and pack-load accounting.

`test/unit/pngTextChunk.test.ts` uses Sharp to mint a fixture PNG and re-read it, so a native Sharp
must load for that one test to run, but it exercises Sharp incidentally, not the loader or tiers.

The two fallback tiers are pinned as far as this machine can honestly reach, and no further.
`sharpLoader.ts` is ordinary bundled source; of the npm packages only `sharp` is external (the host
provides `vscode`). There is no seam to stub, so both suites play the *environment* through
`Module._load`, which the loader's own `require` goes through:

- `test/unit/sharpLoaderTiers.test.ts` — the **decision**, not the decode. A native load that throws
  `Unsupported CPU` must retry with native `@img/sharp-*` made to look absent and wasm32 left
  resolvable. It must also:
  - put `Module._resolveFilename` back on every path;
  - return `null` rather than throw when the retry fails too;
  - not retry an error that is not the CPU signature.

  A real wasm32 decode is **not** pinned: the package declares `cpu: ["wasm32"]`, so no test-layer
  install has it. Only `publish.yml`'s runners do, by hand-extracting the tarball. It was verified by
  hand instead, on a tree assembled the way `publish.yml` assembles the universal one:
  - sharp and `@emnapi/runtime` installed;
  - natives removed;
  - wasm32 hand-extracted.

  There `require('sharp')` loaded, reported `vips 8.17.3` from the emscripten build, and round-tripped
  a JPEG at the right dimensions.
- `test/unit/jimpFallback.test.ts` — the **Jimp tier end to end**, with the real `ThumbnailService`
  and the real Jimp. Sharp fails both tiers, and a hand-built PNG comes back as a JPEG with its pixels
  still red. Its dimensions are read out of the frame header, an external pin: no backend decodes
  that assertion. The suite also covers the full-image PNG conversion branch.

`test/unit/publishTargets.test.ts` sits beside them for the packaging half:
- which platform targets are built;
- that `--libc` reaches npm;
- that every matrix target has an entry in the artifact scan's expectation table.

## Invariants

- **`thumb-pack-atomic`** — the pack and its idx are only ever valid as a *pair*. Both carry the same
  uuid. The reader (`parsePack`) discards the whole pack on any mismatch, size discrepancy,
  out-of-bounds entry or duplicate key. The writer publishes exclusively by rename of both temp
  files. A discarded pack costs a slower open; a torn pair that served bytes would show wrong
  thumbnails. Writers never append: two windows snapshotting concurrently means the last rename wins
  wholesale, never an interleaved file.
- **`thumb-pack-survives-close`** — no write the *thumbnail path* started is dropped on the way out:
  - `dispose()` *starts* the pending pack write rather than cancelling the timer.
  - `flush()` awaits the pack write in flight, the pending one **and** the outstanding per-entry cache
    writes: the `.jpg` save and the supersede-delete, both issued un-awaited on purpose and therefore
    registered where they are issued.
  - `deactivate` awaits `flush()` (through the provider) before the host exits.

  The age sweep `initialize()` starts is deliberately **outside** this. It only deletes, so it can
  lose nothing and can create nothing under a directory someone is removing. Awaiting a whole cache
  scan would buy a free re-run next session at the price of a slow exit. Entries are captured when a
  write is *queued*, so `flush()` queues the snapshot before its first `await`; otherwise the
  per-entry wait would reintroduce the gap the capture closes. The `clearMemoryCache()` on the same
  shutdown path then cannot turn a queued write into an empty pack published over a good one.

  A violation is invisible at runtime: no error, no wrong pixel, just a cold next open, which is
  exactly the slowness this pack exists to remove.
- **`thumb-key-sees-overwrite`** — the cache key covers the file's content identity, not just its
  advertised mtime: `uri + mtime + ctime + size`. `ctime` is the inode *change* time, node
  `fs.stat().ctimeMs` for `file:` URIs in `statForKey` (`vscode.FileStat.ctime` is birth time and
  would fix nothing). Drop that component, or source it from vscode's stat, and an mtime-preserving
  in-place overwrite serves the previous image forever. Nothing is left that could invalidate it:
  wrong pixels, silently, with no error and no log line.

  A changed key must also *evict* the one it superseded (`evictSuperseded`: memory, loaded pack map,
  per-entry file), or a rewriting producer accumulates one dead entry per rewrite until the weekly
  sweep.
- **`thumb-cache-expires-by-use`** — nothing the running session is serving from may be swept out
  from under it. `cleanupOldCache` prunes by age, so the pack pair carries a last-*use* stamp
  (`touchPack`, once per session on a successful load), not a last-write mtime a warm session never
  advances. Per-entry `.jpg`s may expire: a disk hit re-enters the memory cache as pack-dirty, so
  their bytes reach the next snapshot. But a pack that is answering requests must not.

  When one is deleted anyway (another window's sweep, this window's un-awaited one racing the load, a
  manual clear), the session that loaded it must put it back. At every publish decision that would
  otherwise write nothing, `packGone` stats the pair and a missing half marks the cache dirty, since
  a fully warm session produces no other signal that would. A violation shows up only as one
  inexplicably cold open per `cacheMaxAgeDays`, on the mounts where it hurts most.
- **`sharp-externalized`** — Sharp stays externalized. Bundling it breaks native binary resolution
  and disables the `Module._resolveFilename` workaround entirely.
- **`resolver-always-restored`** — `Module._resolveFilename` is always restored, on every path,
  including throws.
- **`jimp-lazy-required`** — Jimp stays lazily required. No static `import` from `jimp` anywhere in
  the extension host.
- **`ppmx-through-helpers`** — any backend call that must handle PPMX goes through
  `createSharpInstance()` / `createJimpImage()`, or PPMX breaks on that call site only, silently and
  per-format. Two exceptions today:
  - `readCropMetadata` calls `sharp(buffer).metadata()` directly, safe *only* because crops are
    always PNG (widen its inputs and it must move behind the helper).
  - `handleExportPptx`'s `loadImageBase64Unpooled` re-implements the PPMX branch inline, because
    `createSharpInstance` is `private` to `thumbnailService`.

  The second is a *duplicate*, not an opt-out. A change to the PPMX→Sharp injection needs edits in
  both `thumbnailService.ts` and `imageCompareProvider.ts`, and nothing (no compiler, no test)
  connects the two.
- **`backends-agree-output`** — Sharp and Jimp must agree on output: JPEG quality 70 for thumbnails,
  and identical dimensions, or the backend in use becomes user-visible.
- **`metadata-written-twice`** — crop metadata is written twice: EXIF (Sharp only, inside
  `thumbnailService.cropImage`) *and* a PNG `tEXt` chunk, injected once for every render path by the
  shared crop flow in `cropFlow.ts`, because the Jimp path cannot write EXIF and the tEXt chunk is
  the cross-tool contract. Readers must accept either.
- **`passthrough-no-backend`** — browser-decodable formats never touch a backend in `loadFullImage`,
  not even for `metadata()`.
- **`all-platform-targets-built`** — the publish matrix covers every platform target VS Code can ask
  for, plus a universal build for whatever it cannot name. Dropping a target is invisible here and
  shows there as an engine mismatch (see above).
- **`pull-request-builds-never-publish`** — a pull request builds all ten VSIXes with the tag's own
  recipe and can publish nothing; both halves are load-bearing.

  *Builds*: only a real build exercises the per-target Sharp install, the libvips prune and the
  packed-VSIX scan. Before a PR ran one, they first ran at tag time: the irreversible step, since
  neither marketplace unpublishes cleanly. That is how 0.4.0's four-tier `linux-arm64` VSIX reached
  users. So the ten legs remain ONE definition in `publish.yml`, run by both events, with no step
  opting out by event. A PR build that packaged nothing would be worse than no PR build, because it
  reports green.

  *Publishes nothing*: the `publish` job is gated on the event itself, not merely its steps. No
  `pull_request` run, a fork's included, reaches `ovsx publish` or `vsce publish`, and
  `verify-openvsx` is skipped behind it.

  Three traps ride along:
  - Giving `build` an `if:` so it can run while both gate jobs are *skipped* removes the implicit
    `success()`. The condition must itself refuse a gate that **failed** or was **cancelled**, or a
    tag can publish a build that fails on Windows: what `needs: [test, test-full]` exists to prevent.
  - A skip carries down the whole `needs` chain, not one hop. `codium-smoke`, whose one need is a
    green `build`, was skipped behind those same gates on every PR until it got an `if:` reading
    `build`'s result. `publish` keeps its event gate although that rule skips it today, because the
    gate still holds if both gate jobs ever run on a PR.
  - Cancelling superseded runs must exempt tags: a publish cut mid-flight leaves the two marketplaces
    half-updated, so `cancel-in-progress` is true for `pull_request` only.
- **`universal-has-no-native`** — the universal VSIX carries the WASM tier and no native
  `@img/sharp-*`. The WASM half is the load-bearing one: it is that build's only Sharp tier, so losing
  it drops every host with no platform build straight to Jimp. That is seconds per image, for exactly
  the users who have nothing else. The native half is how that loss announces itself. A native
  package is there because the prune stopped running, or because an `npm` install ran *after* the
  hand-extract (see "The WASM tier ships from CI only"). Hence the install order every target now
  shares (installs first, prune, hand-extract last) and the artifact scan's exact-set check, which no
  leg is exempt from.
- **`one-native-tier-per-target`** — a platform VSIX carries exactly one native Sharp pair, its own.
  npm cannot be asked for that. `package-lock.json` records no `libc` for `@img/sharp-*`, so
  `--libc=musl` filters nothing on a lockfile-driven install, and any later `npm install` re-adds the
  *runner's* natives on top. The install step therefore prunes to the target's pair after its last
  install. The artifact scan's exact-set check proves the prune ran, on every leg, which two weaker
  checks do not. A violation is invisible until runtime on a user's machine: an Alpine host loading a
  glibc `.node` gets a loader error from a VSIX that installed cleanly, and every stray tier is ~17 MB
  of libvips nobody can use.
- **`vsix-modules-hand-assembled`** — the VSIX's `node_modules` is hand-assembled and only checkable
  in the artifact. Two lists build it: the `.vscodeignore` un-ignores and the wasm32 steps in
  `publish.yml`. Dropping from either passes every test and every local run while shipping users a
  silent Jimp fallback (or no Sharp at all). The CI VSIX scan covers *part* of the un-ignore list. It
  requires `@img/sharp-wasm32/lib/sharp-wasm32.node.wasm` and `@emnapi/runtime/` in the artifact, and
  nothing else ships them, so it transitively pins `!node_modules/@img/**` and
  `!node_modules/@emnapi/**`.

  It does **not** cover `!node_modules/sharp/**` or the transitive deps (`detect-libc`, `semver`):
  drop one of those and CI still passes green. Narrowing `!node_modules/@img/**` to just the wasm32
  subtree would also pass while killing the native tier.
