#!/usr/bin/env node
/**
 * Mutation check: a green test suite is not evidence — see docs/testing.md.
 *
 * For each fixed mutation, apply it to a source file, run the suite that should
 * catch it, and assert the suite now FAILS. A mutation that leaves the suite
 * green "survived" — a real coverage gap. The baseline (no mutation) must be
 * green first. Mutations are applied to a throwaway copy of the tree, never to
 * the working tree, so no exit path — SIGKILL included — can leave mutated
 * source behind; a checksum manifest verifies that at exit and names any file
 * that moved. A run narrowed by the MUTATION_CHECK_TEST seam is not this gate:
 * it is banner-marked as a subset and exits 2, never 0.
 * See docs/testing.md (the harness runs in a sandbox).
 */

import {
  copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

/**
 * Each mutation names the file it edits and the suite that must kill it. Every
 * suite imports the real source, so a mutation hits src/* — except the two rules at the end that
 * ARE test infrastructure (test/webview/standaloneArtifact.ts, test/webview/playwright.config.ts):
 * whether the webview layer serves a current, complete page, and how that layer sizes itself and
 * lays out its reports on a host CI never runs on. All suites live
 * under test/unit/ and are run through Vitest (the tuple-matching and pngText
 * mutations are killed there; the old in-test copies are gone).
 */
const mutations = [
  // ── Tuple matching: the Vitest suite imports the real fileService.ts ──
  {
    name: 'tuple: crop-deprioritization removed',
    file: 'src/fileService.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: 'const isBetter = (!isCrop && bestIsCrop) ||',
    replace: 'const isBetter = (false && bestIsCrop) ||',
    killedBy: 'crop-rule tests (non-crop ref must win over a closer-length crop ref)'
  },
  {
    name: 'tuple: length tie-break comparator inverted',
    file: 'src/fileService.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: '(isCrop === bestIsCrop && lenDiff < bestLenDiff) ||',
    replace: '(isCrop === bestIsCrop && lenDiff > bestLenDiff) ||',
    killedBy: 'length tie-break test (closer-length ref must win)'
  },
  {
    name: 'tuple: LCS tie-break disabled',
    file: 'src/fileService.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: '(isCrop === bestIsCrop && lenDiff === bestLenDiff && lcs > bestLcs);',
    replace: '(isCrop === bestIsCrop && lenDiff === bestLenDiff && false);',
    killedBy: 'LCS tie-break test (higher-LCS ref must win)'
  },
  {
    name: 'tuple: final name-sort removed (display order falls back to key order)',
    file: 'src/fileService.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: '  tuples.sort((a, b) => naturalSort(a.name, b.name));',
    replace: '  /* mutated: no final name sort */',
    killedBy: 'pipeline name-order test (parent row precedes its crop despite reversed key order)'
  },
  {
    name: 'tuple: row sort reversed',
    file: 'src/fileService.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: 'result.sort((a, b) => naturalSort(a.key, b.key));',
    replace: 'result.sort((a, b) => naturalSort(b.key, a.key));',
    killedBy: 'matcher key-order test (rows sorted by ref basename, asserted by index)'
  },

  // ── Symlinks: FileType is a bitmask (docs/tuple-matching.md: entry-type-is-a-bitmask) ──
  {
    name: 'symlink: classifyUris back to strict equality',
    file: 'src/fileService.ts',
    suite: 'test/unit/symlinkScan.test.ts',
    find: '    if (((types[i] ?? 0) & vscode.FileType.Directory) !== 0) {\n      directories.push(uri);\n    } else if (((types[i] ?? 0) & vscode.FileType.File) !== 0) {',
    replace: '    if (types[i] === vscode.FileType.Directory) {\n      directories.push(uri);\n    } else if (types[i] === vscode.FileType.File) {',
    killedBy: 'mode 2 / mode 3 symlink tests (a symlinked dir or file passed to scanForImages is classified)'
  },
  {
    name: 'symlink: scanDirectory subdir test back to strict equality',
    file: 'src/fileService.ts',
    suite: 'test/unit/symlinkScan.test.ts',
    find: '    if ((type & vscode.FileType.Directory) !== 0) {',
    replace: '    if (type === vscode.FileType.Directory) {',
    killedBy: 'mode 1 symlink test (a symlinked subdirectory of the root is a modality)'
  },
  {
    name: 'symlink: modality file listing back to strict equality',
    file: 'src/fileService.ts',
    suite: 'test/unit/symlinkScan.test.ts',
    find: '    if ((type & vscode.FileType.File) !== 0 && isImageFile(name)) {',
    replace: '    if (type === vscode.FileType.File && isImageFile(name)) {',
    killedBy: 'symlinked-image test (a linked image inside a modality dir yields a tuple)'
  },
  {
    name: 'symlink: broken link accepted (SymbolicLink bit treated as a file)',
    file: 'src/fileService.ts',
    suite: 'test/unit/symlinkScan.test.ts',
    find: '    if ((type & vscode.FileType.File) !== 0 && isImageFile(name)) {',
    replace: '    if ((type & (vscode.FileType.File | vscode.FileType.SymbolicLink)) !== 0 && isImageFile(name)) {',
    killedBy: 'broken-symlink test (a dangling link, type 64, must be skipped silently)'
  },
  {
    name: 'symlink: thumbnail cache-age sweep back to strict equality',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheExpiry.test.ts',
    find: '        if ((type & vscode.FileType.File) !== 0) {',
    replace: '        if (type === vscode.FileType.File) {',
    killedBy: 'symlinked-cache-entry test (an entry listing as 65 must still expire by age)'
  },

  // ── Scan IO: the directory listings overlap in input order (docs/tuple-matching.md: dir-listings-overlap) ──
  {
    name: 'scan: directory listings serialized again (one worker)',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '    Array.from({ length: Math.min(DIR_LISTING_CONCURRENCY, dirs.length) }, () => worker())',
    replace: '    Array.from({ length: 1 }, () => worker())',
    killedBy: 'concurrency test (11 dirs must be listed in one wave, not one after another)'
  },
  {
    name: 'scan: fan-out cap removed (unbounded listings)',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: 'Math.min(DIR_LISTING_CONCURRENCY, dirs.length)',
    replace: 'dirs.length',
    killedBy: 'cap test (a 40-directory session must not list all 40 at once)'
  },
  {
    name: 'scan: fan-out cap quietly halved (16 -> 11, the field case exactly)',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: 'const DIR_LISTING_CONCURRENCY = 16;',
    replace: 'const DIR_LISTING_CONCURRENCY = 11;',
    killedBy: 'cap test (40 dirs must list exactly 16 at a time, not merely at most 16)'
  },
  {
    name: 'scan: listings assembled in completion order, not input order',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '        listings[i] = { dir: dirs[i], images: await listImagesIn(dirs[i]) };',
    replace: '        const done = { dir: dirs[i], images: await listImagesIn(dirs[i]) }; listings[listings.reduce((n) => n + 1, 0)] = done;',
    killedBy: 'order test (slowest-first directories must still yield the caller\'s modality order)'
  },
  {
    name: 'scan: a listing failure skips the directory instead of rejecting',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '  if (failed?.failure) {\n    throw failed.failure.error;\n  }',
    replace: '  if (false) {\n    throw new Error("mutated");\n  }',
    killedBy: 'listing-failure test (an unreadable modality dir must still reject the scan)'
  },
  {
    name: 'scan: the rethrown failure is the last one, not the earliest in input order',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '  const failed = listings.find(listing => listing.failure);',
    replace: '  const failed = [...listings].reverse().find(listing => listing.failure);',
    killedBy: 'earliest-failure test (the slow first failure, not the fast later one, reaches the user)'
  },
  {
    name: 'scan: per-directory natural sort removed',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '  images.sort((a, b) => naturalSort(a.name, b.name));',
    replace: '  /* mutated: no per-directory sort */',
    killedBy: 'per-directory sort test (a tied tie-break must land on the naturally-first reference)'
  },
  {
    name: 'scan: an image-less directory becomes a modality',
    file: 'src/fileService.ts',
    suite: 'test/unit/parallelScan.test.ts',
    find: '    if (listing.images && listing.images.length > 0) {',
    replace: '    if (listing.images) {',
    killedBy: 'empty-directory test (a dir with no images is omitted from the modality list)'
  },

  // ── PPMX parser: the suite imports the real source ──
  {
    name: 'ppmx: size-based flags guard weakened (empty line accepted)',
    file: 'src/ppmxParser.ts',
    suite: 'test/unit/ppmxParser.test.ts',
    find: 'const looksLikeFlags = flags.length > 0 && /^[\\x20-\\x7e]+$/.test(flags);',
    replace: 'const looksLikeFlags = /^[\\x20-\\x7e]*$/.test(flags);',
    killedBy: 'Test 11 (a 0x0A first pixel must not be eaten as an empty flags line)'
  },
  {
    name: 'ppmx: header magic check removed',
    file: 'src/ppmxParser.ts',
    suite: 'test/unit/ppmxParser.test.ts',
    find: "if (header !== 'PPMX' && header !== 'P7') {",
    replace: 'if (false) {',
    killedBy: 'Test 8 (an unknown magic must be rejected)'
  },

  // ── PNG tEXt: the Vitest suite imports the real source ──
  {
    name: 'pngText: one CRC table entry corrupted',
    file: 'src/pngText.ts',
    suite: 'test/unit/pngTextChunk.test.ts',
    find: '  return table;\n})();',
    replace: '  table[42] ^= 1; return table;\n})();',
    killedBy: 'full-table CRC probe (touches all 256 entries)'
  },
  {
    name: 'pngText: off-by-one in the tEXt chunk length',
    file: 'src/pngText.ts',
    suite: 'test/unit/pngTextChunk.test.ts',
    find: 'chunk.writeUInt32BE(data.length, 0);',
    replace: 'chunk.writeUInt32BE(data.length + 1, 0);',
    killedBy: 'inject+read round-trip'
  },

  {
    name: 'modalityNames: fallback stops de-duplicating collided names',
    file: 'src/modalityNames.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: "  while (taken.has(`${name} (${n})`)) n++;",
    replace: "  while (false) n++;",
    killedBy: 'disambiguateDirectoryNames/uniquify tests (unique modality names)'
  },
  {
    name: 'modalityNames: uniquify stops registering the name it hands out',
    file: 'src/modalityNames.ts',
    suite: 'test/unit/tupleMatching.test.ts',
    find: "  taken.add(unique);",
    replace: "  /* mutated */",
    killedBy: 'disambiguateDirectoryNames/uniquify tests (unique modality names)'
  },
  {
    name: 'sessionFile: duplicate paths accepted',
    file: 'src/sessionFile.ts',
    suite: 'test/unit/sessionFile.test.ts',
    find: "  if (new Set(compared).size !== compared.length) {",
    replace: "  if (false) {",
    killedBy: 'Test 12 (duplicate paths rejected)'
  },

  // ── Work pool: the suite imports the real source ──
  {
    name: 'workPool: priority ordering broken (class scan reversed)',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'for (let p = Priority.VISIBLE; p < Priority.PREFETCH; p++) {',
    replace: 'for (let p = Priority.PREFETCH - 1; p >= Priority.VISIBLE; p--) {',
    killedBy: 'Test 2/5 (strict priority ordering)'
  },
  {
    name: 'workPool: EXPORT demoted below speculation',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: '  EXPORT = 2, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation',
    replace: '  EXPORT = 3, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation',
    killedBy: 'Full priority ladder test'
  },
  {
    name: 'workPool: concurrency cap ignored',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'if (this.active >= this.concurrency) return false;',
    replace: 'if (false) return false;',
    killedBy: 'Test 1 (concurrency is never exceeded)'
  },
  {
    name: 'workPool: speculative slot reservation removed',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'return spec < this.concurrency - 1;',
    replace: 'return true;',
    killedBy: 'Test 11 (speculation leaves one slot free)'
  },
  {
    name: 'workPool: foreground courtesy to queued background removed',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'return atOrAbove < this.concurrency - (this.anyQueuedBelow(p) ? 1 : 0);',
    replace: 'return atOrAbove < this.concurrency;',
    killedBy: 'Test 13 (freed slot goes to the queued sweep item)'
  },
  {
    name: 'workPool: speculative fair-share removed (class can hog every spec slot)',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'if (best === -1 || this.activeByPrio[q] < this.activeByPrio[best]) best = q;',
    replace: 'if (best === -1) best = q;',
    killedBy: 'Test 15 (freed spec slot goes to the waiting class)'
  },
  {
    name: 'workPool: libuv width cap dropped (width tracks the core count again)',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'const saturating = Math.max(1, Math.min(LIBUV_WIDTH, parallelism - 1));',
    replace: 'const saturating = Math.max(1, parallelism - 1);',
    killedBy: 'poolWidth clamp test (poolWidth(64) must be 6, not core-derived)'
  },
  {
    name: 'workPool: width floor removed (a 1-core count yields width 0)',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: 'const saturating = Math.max(1, Math.min(LIBUV_WIDTH, parallelism - 1));',
    replace: 'const saturating = Math.min(LIBUV_WIDTH, parallelism - 1);',
    killedBy: 'poolWidth clamp test (poolWidth(1) and poolWidth(0) must be 1)'
  },
  {
    name: 'workPool: parallelism source flipped back to the logical-core count',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: '  if (available !== undefined && available > 0) return available;',
    replace: '  if (logical !== undefined && logical > 0) return logical;',
    killedBy: 'usable-parallelism test (a 256-core/4-usable host must size from 4)'
  },
  {
    name: 'workPool: configured width override ignored',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: '  if (override !== undefined && override > 0) return Math.max(1, Math.floor(override));',
    replace: '  if (false) return Math.max(1, Math.floor(override ?? 1));',
    killedBy: 'override test (imageCompare.maxConcurrentReads=12 must win over the auto rule)'
  },

  // ── Watcher logic: the suite imports the real source ──
  {
    name: 'watcher: ambiguous-multi-delete guard flipped to guess',
    file: 'src/watcherLogic.ts',
    suite: 'test/unit/watcherLogic.test.ts',
    find: 'if (sameDir.length > 1) return -1;',
    replace: 'if (sameDir.length > 1) return sameDir[0].i;',
    killedBy: 'Test 2 (two same-dir deletes are ambiguous -> no match)'
  },
  {
    name: 'watcher: caller-ordered modality insertion comparator flipped',
    file: 'src/watcherLogic.ts',
    suite: 'test/unit/watcherLogic.test.ts',
    find: 'if (r === -1 || r > rank) return i;',
    replace: 'if (r === -1 || r < rank) return i;',
    killedBy: 'Test 12/13 (mode-2 re-add lands at the caller-ordered position)'
  },
  {
    name: 'thumbPack: uuid pairing check removed (torn pack/idx combo served)',
    file: 'src/thumbPack.ts',
    suite: 'test/unit/thumbPack.test.ts',
    find: 'if (pack.length < header.length || !pack.subarray(0, header.length).equals(header)) return null;',
    replace: 'if (pack.length < header.length) return null;',
    killedBy: 'Test 3 (uuid mismatch, same-size packs)'
  },
  {
    name: 'thumbPack: offset bounds check weakened',
    file: 'src/thumbPack.ts',
    suite: 'test/unit/thumbPack.test.ts',
    find: 'if (o < header.length || l < 0 || o + l > pack.length || out.has(e.k)) return null;',
    replace: 'if (l < 0 || out.has(e.k)) return null;',
    killedBy: 'Test 5/6 (overflowing and header-pointing entries rejected)'
  },
  {
    name: 'thumbPack: dispose() drops the pending snapshot again (the pre-fix bug)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbPackFlush.test.ts',
    find: '    void this.flush();',
    replace: '    if (this.packTimer) clearTimeout(this.packTimer);',
    killedBy: 'dispose() test (a close inside the 30s debounce must still publish the pack)'
  },
  {
    name: 'thumbPack: flush() no longer awaits the queued write (shutdown returns too early)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbPackFlush.test.ts',
    find: '    await this.queuePackSnapshot();',
    replace: '    void this.queuePackSnapshot();',
    killedBy: 'flush() test (files must be on disk when flush resolves)'
  },
  {
    name: 'thumbPack: snapshot entries read inside the write instead of at queue time',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbPackFlush.test.ts',
    find: '    this.packWrite = this.packWrite.then(() => this.writePackSnapshot(entries));',
    replace: '    this.packWrite = this.packWrite.then(() => this.writePackSnapshot([...this.memoryCache].map(([key, bytes]) => ({ key, bytes }))));',
    killedBy: 'clearMemoryCache race test (an empty pack must never overwrite a good one)'
  },
  {
    name: 'thumbCache: ctime dropped from the key (an mtime-preserving overwrite serves stale pixels)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheKeying.test.ts',
    find: '    hash.update(ctime.toString());',
    replace: '    /* mutated: ctime no longer part of the key */',
    killedBy: 'in-place overwrite test (same mtime, same size, different pixels)'
  },
  {
    name: "thumbCache: ctime taken from vscode's stat, which is birth time (the fix that fixes nothing)",
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheKeying.test.ts',
    find: "    if (uri.scheme === 'file') {\n      const s = await fs.promises.stat(uri.fsPath);",
    replace: "    if (false) {\n      const s = await fs.promises.stat(uri.fsPath);",
    killedBy: 'in-place overwrite test (birthtime does not move when a file is rewritten in place)'
  },
  {
    name: 'thumbCache: superseded entries no longer evicted (dead key per rewrite)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheKeying.test.ts',
    find: '      this.evictSuperseded(uri, cacheKey);',
    replace: '      /* mutated: superseded entries left to accumulate */',
    killedBy: 'eviction test (one per-entry file and one pack slot after a rewrite)'
  },
  {
    name: 'thumbCache: pack no longer stamped on use (an in-use pack expires at cacheMaxAgeDays)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheExpiry.test.ts',
    find: '          if (parsed) { this.packLoadedFromDisk = true; await this.touchPack(); }',
    replace: '          if (parsed) { this.packLoadedFromDisk = true; }',
    killedBy: 'in-use pack test (a backdated pack serving the session survives the sweep)'
  },
  {
    name: 'thumbCache: a pack deleted under a live session is never noticed (warm session republishes nothing)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheExpiry.test.ts',
    find: '    if (!this.packDirty && this.memoryCache.size > 0 && await this.packGone()) this.packDirty = true;',
    replace: '    /* mutated: a swept pack is never detected */',
    killedBy: 'republish test (the close must put back a pack deleted mid-session)'
  },
  {
    name: 'thumbCache: republish check keyed on nothing (a session that never loaded a pack still republishes)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbCacheExpiry.test.ts',
    find: '    if (!this.packLoadedFromDisk) return false;',
    replace: '    if (this.packLoadedFromDisk) return false;',
    killedBy: 'republish test (the vanish check must fire exactly for the session holding the pack)'
  },
  {
    name: 'modalityVisibility: insert anchor broken (new modality always lands first)',
    file: 'src/webview/modalityVisibility.ts',
    suite: 'test/unit/modalityVisibility.test.ts',
    find: 'const anchor = w > 0 ? shifted.indexOf(w - 1) + 1 : Math.max(0, shifted.indexOf(w + 1));',
    replace: 'const anchor = 0;',
    killedBy: 'rearrangement test (new column lands beside its original predecessor)'
  },
  {
    name: 'modalityVisibility: tiny-tile vote guard inverted (12px tiles vote again)',
    file: 'src/webview/modalityVisibility.ts',
    suite: 'test/unit/modalityVisibility.test.ts',
    find: 'return tileSize >= 3 * WINNER_CIRCLE_PX;',
    replace: 'return true;',
    killedBy: 'mouse-vote guard test (below 3x must not be votable)'
  },
  {
    name: 'modalityVisibility: hidden pills no longer skipped by cycling',
    file: 'src/webview/modalityVisibility.ts',
    suite: 'test/unit/modalityVisibility.test.ts',
    find: 'if (!hidden[i]) return i;',
    replace: 'return i;',
    killedBy: 'Test 2/3 (hidden neighbours are skipped)'
  },
  {
    name: 'watcher: sorted row insertion degraded to append',
    file: 'src/watcherLogic.ts',
    suite: 'test/unit/watcherLogic.test.ts',
    find: 'if (naturalCompare(name, existingNames[i]) < 0) return i;',
    replace: 'if (false) return i;',
    killedBy: 'Test 18/19 (crop row lands after its parent, natural-ordered)'
  },

  // ── Session files: the suite imports the real source ──
  {
    name: 'sessionFile: duplicate-label rejection removed',
    file: 'src/sessionFile.ts',
    suite: 'test/unit/sessionFile.test.ts',
    find: 'if (new Set(labels).size !== labels.length) {',
    replace: 'if (false) {',
    killedBy: 'Test 6 (duplicate labels must throw "unique" — a modality name is the downstream join key)'
  },
  {
    name: 'sessionFile: relative paths resolved against cwd instead of the session dir',
    file: 'src/sessionFile.ts',
    suite: 'test/unit/sessionFile.test.ts',
    find: 'const paths = rawPaths.map((p) => path.resolve(baseDir, p));',
    replace: 'const paths = rawPaths.map((p) => path.resolve(p));',
    killedBy: 'Test 2 (relative paths resolve against the session file dir, not cwd)'
  },
  {
    name: 'sessionFile: future-version gate removed (v2 file half-opened)',
    file: 'src/sessionFile.ts',
    suite: 'test/unit/sessionFile.test.ts',
    find: 'if ((version as number) > CURRENT_SESSION_VERSION) {',
    replace: 'if (false) {',
    killedBy: 'version-gate test (a future version must be rejected, not half-opened)'
  },
  {
    name: 'wireFormat: payload normalization removed (Buffer reaches the wire)',
    file: 'src/wireFormat.ts',
    suite: 'test/unit/wireFormat.test.ts',
    find: '  return new Uint8Array(bytes);',
    replace: '  return bytes;',
    killedBy: 'Tests 1-2 (Buffer converted; view copied tight)'
  },
  {
    name: 'sessionFile: save-as escape check removed (".." paths written)',
    file: 'src/sessionFile.ts',
    suite: 'test/unit/sessionFile.test.ts',
    find: "const escapes = rels.some((r) => r.startsWith('..') || path.isAbsolute(r));",
    replace: 'const escapes = false;',
    killedBy: 'serializeSessionFile test (an escaping path must force all-absolute)'
  },

  // ── Shared pure modules (extension + standalone): the suites import the real source ──
  {
    name: 'resultsFile: header line changed (on-disk results.txt format drift)',
    file: 'src/resultsFile.ts',
    suite: 'test/unit/resultsFile.test.ts',
    find: "'# ImageCompare Results',",
    replace: "'## ImageCompare Results',",
    killedBy: 'byte-pinned header test (the expected serialized bytes are committed literals)'
  },
  {
    name: 'cropPlan: max-across-modality-dirs numbering degraded to min',
    file: 'src/cropPlan.ts',
    suite: 'test/unit/cropPlan.test.ts',
    find: 'const cropNum = Math.max(...cropNums);',
    replace: 'const cropNum = Math.min(...cropNums);',
    killedBy: 'partial-crop test (a dir already at _crop03 must force _crop04 everywhere, or the lower number overwrites)'
  },
  {
    name: 'pptxDeck: voted crop no longer paired with its parent',
    file: 'src/pptxDeck.ts',
    suite: 'test/unit/pptxDeck.test.ts',
    find: 'const parentIdx = findParentTuple(tuple.name);',
    replace: 'const parentIdx = -1;',
    killedBy: 'pairing test (a voted crop slide must carry the parent callout image)'
  },
  {
    name: 'initPayload: missing-slot placeholder corrupted (dense tuples must use empty name)',
    file: 'src/initPayload.ts',
    suite: 'test/unit/initPayload.test.ts',
    find: "name: img?.name || '',",
    replace: "name: img?.name || 'placeholder',",
    killedBy: 'dense-tuple placeholder test (a missing slot is an empty name, which the webview renders as absent)'
  },
  {
    name: 'initPayload: version dropped from the init message',
    file: 'src/initPayload.ts',
    suite: 'test/unit/initPayload.test.ts',
    find: 'version: args.version,',
    replace: "version: '',",
    killedBy: 'version pass-through test (the help modal footer shows exactly what the product supplied)'
  },
  {
    name: 'thumbnailPlan: scanline order reversed (items prepended instead of appended)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/thumbnailPlan.test.ts',
    find: 'if (image) items.push({ tupleIndex, modalityIndex, image });',
    replace: 'if (image) items.unshift({ tupleIndex, modalityIndex, image });',
    killedBy: 'scanline-order test (items must run tuple-major, modality-minor, top-to-bottom)'
  },

  // ── Thumbnail sweep: centre-out dispatch, coverage under re-centring, the chunk bound ──
  {
    name: 'sweep: a moved centre never re-aims the cursor (the sweep finishes the old order first)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    if (aim !== this.centre) {',
    replace: '    if (this.centre < 0) {',
    killedBy: 're-aim tests (a jump mid-walk must serve the new row next, not the old walk\'s next step)'
  },
  {
    name: 'sweep: the centre is used unnormalized (a NaN or fractional centre aims at no row at all)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    const wanted = Number.isFinite(centre) ? Math.trunc(centre) : 0;',
    replace: '    const wanted = centre;',
    killedBy: 'seeded fuzz (NaN, +-Infinity and fractional centres must still hand out every slot)'
  },
  {
    name: 'sweep: nearest-walk pick always forward (rows above the centre are swept last, not by distance)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    if (hasUp && hasDown) row = this.up - this.centre <= this.centre - this.down ? this.up : this.down;',
    replace: '    if (hasUp && hasDown) row = this.up;',
    killedBy: 'centre-out order test (the distance-1 row below the centre precedes the distance-2 row above it)'
  },
  {
    name: 'sweep: slot peeked instead of consumed (a slot can be dispatched twice, and the tail never)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    return this.rows[row].shift();',
    replace: '    return this.rows[row][0];',
    killedBy: 'exactly-once tests (every planned slot handed out and delivered exactly one time)'
  },
  {
    name: 'sweep: backward walk disabled (rows below the first centre are never swept)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '      this.down = aim - 1;',
    replace: '      this.down = -1;',
    killedBy: 'coverage tests (the tail must still be swept once the user stops navigating)'
  },
  {
    name: 'sweep: dispatch bound removed (the whole grid is handed to the pool again)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    while (outstanding < chunk) {',
    replace: '    while (cursor.remaining > 0) {',
    killedBy: 'bounded-dispatch tests (at most `chunk` slots outstanding, refilled per settle)'
  },
  {
    name: 'sweep: a re-aim leaves the queued dispatches alone (the 28-deep old-centre lag is back)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '      if (outstanding > 0) io.dropQueued?.();',
    replace: '        /* mutated: the queue is never dropped on re-aim */',
    killedBy: 'cancel-on-re-aim test (the new centre must be served after one running batch, not 28 tiles later)'
  },
  {
    name: 'sweep: the early stop removed (a closed panel is swept to completion again)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepAbandon.test.ts',
    find: '    if (abandoned()) return;',
    replace: '    /* mutated: a dead host keeps being read for */',
    killedBy: 'abandon tests (no thumbnail read may START after the host is gone)'
  },
  {
    name: 'sweep: an abandoned sweep has no exit (the promise hangs and the wire claim with it)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepAbandon.test.ts',
    find: '    if (outstanding === 0 && (cursor.remaining === 0 || abandoned())) resolveSweep();',
    replace: '    if (outstanding === 0 && cursor.remaining === 0) resolveSweep();',
    killedBy: 'abandon tests (the sweep promise must resolve with slots still in the cursor)'
  },
  {
    name: 'sweep: the centre re-read per dispatch (one pass no longer aims at one centre)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepAim.test.ts',
    find: '      const item = cursor.next(aim);',
    replace: '      aim = centre();\n      if (aim !== aimed) { aimed = aim; if (outstanding > 0) io.dropQueued?.(); }\n      const item = cursor.next(aim);',
    killedBy: 'first-chunk band test (a chunk dispatched as one centre-out band, on one centre read)'
  },
  {
    name: 'sweep: a requeue takes a fresh centre reading (the drop\'s own fallout re-triggers the drop)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepAim.test.ts',
    find: '      pump(requeued ? aimed : centre());',
    replace: '      pump(centre());',
    killedBy: 'livelock test (a centre that moves on every read must not stall the pump in a microtask cascade)'
  },
  {
    name: 'workPool: the group rotation removed (the first tab drains its chunk before the second reads)',
    file: 'src/workPool.ts',
    suite: 'test/unit/poolFairness.test.ts',
    find: '    const group = groups[(at + 1) % groups.length];',
    replace: '    const group = groups[0];',
    killedBy: 'two-tab tests (the second sweep must get a bulk slot in the first batch, not after 28 reads)'
  },
  {
    name: 'workPool: LIFO inside a group (the sweep\'s centre-out submit order is undone)',
    file: 'src/workPool.ts',
    suite: 'test/unit/poolFairness.test.ts',
    find: '    const item = fifo.shift()!;',
    replace: '    const item = fifo.pop()!;',
    killedBy: 'FIFO-within-a-group test (submit order is untouched inside a bucket, grouped or not)'
  },
  {
    name: 'sweep: the hidden-panel pause removed (a tab nobody is watching keeps half of every batch)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '    if (paused()) {',
    replace: '    if (false) {',
    killedBy: 'pause tests (a hidden panel dispatches nothing and the tab in focus gets every bulk slot)'
  },
  {
    name: 'sweep: a pause keeps its queued dispatches (the hidden tab drains its whole chunk first)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '      if (outstanding > 0 && !pauseDropped) {',
    replace: '      if (false) {',
    killedBy: 'pause tests (the queued dispatches go back to the cursor within one running batch)'
  },
  {
    name: 'sweep: the start exit fires for a paused host (a panel opened hidden ends with a blank grid)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '  if (outstanding === 0 && (abandoned() || !paused())) resolveSweep();',
    replace: '  if (outstanding === 0) resolveSweep();',
    killedBy: 'paused-at-start test (the sweep waits for the repump instead of resolving the grid away)'
  },
  {
    name: 'sweep: the host\'s repump does nothing (a paused sweep never ends, claim and plan with it)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '  options.onRepump?.(() => {\n    pump(centre());\n    if (outstanding === 0 && (abandoned() || cursor.remaining === 0)) resolveSweep();\n  });',
    replace: '  options.onRepump?.(() => { /* mutated: the host cannot re-enter the pump */ });',
    killedBy: 'resume tests (a paused sweep resumes on re-show and ends on dispose, both inside the deadline)'
  },
  {
    name: 'sweep: the repump\'s abandoned exit dropped (disposing a hidden panel hangs its sweep)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '    if (outstanding === 0 && (abandoned() || cursor.remaining === 0)) resolveSweep();',
    replace: '    if (outstanding === 0 && cursor.remaining === 0) resolveSweep();',
    killedBy: 'dispose-while-paused test (the wire claim is given back, so the sweep resolved)'
  },
  {
    name: 'provider: the sweep is never told its panel is hidden (switching away changes nothing)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '          paused: () => !state.visible,',
    replace: '          paused: () => false,',
    killedBy: 'provider pause test (a hidden panel reads no further thumbnails)'
  },
  {
    name: 'provider: hiding never reaches the pump (the pause waits for a settle that may never come)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '    state.sweepRepump?.();\n  }',
    replace: '    if (visible) state.sweepRepump?.();\n  }',
    killedBy: 'hide test (the queued chunk leaves the pool when the panel is hidden, not one batch later)'
  },
  {
    name: 'provider: showing a panel never resumes its sweep (the grid stays half-filled)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '    state.sweepRepump?.();\n  }',
    replace: '    if (!visible) state.sweepRepump?.();\n  }',
    killedBy: 'resume test (every slot is delivered exactly once after the panel comes back)'
  },
  {
    name: 'provider: dispose leaves a paused sweep hanging (the wire claim outlives the panel)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '    state.sweepRepump?.(); // a sweep paused with nothing outstanding has no settle left to end it',
    replace: '    /* mutated: a paused sweep is never told its panel is gone */',
    killedBy: 'dispose-while-hidden test (the sweep resolves and endSweep gives the wire back)'
  },
  {
    name: 'provider: the sweep drops its fair-share group (two tabs share one FIFO again)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepHiddenPanel.test.ts',
    find: '                group: state.poolKey',
    replace: '                group: undefined',
    killedBy: 'two-panel test (the second comparison gets a bulk slot in the first batch)'
  },
  {
    name: 'provider: the sweep is never told its panel is gone (the dead-panel read storm is back)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepReaimCancel.test.ts',
    find: '          abandoned: () => state.disposed,',
    replace: '          abandoned: () => false,',
    killedBy: 'dispose test (a disposed panel reads not one more thumbnail)'
  },
  {
    name: 'sweep: a dropped slot is never returned to the cursor (permanently blank tiles)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '            cursor.putBack(item);',
    replace: '            /* mutated: the dropped slot is lost */',
    killedBy: 'exactly-once tests (every planned slot is still delivered after repeated re-aims)'
  },
  {
    name: 'sweep: a requeued slot counted as delivered (the bar overruns and the tail hangs)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '    if (!requeued) {',
    replace: '    if (true) {',
    killedBy: 'progress test (exactly one tick per planned item, ending at total)'
  },
  {
    name: 'sweep: putBack leaves the walks where they were (a returned row is never revisited)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/sweepCentre.test.ts',
    find: '      if (item.tupleIndex < this.up) this.up = item.tupleIndex;\n    } else if (item.tupleIndex > this.down) this.down = item.tupleIndex;',
    replace: '      /* mutated: no rewind */\n    }',
    killedBy: 'cursor return test (a slot returned to a row both walks have passed must still be handed out)'
  },
  {
    name: 'provider: the re-aim drop takes the whole panel key (export and poll work cancelled with it)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepReaimCancel.test.ts',
    find: '          dropQueued: () => this.pool.cancel(sweepPoolKey(state))',
    replace: '          dropQueued: () => this.pool.cancel(state.poolKey)',
    killedBy: 'key-scope test (a queued poll task on poolKey survives a re-aim)'
  },
  {
    name: 'provider: the disposed/live cancellation discriminator inverted (a live panel loses every dropped slot)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepReaimCancel.test.ts',
    find: '                if (error instanceof TaskCancelled) return state.disposed ? null : SWEEP_REQUEUE;',
    replace: '                if (error instanceof TaskCancelled) return state.disposed ? SWEEP_REQUEUE : null;',
    killedBy: 're-aim test (every one of the 60 slots is still delivered after the jump dropped 28)'
  },
  {
    name: 'provider: sweep given no centre (thumbnails fill top-to-bottom wherever the user is)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepProviderCentre.test.ts',
    find: '          centre: () => state.currentTupleIndex,',
    replace: '          centre: () => 0,',
    killedBy: 'provider order test (the sweep starts at the row the panel opened on)'
  },
  {
    name: 'provider: centre snapshotted at sweep start (a mid-sweep navigation never re-aims)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/sweepProviderCentre.test.ts',
    find: '          centre: () => state.currentTupleIndex,',
    replace: '          centre: ((pinned: number) => () => pinned)(state.currentTupleIndex),',
    killedBy: 'provider re-aim test (setCurrentTuple mid-sweep must move the remaining dispatches)'
  },
  {
    name: 'pptxDeck: nextPptxName increment dropped (suggests the max, not max+1)',
    file: 'src/pptxDeck.ts',
    suite: 'test/unit/pptxName.test.ts',
    find: 'if (match) pptxNum = Math.max(pptxNum, parseInt(match[1], 10) + 1);',
    replace: 'if (match) pptxNum = Math.max(pptxNum, parseInt(match[1], 10));',
    killedBy: 'max-existing test (comparison_05 present must suggest comparison_06, never 05 again)'
  },

  // ── Arrival planner (extension watcher arrivals + standalone crop writes) ──
  {
    name: 'arrival: taken-slot fallback removed (a looser match reuses the slot)',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '  if (!bestSlotFree) {',
    replace: '  if (false) {',
    killedBy: 'Test 4 (a taken slot must produce a new tuple, never a looser match)'
  },
  {
    name: 'arrival: exact-basename boost removed (de-duplicated tuples stop re-grouping)',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '        matchLen = baseFilename.length;',
    replace: '        matchLen = matchLen;',
    killedBy: 'Test 2 (an exact basename must reach the "name (2)" tuple whose name is no substring)'
  },
  {
    name: 'arrival: free-slot tie-break removed',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '    } else if (matchLen === bestMatchLen && slotFree && !bestSlotFree) {',
    replace: '    } else if (false) {',
    killedBy: 'Test 3 (equal scores must prefer the tuple with the free slot)'
  },
  {
    name: 'arrival: name uniquification removed (two rows share a results key)',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '  for (let n = 2; existingNames.has(uniqueName); n++) {',
    replace: '  for (let n = 2; false; n++) {',
    killedBy: 'Test 5 (a colliding name must become "name (2)")'
  },
  {
    name: 'arrival: winner keys not shifted by the insertion',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '    winners.set(t >= plan.insertIndex ? t + 1 : t, m);',
    replace: '    winners.set(t, m);',
    killedBy: 'Test 9 (the winner on the row after the insert must move up)'
  },
  {
    name: 'arrival: current-tuple shift dropped (view strands on the wrong row)',
    file: 'src/arrivalPlan.ts',
    suite: 'test/unit/arrivalPlan.test.ts',
    find: '  const shiftedCurrent = currentTupleIndex >= plan.insertIndex ? currentTupleIndex + 1 : currentTupleIndex;',
    replace: '  const shiftedCurrent = currentTupleIndex;',
    killedBy: 'Test 9 (the current index at/after the insert must shift with the splice)'
  },

  // ── Removal planner (the delete-message-order canon) ──
  {
    name: 'removal: emptied-modality indices not pre-shifted for earlier splices',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '    working.splice(idx, 1);',
    replace: '    /* mutated: no working splice */',
    killedBy: 'Test 2 (after "a" is spliced, "c" must be reported at index 1, not 2)'
  },
  {
    name: 'removal: emptiness check inverted (a surviving modality gets removed)',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '    if (modalityHasFiles(remaining, modality)) continue;',
    replace: '    if (!modalityHasFiles(remaining, modality)) continue;',
    killedBy: 'Test 2 ("b" survives in t1 and must not appear among the steps)'
  },
  {
    name: 'removal: tupleDeleted posted after the refresh (canon order flipped)',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  io.post({ type: \'tupleDeleted\', tupleIndex: asTuple(tupleIndex) });\n  io.refreshCurrentTuple(current);',
    replace: '  io.refreshCurrentTuple(current);\n  io.post({ type: \'tupleDeleted\', tupleIndex: asTuple(tupleIndex) });',
    killedBy: 'Test 4/8 (transcript must read tupleDeleted, then refresh)'
  },
  {
    name: 'removal: re-save after the tuple step dropped',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  io.refreshCurrentTuple(current);\n  io.saveResults();',
    replace: '  io.refreshCurrentTuple(current);',
    killedBy: 'Test 4/8 (a save must follow the tuple step, not only the end of the plan)'
  },
  {
    name: 'removal: re-save after a modality step dropped',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  io.post({ type: \'modalityRemoved\', modalityIndex: asOriginal(modalityIndex) });\n  io.saveResults();',
    replace: '  io.post({ type: \'modalityRemoved\', modalityIndex: asOriginal(modalityIndex) });',
    killedBy: 'Test 6/8 (each modality removal must be followed by its own save)'
  },
  {
    name: 'removal: current-index clamp dropped when the last row goes',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  if (current >= scan.tuples.length) {\n    current = Math.max(0, scan.tuples.length - 1);\n  } else if (current > tupleIndex) {\n    current--;\n  }',
    replace: '  /* mutated: no clamp */',
    killedBy: 'Test 5 (removing the last, current row must clamp the refresh to the new last row)'
  },
  {
    name: 'removal: winner values not shifted past the removed modality',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '    if (shifted !== null) winners.set(t, shifted);',
    replace: '    if (shifted !== null) winners.set(t, m);',
    killedBy: 'Test 6 (the winner at column 2 must shift to 1 when column 1 goes)'
  },
  {
    name: 'cropPlan: relative rect divides y by the width (axes swapped)',
    file: 'src/cropPlan.ts',
    suite: 'test/unit/cropRelRect.test.ts',
    find: '    y: rect.y / srcHeight,',
    replace: '    y: rect.y / srcWidth,',
    killedBy: 'Test 1 (non-square source pins each axis to its own denominator)'
  },
  {
    name: 'resultsFile: unresolvable winner no longer dropped before writing',
    file: 'src/resultsFile.ts',
    suite: 'test/unit/winnersToNames.test.ts',
    find: '    if (modality) named.set(tupleIndex, modality);',
    replace: '    named.set(tupleIndex, modality);',
    killedBy: 'Test 2 (an out-of-range winner index must be dropped, not written as undefined)'
  },

  // ── Shared session-host orchestrators (extension + standalone glue flows) ──
  {
    name: 'thumbnailSweep: progress tick stops counting the missing slots',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/thumbnailSweep.test.ts',
    find: "    post({ type: 'thumbnailProgress', current: done + plan.missing.length, total: plan.total });",
    replace: "    post({ type: 'thumbnailProgress', current: done, total: plan.total });",
    killedBy: 'fan-out transcript test (first settle with one missing slot must tick progress:2/4, not 1/4)'
  },
  {
    name: 'thumbnailSweep: zero-item terminal tick dropped (bar hangs forever)',
    file: 'src/thumbnailPlan.ts',
    suite: 'test/unit/thumbnailSweep.test.ts',
    find: "  if (plan.items.length === 0) {\n    post({ type: 'thumbnailProgress', current: plan.total, total: plan.total });\n    return Promise.resolve();\n  }",
    replace: '  if (plan.items.length === 0) {\n    return Promise.resolve();\n  }',
    killedBy: 'zero-items test (all-missing plan must still end with the terminal progress tick)'
  },
  {
    name: 'resultsFile: empty-winner delete branch removed (empty stub written instead)',
    file: 'src/resultsFile.ts',
    suite: 'test/unit/persistResults.test.ts',
    find: '  if (winners.size === 0) {\n    try {\n      await io.deleteFile();',
    replace: '  if (false) {\n    try {\n      await io.deleteFile();',
    killedBy: 'empty-winners test (no votes must delete the file, never write a stub)'
  },
  {
    name: 'removalPlan: per-file deletion loop dropped from the delete flow',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/deleteFlow.test.ts',
    find: '  for (const img of tuple.images) {\n    try {\n      await io.deleteFile(img);',
    replace: '  for (const img of []) {\n    try {\n      await io.deleteFile(img);',
    killedBy: 'flow transcript test (every rm:<file> entry must precede the removal steps)'
  },
  {
    name: 'removalPlan: delete flow plans from the stale caller index, not the live one',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/deleteFlow.test.ts',
    find: '  const liveIndex = scan.tuples.indexOf(tuple);',
    replace: '  const liveIndex = tupleIndex;',
    killedBy: 'live-index test (a row removed during the deletion awaits must shift the planned index)'
  },
  {
    name: 'cropFlow: per-file arrivals dropped before cropComplete',
    file: 'src/cropFlow.ts',
    suite: 'test/unit/cropFlow.test.ts',
    find: '  for (const s of saved) await io.arriveFile(s);',
    replace: '  /* mutated: no arrivals */',
    killedBy: 'canon transcript test (every arrive:<path> must precede the cropComplete post)'
  },
  {
    name: 'cropFlow: cancelled batch still answers (silence gate weakened)',
    file: 'src/cropFlow.ts',
    suite: 'test/unit/cropFlow.test.ts',
    find: '  if (io.isAborted?.() || cancelled > 0) return;',
    replace: '  if (io.isAborted?.()) return;',
    killedBy: 'cancellation test (a cancelled work unit must silence arrivals and both terminal posts)'
  },
  {
    name: 'cropFlow: shared tEXt injection dropped (crop ships without its metadata)',
    file: 'src/cropFlow.ts',
    suite: 'test/unit/cropFlow.test.ts',
    find: '          const withMeta = pngInjectText(Buffer.isBuffer(png) ? png : Buffer.from(png), CROP_RECT_KEYWORD, cropMeta);',
    replace: '          const withMeta = Buffer.isBuffer(png) ? png : Buffer.from(png);',
    killedBy: 'tEXt round-trip test (written bytes must read back the six-integer crop meta)'
  },
  {
    name: 'exportDeck: comparison_NN numbering stage bypassed (fixed name saved)',
    file: 'src/pptxDeck.ts',
    suite: 'test/unit/exportDeck.test.ts',
    find: '    const name = nextPptxName(await io.listExistingNames());',
    replace: "    const name = (await io.listExistingNames(), 'comparison_01.pptx');",
    killedBy: 'canon sequence test (comparison_05 present must save comparison_06)'
  },
  {
    name: 'exportDeck: error answer dropped (a throw bricks the busy button)',
    file: 'src/pptxDeck.ts',
    suite: 'test/unit/exportDeck.test.ts',
    find: "    io.post({ type: 'pptxError', error: errorMsg });",
    replace: '    /* mutated: no error answer */',
    killedBy: 'throw-at-each-stage test (exactly one pptxError per failing request)'
  },
  {
    name: 'exportDeck: cancellation gate removed (a gone panel still answers)',
    file: 'src/pptxDeck.ts',
    suite: 'test/unit/exportDeck.test.ts',
    find: '    if (io.isCancelled?.(err)) return;',
    replace: '    if (false) return;',
    killedBy: 'cancellation test (a cancelled save must post neither answer)'
  },
  {
    name: 'imageServe: passthrough branch removed (original bytes never served)',
    file: 'src/imageServe.ts',
    suite: 'test/unit/imageServe.test.ts',
    find: '      if (mime) {\n        const dims = await io.probePassthrough(raw.bytes, raw.ext);',
    replace: '      if (false) {\n        const dims = await io.probePassthrough(raw.bytes, raw.ext);',
    killedBy: 'passthrough test (.png must probe dims and never call convert)'
  },
  {
    name: 'imageServe: payload normalization dropped (Buffer reaches the reply)',
    file: 'src/imageServe.ts',
    suite: 'test/unit/imageServe.test.ts',
    find: "        reply = { kind: 'image', bytes: normalizeImageBytes(raw.bytes), mime, width: dims.width, height: dims.height };",
    replace: "        reply = { kind: 'image', bytes: raw.bytes, mime, width: dims.width, height: dims.height };",
    killedBy: 'passthrough test (a Buffer input must come back as a plain tight Uint8Array)'
  },

  // ── Poll planning: the suite imports the real pollPlan.ts ──
  {
    name: 'pollPlan: barren sweep budget dropped (a pinned mtime skips forever)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '    if (memo && memo.mtime === mtime && memo.sweeps < recheckSweeps) {',
    replace: '    if (memo && memo.mtime === mtime) {',
    killedBy: 'never-advancing-mtime test (after the budget is spent the dir must be re-listed)'
  },
  {
    name: 'pollPlan: barren-memo mtime comparison dropped (an advanced mtime no longer re-lists)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '    if (memo && memo.mtime === mtime && memo.sweeps < recheckSweeps) {',
    replace: '    if (memo && memo.sweeps < recheckSweeps) {',
    killedBy: 'advanced-mtime test (a changed directory mtime must force a re-listing)'
  },
  {
    name: 'pollPlan: missing fingerprint misread as a change',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '    const mtimeChanged = before.mtime !== undefined && entry.mtime !== undefined && before.mtime !== entry.mtime;',
    replace: '    const mtimeChanged = before.mtime !== entry.mtime;',
    killedBy: 'lazy-fingerprint test (a side missing its fingerprint must never report changed)'
  },
  {
    name: 'pollPlan: name-set removal diff dropped (deletions vanish from the poll)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '  const removed = prev.filter(e => !nextNames.has(e.name)).map(e => e.name);',
    replace: '  const removed = [];',
    killedBy: 'name-set diff test (a name in prev but not next must be reported removed)'
  },
  {
    name: 'pollPlan: an unlistable dir yields no candidates (a vanished column stops being noticed)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '  if (!listed) return { added: [], candidates: [...known] };',
    replace: '  if (!listed) return { added: [], candidates: [] };',
    killedBy: 'unlistable-dir test (every tracked name must fall back to its own check)'
  },
  {
    name: 'pollPlan: an unlistable dir yields no candidates — through the real sweep',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollCost.test.ts',
    find: '  if (!listed) return { added: [], candidates: [...known] };',
    replace: '  if (!listed) return { added: [], candidates: [] };',
    killedBy: 'deleted-modality-dir test (a directory that cannot be listed must still report its files gone)'
  },
  {
    name: 'pollPlan: not-a-file listing entries treated as present (a dangling symlink stops being a deletion)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '  const files = listed.filter(e => e.isFile).map(e => ({ name: e.name }));',
    replace: '  const files = listed.map(e => ({ name: e.name }));',
    killedBy: 'not-a-file test (a listed non-file name must stay a deletion candidate)'
  },
  {
    name: 'pollPlan: not-a-file listing entries treated as present — through the real sweep',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollCost.test.ts',
    find: '  const files = listed.filter(e => e.isFile).map(e => ({ name: e.name }));',
    replace: '  const files = listed.map(e => ({ name: e.name }));',
    killedBy: 'dangling-symlink test (a link whose target went must still be reported gone)'
  },
  {
    name: 'provider: sweep checks every tracked file again (the 7407-task-per-cycle flood)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/pollCost.test.ts',
    find: '      const checks = [...candidates, ...strays].map(uri =>',
    replace: '      const checks = [...[...knownByDir.values()].flatMap(k => [...k.values()]), ...strays].map(uri =>',
    killedBy: 'cycle-cost test (a quiet cycle must submit one pooled task per directory, not per file)'
  },
  {
    name: 'provider: listing-derived candidates dropped (deletions never reach the re-verify)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/pollCost.test.ts',
    find: '      const candidates = (await Promise.all(dirChecks)).flat();',
    replace: '      const candidates: vscode.Uri[] = (await Promise.all(dirChecks)) && [];',
    killedBy: 'real-deletion test (a file that went must still be reported by the sweep)'
  },
  {
    name: 'provider: files under no listed dir lose their own check',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/pollCost.test.ts',
    find: '      const checks = [...candidates, ...strays].map(uri =>',
    replace: '      const checks = [...candidates].map(uri =>',
    killedBy: 'unwatched-dir test (a tracked file no listing covers must keep its per-file check)'
  },
  {
    name: 'pollPlan: rename pairing guesses instead of using matchDeletedFile',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollPlan.test.ts',
    find: '    const idx = matchDeletedFile(entries, add.dir, add.name, isMultiTuple);',
    replace: '    const idx = entries.length > 0 ? 0 : -1;',
    killedBy: 'ambiguity test (two same-dir removals must never pair with an add)'
  },
  {
    name: 'pollPlan: idle pool snapshot logged unconditionally (an idle window logs forever)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollNoise.test.ts',
    find: '  return busy || snapshot !== lastLogged;',
    replace: '  return true;',
    killedBy: 'idle-cycles test (three quiet cycles must leave exactly one pool line)'
  },
  {
    name: 'pollPlan: busy pool silenced when its snapshot repeats (real load stops being visible)',
    file: 'src/pollPlan.ts',
    suite: 'test/unit/pollNoise.test.ts',
    find: '  return busy || snapshot !== lastLogged;',
    replace: '  return snapshot !== lastLogged;',
    killedBy: 'busy-pool test (an occupied pool must print every cycle even unchanged)'
  },
  {
    name: 'provider: poll never records what it logged (the idle gate can never latch)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/pollNoise.test.ts',
    find: '        state.lastPoolSnapshot = snapshot;',
    replace: '        /* mutated: last snapshot not recorded */',
    killedBy: 'idle-cycles test (an unchanged idle snapshot must not be printed twice)'
  },

  // ── Slot-removal commit: the suite imports the real removalPlan.ts ──
  {
    name: 'commitSlotRemoval: empty-tuple branch inverted (an emptied tuple lingers as fileDeleted)',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  if (tuple.images.length === 0) {\n    io.removeTuple(asTuple(tupleIndex));\n  } else {',
    replace: '  if (false) {\n    io.removeTuple(asTuple(tupleIndex));\n  } else {',
    killedBy: 'commit transcript test (a tuple losing its last image must removeTuple, never fileDeleted)'
  },
  {
    name: 'commitSlotRemoval: column-empty follow-up dropped (a dead column survives)',
    file: 'src/removalPlan.ts',
    suite: 'test/unit/removalPlan.test.ts',
    find: '  if (stillIndex >= 0 && !modalityHasFiles(scan.tuples, modality)) {\n    io.removeModality(asOriginal(stillIndex));\n  }',
    replace: '  /* mutated: no column-empty follow-up */',
    killedBy: 'commit transcript test (the last file of a modality leaving must drop the column)'
  },

  // ── Modality adoption: the suite imports the real adoptionPlan.ts ──
  {
    name: 'adoptionPlan: dot-dir guard dropped (.git becomes an adoptable column)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: ".filter(e => e.isDirectory && !e.name.startsWith('.') && !modalities.includes(e.name))",
    replace: '.filter(e => e.isDirectory && !modalities.includes(e.name))',
    killedBy: 'candidate test (a dot dir must never qualify for adoption)'
  },
  {
    name: 'adoptionPlan: already-a-column guard dropped (every cycle re-adopts every column)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: ".filter(e => e.isDirectory && !e.name.startsWith('.') && !modalities.includes(e.name))",
    replace: ".filter(e => e.isDirectory && !e.name.startsWith('.'))",
    killedBy: 'candidate tests (an existing modality dir must never re-qualify)'
  },
  {
    name: 'adoptionPlan: imageful gate dropped (a text file makes a dir adoptable)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: '  return entries.filter(e => e.isFile && isImageFile(e.name)).map(e => e.name);',
    replace: '  return entries.filter(e => e.isFile).map(e => e.name);',
    killedBy: 'adoptableImages test (only image files count toward adoption)'
  },
  {
    name: 'adoptionPlan: winner column shift dropped (votes silently move to the wrong column)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: '    winners.set(t, m >= insertIndex ? m + 1 : m);',
    replace: '    winners.set(t, m);',
    killedBy: 'winner-shift test (a winner at/after the insertion point must shift up)'
  },
  {
    name: 'adoptionPlan: post-insert tuple re-sort dropped (sparse images stay in stale order)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: '    tuple.images.sort((a, b) => scan.modalities.indexOf(a.modality) - scan.modalities.indexOf(b.modality));',
    replace: '    /* mutated: no post-insert re-sort */',
    killedBy: 're-sort test (each tuple\'s images must follow the post-insert modality order)'
  },
  {
    name: 'adoptionPlan: wire index pinned to 0 (the webview splices the column at the wrong slot)',
    file: 'src/adoptionPlan.ts',
    suite: 'test/unit/adoptionPlan.test.ts',
    find: '      modalityIndex: asOriginal(insertIndex),',
    replace: '      modalityIndex: asOriginal(0),',
    killedBy: 'alphabetical-insert test (the message must carry the real global insert index)'
  },

  // ── Panel dispose: the OS handles an open created die with the panel (docs/file-watching.md: watched-dirs-have-watchers) ──
  {
    name: 'provider: the fs.watch handles are left open when the panel closes',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '    state.nodeWatchers.forEach(w => w.close());',
    replace: '    /* mutated: node watchers outlive the panel */',
    killedBy: 'handle census (node reports no watcher handle left after the close)'
  },
  {
    name: 'provider: the delete-poll interval keeps running after the panel closes',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '    if (state.deleteCheckTimer) clearInterval(state.deleteCheckTimer);',
    replace: '    /* mutated: the existence poll outlives the panel */',
    killedBy: 'timer census (every 10s interval the open started is cleared by the close)'
  },

  // ── Debug sink: diagnostics that must stay free when off (docs/loading-architecture.md: debug-off-costs-nothing) ──
  {
    name: 'debugLog: disabled short-circuit removed (the off path starts building messages)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '  if (!enabled) return;\n  write(tag, build());',
    replace: '  write(tag, build());',
    killedBy: 'debug-off test (the message thunk must never be invoked while debug is off)'
  },
  {
    name: 'debugLog: verbose gate removed (per-item firehose logs at plain debug level)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '  if (!verbose) return;',
    replace: '  if (false) return;',
    killedBy: 'verbose-off test (a per-item thunk must not run without imageCompare.debugVerbose)'
  },
  {
    name: 'debugLog: elapsed prefix dropped (a channel dump stops being a timeline)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '  sink?.(`${formatElapsed(Date.now() - originMs)} ${tag} ${text}`);',
    replace: '  sink?.(`${tag} ${text}`);',
    killedBy: 'line-format test (every line starts with +<ms>ms since activation)'
  },
  {
    name: 'debugLog: the open rollup swallows unattributed time (`other` always reads 0)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '  const otherMs = totalMs - (scanMs + watchersMs + bootMs + initMs + toSweepMs);',
    replace: '  const otherMs = 0;',
    killedBy: 'other-span test (time no marked span claims must still be reported)'
  },
  {
    name: 'debugLog: webview boot measured from the open, not from the html assignment',
    file: 'src/debugLog.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '  const bootMs = m.readyAt - m.htmlAt;',
    replace: '  const bootMs = m.readyAt - m.startedAt;',
    killedBy: 'rollup-line test (each span is the difference between its own two marks)'
  },
  {
    name: 'debugLog: the init payload size is dropped from the rollup',
    file: 'src/debugLog.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '/${formatBytes(m.initBytes)}`',
    replace: '/${formatBytes(0)}`',
    killedBy: 'payload-size test (the rollup reports the bytes the init message actually serialized to)'
  },
  {
    name: 'provider: the open trace is allocated with debug off (instrumentation stops being free)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: 'const marks = debugEnabled() ? beginOpenMarks(Date.now()) : undefined;',
    replace: 'const marks = beginOpenMarks(Date.now());',
    killedBy: 'source-shape gate (the trace exists only behind debugEnabled())'
  },
  {
    name: 'provider: the open trace is never consumed (every later sweep re-emits the open rollup)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '      state.openMarks = undefined;\n      debug(\'[IC-OPEN]\'',
    replace: '      debug(\'[IC-OPEN]\'',
    killedBy: 'one-rollup-per-open test (a second sweep on the same panel must stay silent)'
  },
  {
    name: 'provider: the html mark taken at the scan-end site (boot swallows the watchers and the panel construction)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '      if (marks) marks.htmlAt = Date.now();',
    replace: '      if (marks) marks.htmlAt = marks.scanDoneAt;',
    killedBy: 'html-mark placement test (unmarked panel construction must surface in `other`, not in boot)'
  },
  {
    name: 'provider: the ready mark taken after the pending-debug flush (the flush migrates from `other` into boot)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: "        if (state.openMarks) state.openMarks.readyAt = Date.now();\n        state.webviewReady = true;\n        for (const msg of state.pendingDebugMessages) {\n          state.panel.webview.postMessage({ type: '_debug', msg });\n        }\n        state.pendingDebugMessages = [];",
    replace: "        state.webviewReady = true;\n        for (const msg of state.pendingDebugMessages) {\n          state.panel.webview.postMessage({ type: '_debug', msg });\n        }\n        state.pendingDebugMessages = [];\n        if (state.openMarks) state.openMarks.readyAt = Date.now();",
    killedBy: 'ready-mark placement test (the flush belongs to `other`; boot ends where the handler begins)'
  },
  {
    name: 'provider: the sweep mark taken at the posted payload (the hand-off reads ~0 and the plan falls between the two rollups)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '      openMarks.sweepAt = timed ? sweepStart : Date.now();',
    replace: '      openMarks.sweepAt = openMarks.initPostedAt;',
    killedBy: 'sweep-mark placement test (the hand-off ends on the sweep own clock, config read and plan included)'
  },
  {
    name: 'fileService: the scan reports stats with debug off (a payload nobody asked for)',
    file: 'src/fileService.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '    stats: timed ? { files: scannedFiles, matchMs } : undefined',
    replace: '    stats: { files: scannedFiles, matchMs }',
    killedBy: 'debug-off scan test (a scan with debug off carries no stats at all)'
  },
  {
    name: 'fileService: the rollup counts modality dirs instead of the files handed to the matcher',
    file: 'src/fileService.ts',
    suite: 'test/unit/openRollup.test.ts',
    find: '.reduce((n, files) => n + files.length, 0)',
    replace: '.reduce((n) => n + 1, 0)',
    killedBy: 'file-count test (6 images across 2 modality dirs, the .txt excluded)'
  },
  {
    name: 'debugChannel: config-change refresh ignored (the cached flag never updates)',
    file: 'src/debugChannel.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: "    if (e.affectsConfiguration('imageCompare')) applySettings();",
    replace: '    if (false) applySettings();',
    killedBy: 'runtime-toggle test (turning debug on mid-session must start logging)'
  },
  {
    name: 'debugChannel: channel never disposed (the output channel outlives the extension)',
    file: 'src/debugChannel.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '  channel?.dispose();',
    replace: '  /* mutated: channel left open */',
    killedBy: 'dispose test (disposing the subscription closes the ImageCompare channel)'
  },
  {
    name: 'debugLog: formatBytes unit threshold moved (byte counts misreport by 2x)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '  if (n < 1024) return `${Math.round(n)}B`;',
    replace: '  if (n < 2048) return `${Math.round(n)}B`;',
    killedBy: 'formatBytes test (1024 bytes reads as 1.0KB)'
  },
  {
    name: 'debugLog: tier diff inverted (a sweep reports negative work)',
    file: 'src/debugLog.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '      count: after[tier].count - before[tier].count,',
    replace: '      count: before[tier].count - after[tier].count,',
    killedBy: 'diffTierStats test (the delta is after minus before)'
  },
  {
    name: 'thumbnailService: pack hits attributed to memory (the tier histogram lies)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbTierStats.test.ts',
    find: "        if (timed) this.noteTier('pack', startedAt, waitedMs, packed.length, uri);",
    replace: "        if (timed) this.noteTier('memory', startedAt, waitedMs, packed.length, uri);",
    killedBy: 'pack-tier test (a pack-served thumbnail must count as pack)'
  },
  {
    name: 'thumbnailService: shared pack wait booked as per-item work (one read printed N times)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbSharedWait.test.ts',
    find: '    const ms = Math.max(0, Date.now() - startedAt - waitedMs);',
    replace: '    const ms = Date.now() - startedAt;',
    killedBy: 'concurrent-pack-hit tests (six items may not each report the one shared load)'
  },
  {
    name: 'thumbnailService: the shared read is never reported (the wait vanishes instead of moving)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbSharedWait.test.ts',
    find: '          this.packLoadStat.count++;',
    replace: '          /* mutated: shared read unreported */',
    killedBy: 'packLoad test (the one-off read must be counted once, with its bytes and ms)'
  },
  {
    name: 'thumbnailService: verbose thumb line hides the shared wait (per-item ms reads as the whole cost)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbSharedWait.test.ts',
    find: "${ms}ms${waitedMs > 0 ? ` +${waitedMs}ms packLoad wait` : ''}",
    replace: '${ms}ms',
    killedBy: 'verbose-line test (a thumb that queued behind the pack read must say so)'
  },
  {
    name: 'provider: sweep rollup drops the packLoad term (the reader loses the shared read)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/thumbSharedWait.test.ts',
    find: '${formatTierStats(tiers)} ${formatPackLoad(packLoad)} pool ',
    replace: '${formatTierStats(tiers)} pool ',
    killedBy: 'sweep-rollup test (the done line must carry packLoad=<n>x<ms> blocked=<callers>)'
  },
  {
    name: 'fileService: a matcher log site un-gated (debug-off builds strings it throws away)',
    file: 'src/fileService.ts',
    suite: 'test/unit/debugLog.test.ts',
    find: '          if (debugEnabled()) debugLog(`    candidate ref[${idx}]',
    replace: '          debugLog(`    candidate ref[${idx}]',
    killedBy: 'call-site gate test (every debugLog in fileService.ts sits behind debugEnabled())'
  },
  {
    name: 'provider: prefetch wave can roll up mid-issue (a sparse tuple erases both wave lines)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/prefetchWave.test.ts',
    find: '    if (!wave || wave.open || wave.done < wave.issued) return;',
    replace: '    if (!wave || wave.done < wave.issued) return;',
    killedBy: 'sparse-wave tests (a slot with no image settles synchronously, before issuing ends)'
  },
  {
    name: 'provider: prefetch wave never closes issuing (the rollup never fires)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/prefetchWave.test.ts',
    find: '      wave.open = false;',
    replace: '      /* mutated: wave left open */',
    killedBy: 'dense-wave test (the done rollup must land once every issued slot settles)'
  },
  {
    name: 'transport: byte budget removed (speculation floods the wire again)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '    return this.inFlight + bytes <= this.limitBytes;',
    replace: '    return true;',
    killedBy: 'in-flight bound test (peak speculative bytes must stay near one image, not the whole wave)'
  },
  {
    name: 'transport: sweep-active check dropped (a wave head-of-line blocks the carousel)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '    if (this.sweeping) return false;',
    replace: '    /* mutated: sweep gate dropped */',
    killedBy: 'sweep tests ([IC-SWEEP] done must report images=1, and thumbnails must land in <1.5 virtual s)'
  },
  {
    name: 'transport: user-facing bypass lost in the decision (canSend can now refuse a user push)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportBudget.test.ts',
    find: '    if (!speculative || this.limitBytes === Infinity) return true;',
    replace: '    if (this.limitBytes === Infinity) return true;',
    killedBy: 'never-withheld decision test (a user-facing push is allowed while sweeping and over budget)'
  },
  {
    name: 'provider: user-facing pushes routed through the budget (the bypass stops being structural)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '    if (speculative) {',
    replace: '    if (true) {',
    killedBy: 'never-withheld test (a mid-sweep user-facing image must reach the wire in the same turn)'
  },
  {
    name: 'transport: over-budget push never sent alone (a 16MB image is stranded forever)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportBudget.test.ts',
    find: '    if (this.inFlight === 0) return true;',
    replace: '    /* mutated: no single-push escape */',
    killedBy: 'whale test (a push larger than the budget must go when nothing is in flight)'
  },
  {
    name: 'transport: budget applied locally too (a same-process wire gets throttled)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportBudget.test.ts',
    find: '  if (remoteName === undefined) return Infinity;',
    replace: '  /* mutated: local sessions bounded too */',
    killedBy: 'local-session test (no remoteName means no bound, whatever the setting says)'
  },
  {
    name: 'transport: parked pushes released newest-first (the wave delivers out of order)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportBudget.test.ts',
    find: '    const first = this.parked.values().next();',
    replace: '    const first = { done: this.parked.size === 0, value: [...this.parked.values()].pop() };',
    killedBy: 'oldest-first parking test (A must be released before B)'
  },
  {
    name: 'provider: prefetch pushes posted as user-facing (the policy never sees them)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: 'width, height }, true);',
    replace: 'width, height }, false);',
    killedBy: 'sweep + budget tests (an unclassified wave crosses the wire during the sweep)'
  },
  {
    name: 'provider: sweep never claims the wire (speculation ignores the sweep)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '    state.transport.setSweepActive(true);',
    replace: '    /* mutated: sweep never claims the wire */',
    killedBy: 'sweep tests (the wave crosses the channel while thumbnails wait)'
  },
  {
    name: 'provider: parked pushes never released (deferred speculation is lost)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '      this.postImage(state, next.item, true);',
    replace: '      /* mutated: parked push dropped on release */',
    killedBy: 'delivery test (all 21 deferred pushes must land once the sweep ends)'
  },
  {
    name: 'provider: budget never released on ack (prefetch stops after one budget)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportFairness.test.ts',
    find: '      state.transport.noteDelivered(bytes);',
    replace: '      /* mutated: ack releases nothing */',
    killedBy: 'delivery test (with no credit returned the wave never finishes crossing)'
  },
  {
    name: 'transport: sweep claim leaks when the prologue throws (speculation parks for the panel life)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '      endSweep();\n      throw error;',
    replace: '      throw error;',
    killedBy: 'synchronous-throw test (the wire claim is released even when generateAllThumbnails throws)'
  },
  {
    name: 'transport: sweep stall watchdog removed (one hung read parks speculation forever)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '      state.sweepIdleTimer = setTimeout(endSweep, TRANSPORT_SWEEP_IDLE_TIMEOUT_MS);',
    replace: '      /* mutated: no stall watchdog */',
    killedBy: 'stalled-sweep test (the wire is released and the park delivered after the idle timeout)'
  },
  {
    name: 'transport: stall watchdog not re-armed by progress (it becomes a total-time cutoff)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '          armStallWatchdog();',
    replace: '          /* mutated: watchdog never re-armed */',
    killedBy: 'long-sweep test (a sweep still settling slots keeps the wire past the timeout)'
  },
  {
    name: 'transport: park/hold not re-keyed when a row is inserted (a payload lands in another file\'s slot)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    this.reindexPendingImagePosts(state, t => (t >= insertIndex ? t + 1 : t));',
    replace: '    /* mutated: wire posts left at stale indices */',
    killedBy: 'tuple-insert test (parked and held posts shift up with loadedImages)'
  },
  {
    name: 'transport: park/hold not re-keyed when a row is removed (stale slots survive the splice)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '        this.reindexPendingImagePosts(state, t => shiftIndexAfterRemoval(t, removed));',
    replace: '        /* mutated: wire posts left at stale indices */',
    killedBy: 'tuple-removal test (the removed row\'s posts are dropped, the ones behind it shift down)'
  },
  {
    name: 'transport: park/hold survive a modality insert (every slot key now names another column)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    state.loadedImages.clear();\n    this.dropPendingImagePosts(state);',
    replace: '    state.loadedImages.clear();\n    /* mutated: stale wire posts kept across a column splice */',
    killedBy: 'modality-splice test (parked and held posts go the way loadedImages does)'
  },
  {
    name: 'transport: park/hold survive a modality removal (same stale-column trap on the way out)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '        this.dropPendingImagePosts(state);',
    replace: '        /* mutated: stale wire posts kept across a column splice */',
    killedBy: 'modality-splice test (the removal half clears them too)'
  },
  {
    name: 'transport: re-key moves the slot key but not the payload (the message keeps the old tuple)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    out.push([`${next}-${column}`, next === post.tupleIndex ? post : { ...post, tupleIndex: next } as T]);',
    replace: '    out.push([`${next}-${column}`, post]);',
    killedBy: 'tuple-insert test (the posted tupleIndex shifts with its key)'
  },
  {
    name: 'transport: re-keying the park reverses it (oldest-first release order is lost)',
    file: 'src/transportBudget.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    const entries = [...this.parked.values()];',
    replace: '    const entries = [...this.parked.values()].reverse();',
    killedBy: 'tuple-insert test (the park keeps its oldest-first order across a splice)'
  },
  {
    name: 'transport: burst hold stops re-arming (only one held payload ever reaches the wire)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '      if (state.heldImagePosts.size > 0) this.scheduleBurstFlush(state, 32);',
    replace: '      /* mutated: held payloads after the first are stranded */',
    killedBy: 'hold-trickle test (a park released mid-scrub leaves one payload per ~32ms tick until it is empty)'
  },
  {
    name: 'transport: ack watchdogs outlive the panel (a closed panel is retained for 30s)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    for (const timer of state.ackWatchdogs ?? []) clearTimeout(timer);',
    replace: '    /* mutated: ack watchdogs left armed */',
    killedBy: 'dispose test (no transport timer is left armed after the panel closes)'
  },
  // ── Slot invalidation clears the wire copies too (docs/loading-architecture.md: slot-invalidation-clears-the-wire) ──
  {
    name: 'transport: slot invalidation leaves the parked payload (it posts later as a ghost)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    state.transport.drop(slotKey);\n    state.heldImagePosts.delete(slotKey);',
    replace: '    state.heldImagePosts.delete(slotKey);',
    killedBy: 'slot-invalidation tests (a payload parked for a deleted, restored, renamed, rewritten or force-reloaded slot never posts)'
  },
  {
    name: 'transport: slot invalidation leaves the burst hold (the held payload paints the gone file)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    state.heldImagePosts.delete(slotKey);\n  }',
    replace: '  }',
    killedBy: 'held-burst test (a held payload for a deleted slot never reaches the wire)'
  },
  {
    name: 'transport: slot invalidation clears the whole park (live neighbours lose payloads they were about to be shown)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    state.loadedImages.delete(slotKey);\n    state.transport.drop(slotKey);',
    replace: '    state.loadedImages.delete(slotKey);\n    state.transport.clearParked();',
    killedBy: 'slot-invalidation tests (the neighbouring slot\'s parked payload still delivers)'
  },
  {
    name: 'transport: cache eviction treated as invalidation (a distant slot\'s parked payload is thrown away)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    for (const key of keysToDelete) {\n      state.loadedImages.delete(key);\n    }',
    replace: '    for (const key of keysToDelete) {\n      const [t, m] = key.split(\'-\').map(Number);\n      this.invalidateSlot(state, t, m);\n    }',
    killedBy: 'distant-eviction test (evicting bytes for live slots leaves the park alone)'
  },
  {
    name: 'transport: a forceReload retry clears only the cache (the undecodable bytes stay parked)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '    if (forceReload) {\n      this.invalidateSlot(state, tupleIndex, modalityIndex);\n    }',
    replace: '    if (forceReload) {\n      state.loadedImages.delete(cacheKey);\n    }',
    killedBy: 'forceReload test (the retry drops the parked copy of the bytes it is asking past)'
  },
  {
    name: 'transport: a seen delete clears only the cache (the parked payload survives the file)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '          this.invalidateSlot(state, tupleIndex, globalModIdx);',
    replace: '          state.loadedImages.delete(`${tupleIndex}-${globalModIdx}`);',
    killedBy: 'delete-seen test (the park is dropped the moment the delete is reported)'
  },
  {
    name: 'transport: the delete commit clears only the cache (a payload parked inside the rename window posts)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '                onSlotRemoved: (t, m) => this.invalidateSlot(state, t, m),',
    replace: '                onSlotRemoved: (t, m) => state.loadedImages.delete(`${t}-${m}`),',
    killedBy: 'rename-window test (the commit drops what was parked while the window was open)'
  },
  {
    name: 'transport: a restore clears only the cache (the pre-delete payload still paints)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: 'd.uri.toString() !== uri.toString());\n\n      this.invalidateSlot(state, tupleIndex, modalityIndex);',
    replace: 'd.uri.toString() !== uri.toString());\n\n      state.loadedImages.delete(`${tupleIndex}-${modalityIndex}`);',
    killedBy: 'restore test (the stale parked payload goes when the file comes back)'
  },
  {
    name: 'transport: a rename onto the slot clears only the cache (the old name\'s payload still paints)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '      );\n\n      this.invalidateSlot(state, tupleIndex, modalityIndex);',
    replace: '      );\n\n      state.loadedImages.delete(`${tupleIndex}-${modalityIndex}`);',
    killedBy: 'rename test (the stale parked payload goes when a rename lands on the slot)'
  },
  {
    name: 'transport: an in-place rewrite clears only the cache (the previous contents still paint)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/transportLifetime.test.ts',
    find: '        this.invalidateSlot(state, tupleIndex, modalityIndex);\n        this.regenerateThumbnail(state, tupleIndex, modalityIndex);',
    replace: '        state.loadedImages.delete(`${tupleIndex}-${modalityIndex}`);\n        this.regenerateThumbnail(state, tupleIndex, modalityIndex);',
    killedBy: 'rewrite test (the stale parked payload goes when the file is rewritten in place)'
  },
  // ── Thumbnails on the binary wire (docs/loading-architecture.md: image-payload-normalized, thumb-url-owned-by-cache) ──
  {
    name: 'thumbnail wire: the post path skips normalizeImageBytes (a pack slice ships the whole packfile)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/thumbnailWire.test.ts',
    find: '    const tight = normalizeImageBytes(bytes);',
    replace: '    const tight = bytes;',
    killedBy: 'pack-slice test (posted bytes must be a plain, offset-0, exactly-sized Uint8Array)'
  },
  {
    name: 'thumbUrlCache: the incoming url is revoked instead of the superseded one',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: '    if (prev !== url) this.release(prev);',
    replace: '    if (prev !== url) this.release(url);',
    killedBy: 'supersede test (the url the tile just adopted must survive)'
  },
  {
    name: 'thumbUrlCache: the superseded url is revoked before the successor is adopted',
    file: 'src/webview/thumbUrlCache.ts',
    find: '    if (adopt) adopt();\n    if (prev !== url) this.release(prev);',
    suite: 'test/unit/thumbUrlCache.test.ts',
    replace: '    if (prev !== url) this.release(prev);\n    if (adopt) adopt();',
    killedBy: 'adopt-order test (revoking first kills a tile that is still loading the url)'
  },
  {
    name: 'thumbUrlCache: clear() drops every url without revoking (one leaked blob per tile per re-init)',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: '    for (const url of this.urls.values()) this.release(url);',
    replace: '    /* mutated: cleared without revoking */',
    killedBy: 'delete/clear test (clear revokes exactly the object urls it drops)'
  },
  {
    name: 'thumbUrlCache: a re-key that drops an entry leaks its url',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: '      if (moved === null) this.release(url);',
    replace: '      if (moved === null) { /* mutated: dropped without revoking */ }',
    killedBy: 'row-removal re-key test (the removed row\'s urls are revoked)'
  },
  {
    name: 'thumbUrlCache: the shared placeholder data url is revoked like an object url',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: '    if (url === undefined || !isObjectUrl(url)) return;',
    replace: '    if (url === undefined) return;',
    killedBy: 'placeholder test (a data url is stored but never revoked)'
  },
  {
    name: 'thumbUrlCache: the empty-slot tile src is empty (a recycled tile keeps the broken-image glyph)',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: "  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==';",
    replace: "  '';",
    killedBy: 'blank-tile test (an empty slot\'s tile must hold a decodable 1x1 transparent png)'
  },
  {
    name: 'thumbUrlCache: the blank tile png is opaque black (every not-yet-loaded tile is tinted)',
    file: 'src/webview/thumbUrlCache.ts',
    suite: 'test/unit/thumbUrlCache.test.ts',
    find: "  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==';",
    replace: "  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWMAgv8AAQQBAP8H9UQAAAAASUVORK5CYII=';",
    killedBy: 'blank-tile test (the one pixel must be fully transparent)'
  },
  {
    name: 'thumbnailService: tier accounting runs with debug off (diagnostics stop being free)',
    file: 'src/thumbnailService.ts',
    suite: 'test/unit/thumbTierStats.test.ts',
    find: '    const timed = debugEnabled();',
    replace: '    const timed = true;',
    killedBy: 'debug-off test (no counter moves while imageCompare.debug is off)'
  },

  // ── Tuple load scheduling: the arrival policy, its ordering, and who cancels what ──
  {
    name: 'tupleLoad: dwell gate removed (arrival asks for the whole tuple again)',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '  return { now, afterDwell: siblingLoadPlan(input) };',
    replace: '  return { now: [...now, ...siblingLoadPlan(input)], afterDwell: [] };',
    killedBy: 'arrival test (a navigation requests exactly the on-screen modality)'
  },
  {
    name: 'tupleLoad: sibling distance ordering reversed (farthest modality first)',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '.sort((a, b) => Math.abs(a.step - here) - Math.abs(b.step - here) || b.step - a.step);',
    replace: '.sort((a, b) => Math.abs(b.step - here) - Math.abs(a.step - here) || b.step - a.step);',
    killedBy: 'nearest-first test (the modality `->` reaches must arrive first)'
  },
  {
    name: 'tupleLoad: siblings ordered by raw modality id, not display distance',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '.sort((a, b) => Math.abs(a.step - here) - Math.abs(b.step - here) || b.step - a.step);',
    replace: '.sort((a, b) => modalityOrder[a.display] - modalityOrder[b.display]);',
    killedBy: 'display-order test (a rearranged column set must not fall back to id order)'
  },
  {
    name: 'tupleLoad: hidden modalities speculated on like any other',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '    if (d === currentDisplayIndex || !isHidden(modalityOrder[d])) reachable.push(d);',
    replace: '    reachable.push(d);',
    killedBy: 'hidden-skip test (a hidden pill is neither a target nor a step)'
  },
  {
    name: 'tupleLoad: nearest-two split removed (every sibling rides SIBLING)',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '    rank: i < NEAREST_SIBLINGS ? \'sibling\' : \'tail\'',
    replace: '    rank: \'sibling\' as const',
    killedBy: 'split test (only the nearest two rank above the tail, however wide the tuple)'
  },
  {
    name: 'tupleLoad: an outstanding request suppresses every re-ask (no rank upgrade)',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: '  return posted !== undefined && RANK_ORDER[posted] >= RANK_ORDER[wanted];',
    replace: '  return posted !== undefined;',
    killedBy: 'rank-upgrade test (a slot queued at tail must be re-asked when it goes on screen)'
  },
  {
    name: 'tupleLoad: the rank ladder is flat (tail counts as high as visible)',
    file: 'src/webview/tupleLoadPlan.ts',
    suite: 'test/unit/tupleLoadPlan.test.ts',
    find: "const RANK_ORDER: Record<SlotRank, number> = { visible: 2, sibling: 1, tail: 0 };",
    replace: "const RANK_ORDER: Record<SlotRank, number> = { visible: 0, sibling: 0, tail: 0 };",
    killedBy: 'rank-upgrade test (visible outranks sibling outranks tail)'
  },
  // ── Prefetch scope: which columns a wave speculates on, and in what order ──
  {
    name: 'prefetchPlan: the wave widens back to every modality of every neighbour',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: '  for (const modalityIndex of prefetchColumns(input.scope)) {',
    replace: '  for (const modalityIndex of input.scope.modalityOrder) {',
    killedBy: 'field-shape test (7 tuples x 3 columns, never 7 x 10)'
  },
  {
    name: 'prefetchPlan: the on-screen column is dropped from the wave',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: '  return shown === undefined ? nearest : [shown, ...nearest];',
    replace: '  return nearest;',
    killedBy: 'column test (the wave leads with the column on screen)'
  },
  {
    name: 'prefetchPlan: the nearest-two filter is dropped (every sibling column speculated on)',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: "    .filter(s => s.rank === 'sibling')",
    replace: '    .filter(() => true)',
    killedBy: 'width test (never more than three columns, however wide the tuple)'
  },
  {
    name: 'prefetchPlan: hidden columns speculated on like any other',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: '  const nearest = siblingLoadPlan({ ...scope, isCached: () => false })',
    replace: '  const nearest = siblingLoadPlan({ ...scope, isHidden: () => false, isCached: () => false })',
    killedBy: 'hidden-column test (no key can reach a hidden pill)'
  },
  {
    name: 'prefetchPlan: wave issued tuple-major (the neighbour visible column queues behind the centre siblings)',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: '  for (const modalityIndex of prefetchColumns(input.scope)) {\n    for (const tupleIndex of tuples) {',
    replace: '  for (const tupleIndex of tuples) {\n    for (const modalityIndex of prefetchColumns(input.scope)) {',
    killedBy: 'column-major test (every neighbour on-screen column before any sibling column)'
  },
  {
    name: 'prefetchPlan: the band walks forward only (behind the user is never prefetched)',
    file: 'src/prefetchPlan.ts',
    suite: 'test/unit/prefetchPlan.test.ts',
    find: '    for (const t of offset === 0 ? [centerIndex] : [centerIndex + offset, centerIndex - offset]) {',
    replace: '    for (const t of offset === 0 ? [centerIndex] : [centerIndex + offset]) {',
    killedBy: 'band test (prefetchCount still means ahead AND behind)'
  },
  {
    name: 'provider: the reported strip is ignored (the wave re-reads the modality list itself)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/prefetchWave.test.ts',
    find: '      scope,\n      isCached: (t, m) => state.loadedImages.has(`${t}-${m}`)',
    replace: '      scope: { modalityOrder: state.scanResult.modalities.map((_, i) => i), currentDisplayIndex: 0, isHidden: () => false },\n      isCached: (t, m) => state.loadedImages.has(`${t}-${m}`)',
    killedBy: 'wide-wave test (the wave follows the display order the webview reported)'
  },
  {
    name: 'workPool: the sibling tail competes with the sweep (fair share instead of strictly last)',
    file: 'src/workPool.ts',
    suite: 'test/unit/workPool.test.ts',
    find: '    if (p === Priority.SIBLING_TAIL && this.anyQueuedElsewhere(p)) return false;',
    replace: '    /* mutated: the tail takes its fair share of speculative slots */',
    killedBy: 'Test 18 (the sweep keeps every speculative slot while it has queue)'
  },
  {
    name: 'provider: the tail flag is ignored (tail loads queue at SIBLING)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/tupleLoadScheduling.test.ts',
    find: '          message.tail ? Priority.SIBLING_TAIL : message.sibling ? Priority.SIBLING : Priority.VISIBLE,',
    replace: '          message.sibling ? Priority.SIBLING : Priority.VISIBLE,',
    killedBy: 'tail-class test (tail requests queue in their own class, never as siblings)'
  },
  {
    name: 'provider: image loads keyed by panel again (nothing to cancel per tuple)',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/tupleLoadScheduling.test.ts',
    find: '      await this.pool.submit(() => serveImage(imageFile, io, deliver), { priority, key: loadKey });',
    replace: '      await this.pool.submit(() => serveImage(imageFile, io, deliver), { priority, key: state.poolKey });',
    killedBy: 'browse test (only the current tuple stays queued after six navigations)'
  },
  {
    name: 'provider: navigating away cancels nothing',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/tupleLoadScheduling.test.ts',
    find: '        this.cancelImageLoads(state, message.tupleIndex);',
    replace: '        /* mutated: the tuple left behind keeps its queued loads */',
    killedBy: 'browse test (the tuple you left must not keep nine queued reads)'
  },
  {
    name: 'provider: dispose leaves per-tuple loads queued',
    file: 'src/imageCompareProvider.ts',
    suite: 'test/unit/tupleLoadScheduling.test.ts',
    find: '    this.cancelImageLoads(state); // per-tuple keys outlive poolKey',
    replace: '    /* mutated: only poolKey is cancelled */ // per-tuple keys outlive poolKey',
    killedBy: 'dispose test (a closed panel leaves nothing queued)'
  },

  // ── Standalone artifact freshness: a non-src file, because "built once by
  //    globalSetup" is only safe while "already built" stays an honest question (docs/testing.md) ──
  {
    name: 'standalone artifact: freshness downgraded to an existence check (any artifact counts as current)',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: '  if (newest && newest.mtimeMs >= artifact.mtimeMs) {',
    replace: '  if (newest && false) {',
    killedBy: 'stale tests (a newer build input must not read as fresh)'
  },
  {
    name: 'standalone artifact: an input sharing the artifact mtime reads as fresh',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: '  if (newest && newest.mtimeMs >= artifact.mtimeMs) {',
    replace: '  if (newest && newest.mtimeMs > artifact.mtimeMs) {',
    killedBy: 'shared-mtime test (a build reads its inputs before it writes, so a tie is an edit after)'
  },
  {
    name: 'standalone artifact: src/ dropped from the input set',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "  { dir: 'src', exts: ['.ts'] },\n",
    replace: '',
    killedBy: 'input-set and src-stale tests (a changed src file must make the page stale)'
  },
  {
    name: 'standalone artifact: standalone/ dropped from the input set',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "  { dir: 'standalone', exts: ['.ts', '.mjs'] },\n",
    replace: '',
    killedBy: 'input-set and adapter-stale tests (a changed adapter must make the page stale)'
  },
  {
    name: 'standalone artifact: a missing artifact reported as fresh',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "    return { state: 'missing' };",
    replace: "    return { state: 'fresh' };",
    killedBy: 'missing test (no page on disk is not a current page)'
  },
  {
    name: 'standalone artifact: completeness check dropped (a zero-byte page written now reads as fresh)',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "  if (damage) return { state: 'corrupt', detail: damage };",
    replace: '  /* mutated: whatever the write left behind is served */',
    killedBy: 'corrupt tests (a truncated or empty artifact with the newest mtime must not read as fresh)'
  },
  {
    name: 'standalone artifact: an unlistable input tree no longer blocks a fresh verdict',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "  if (unreadable) return { state: 'unverifiable', detail: `${unreadable} could not be listed` };",
    replace: '  /* mutated: an input set that cannot be enumerated counts as evidence */',
    killedBy: 'unlistable-tree test (a src/ that cannot be read is not proof the page is current)'
  },
  {
    name: 'standalone artifact: an empty input set reads as fresh',
    file: 'test/webview/standaloneArtifact.ts',
    suite: 'test/unit/standaloneArtifact.test.ts',
    find: "  if (!newest) return { state: 'unverifiable', detail: 'no build input was found' };",
    replace: '  /* mutated: no inputs found means nothing is newer */',
    killedBy: 'no-inputs test (finding no build input at all is not evidence of freshness)'
  },

  // ── Webview suite sizing/report layout: the rules CI structurally cannot pin, because on a
  //    runner cpus() and availableParallelism() agree and the wrong call stays green (docs/testing.md) ──
  {
    name: 'playwright config: worker count sized from the reported core count again',
    file: 'test/webview/playwright.config.ts',
    suite: 'test/unit/playwrightConfig.test.ts',
    find: 'os.availableParallelism() / 2',
    replace: 'os.cpus().length / 2',
    killedBy: 'worker-sizing test (256 cores reported, 4 usable must size 2 workers, not 128)'
  },
  {
    name: 'playwright config: outputDir dropped back to the default that parents the HTML report',
    file: 'test/webview/playwright.config.ts',
    suite: 'test/unit/playwrightConfig.test.ts',
    find: "  outputDir: './test-results',\n",
    replace: '',
    killedBy: 'report-layout test (the html report must not sit inside the test output folder)'
  }
];

// ── Sandbox: mutations land on a throwaway copy, never the working tree (docs/testing.md) ──
function copyList() {
  const roots = ['src', 'test', 'package.json'];
  for (const entry of readdirSync(repoRoot)) {
    if (/^tsconfig.*\.json$/.test(entry)) roots.push(entry);
  }
  return roots;
}

let sandbox = null;
let sandboxRemoved = false;

function createSandbox() {
  const box = mkdtempSync(join(tmpdir(), 'imagecompare-mutation-'));
  for (const rel of copyList()) cpSync(join(repoRoot, rel), join(box, rel), { recursive: true });
  const modules = join(box, 'node_modules');
  mkdirSync(modules);
  // Per-entry links rather than one link to node_modules: the sandbox gets its own empty .vite cache.
  for (const entry of readdirSync(join(repoRoot, 'node_modules'))) {
    if (entry === '.vite' || entry === '.cache') continue;
    const from = join(repoRoot, 'node_modules', entry);
    let isDir;
    try {
      isDir = statSync(from).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      symlinkSync(from, join(modules, entry), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      copyFileSync(from, join(modules, entry));
    }
  }
  return box;
}

function removeSandbox() {
  if (!sandbox || sandboxRemoved) return;
  sandboxRemoved = true;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    console.error(`Could not remove the sandbox: ${sandbox}`);
  }
}

// ── Checksum manifest: turn a silent poisoning into a message naming the file ──
const manifest = [];
const applied = new Map();
const manifestFailures = [];
const manifestNotices = [];
let manifestChecked = false;

function hashFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function recordManifest(files) {
  for (const rel of files) {
    for (const side of ['repo', 'sandbox']) {
      const p = join(side === 'repo' ? repoRoot : sandbox, rel);
      try {
        manifest.push({ p, rel, side, hash: hashFile(p), text: readFileSync(p, 'utf8') });
      } catch {
        // A file that cannot be read is reported by the find-string check below.
      }
    }
  }
}

function verifyManifest() {
  if (manifestChecked) return manifestFailures.length > 0;
  manifestChecked = true;
  for (const entry of manifest) {
    let hash = null;
    let text = null;
    try {
      hash = hashFile(entry.p);
      text = readFileSync(entry.p, 'utf8');
    } catch {
      hash = null;
    }
    if (hash === entry.hash) continue;
    // Poisoned-by-this-run vs edited-during-this-run: docs/testing.md, "A green suite is not evidence".
    const poisoned = text !== null && (applied.get(entry.rel) ?? []).some((m) => entry.text.replace(m.find, m.replace) === text);
    if (entry.side === 'repo' && !poisoned) {
      manifestNotices.push(entry.p);
      continue;
    }
    manifestFailures.push(entry.p);
  }
  if (manifestFailures.length) {
    console.error('\nMANIFEST MISMATCH — a file the run touched is not back to its original bytes:');
    for (const p of manifestFailures) console.error(`  - ${p}`);
  }
  if (manifestNotices.length) {
    console.error('\nNOTE — changed while the run was in progress, not by it (the run mutates its sandbox copy):');
    for (const p of manifestNotices) console.error(`  - ${p}`);
  }
  return manifestFailures.length > 0;
}

// Restore-on-interrupt: track the file currently mutated so a signal cannot leave it dirty.
let inFlight = null; // { path, original: Buffer }
let restoreFailed = false;
function restoreInFlight() {
  if (!inFlight) return;
  const { path: target, original } = inFlight;
  inFlight = null; // cleared first: a second handler must not retry a write that already threw
  try {
    writeFileSync(target, original);
  } catch (err) {
    restoreFailed = true;
    console.error(`\nCOULD NOT RESTORE ${target} (${err.message})`);
    console.error('  The sandbox went away mid-run (a temp reaper, or an rm -rf). Nothing was written to the working tree, so src/ is intact; delete any leftover imagecompare-mutation-* dir under the temp root and re-run. Exiting non-zero.');
  }
}

// Every handleable exit path restores, verifies the manifest, then drops the sandbox.
function finish(code) {
  restoreInFlight();
  const dirty = verifyManifest();
  removeSandbox();
  process.exit(dirty || restoreFailed ? 1 : code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => finish(130));
}
process.on('uncaughtException', (err) => {
  console.error('\nuncaughtException - restoring and dropping the sandbox:');
  console.error(err);
  finish(1);
});
// Named separately from uncaughtException so a test can prove which handler ran (docs/testing.md).
process.on('unhandledRejection', (err) => {
  console.error('\nunhandledRejection - restoring and dropping the sandbox:');
  console.error(err);
  finish(1);
});
process.on('exit', () => {
  restoreInFlight();
  if (verifyManifest() || restoreFailed) process.exitCode = 1;
  removeSandbox();
});

// Test seam (docs/testing.md): unset in every real run, so the default path is the old one.
const seam = process.env.MUTATION_CHECK_TEST ? JSON.parse(process.env.MUTATION_CHECK_TEST) : null;
const selected = seam?.mutations ?? (seam?.only ? mutations.filter((m) => m.name.includes(seam.only)) : mutations);
if (selected.length === 0) {
  console.error('MUTATION_CHECK_TEST selected no mutations.');
  process.exit(1);
}

// A seam-narrowed run is not the gate and must never exit 0 — the subset exit, docs/testing.md.
const SUBSET_EXIT = 2;
const subsetTrailer = () => `NOT A GATE - subset run: ${selected.length} of ${mutations.length} mutations, chosen by MUTATION_CHECK_TEST. Only a full run (env var unset) can exit 0.`;
if (seam) {
  const bar = '#'.repeat(78);
  console.log(`\n${bar}\n##  SUBSET RUN - NOT THE GATE\n##  MUTATION_CHECK_TEST is set: ${selected.length} of ${mutations.length} mutations will run.\n##  Whatever this run prints, it certifies nothing about the suites. It exits ${SUBSET_EXIT}.\n${bar}\n`);
}

// spawnSync blocks the loop: yield between suites so a pending signal handler actually runs.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function seamHook(m) {
  console.log(`##MC applied ${m.file}`);
  if (seam.throwAfterApply) {
    setTimeout(() => {
      throw new Error('MUTATION_CHECK_TEST injected failure');
    }, 10);
  }
  if (seam.rejectAfterApply) {
    setTimeout(() => {
      Promise.reject(new Error('MUTATION_CHECK_TEST injected rejection'));
    }, 10);
  }
  if (seam.pauseMs) await new Promise((resolve) => setTimeout(resolve, seam.pauseMs));
}

sandbox = createSandbox();
recordManifest([...new Set(selected.map((m) => m.file))]);
console.log(`Sandbox: ${sandbox} (mutations are applied here; the working tree is never written)`);

function runSuite(suite) {
  // Every suite is a Vitest suite under test/unit/, run against the sandbox copy.
  const args = ['vitest', 'run', suite, '--config', 'test/vitest.config.ts'];
  return spawnSync('npx', args, { cwd: sandbox, encoding: 'utf8' });
}

function fail(msg, res) {
  console.error(`\n${msg}`);
  if (res) {
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
  }
}

// ── Baseline: every referenced suite must be green before we trust a kill ──
const suites = [...new Set(selected.map((m) => m.suite))];
console.log('Baseline (no mutation) — every suite must be green:');
let baselineGreen = true;
for (const suite of suites) {
  await yieldToLoop();
  const res = runSuite(suite);
  if (res.status === 0) {
    console.log(`  green  ${suite}`);
  } else {
    baselineGreen = false;
    fail(`  RED    ${suite}  (exit ${res.status}${res.error ? `, ${res.error.message}` : ''})`, res);
  }
}
if (!baselineGreen) {
  console.error('\nBaseline is not green — cannot run the mutation check. Fix the suite first.');
  process.exit(1);
}

// ── Mutations: each must make its suite FAIL (be killed) ──
console.log('\nMutations — each must be killed (suite must fail):');
const survivors = [];
const harnessErrors = [];
for (const m of selected) {
  await yieldToLoop();
  const path = join(sandbox, m.file);
  const original = readFileSync(path);
  const text = original.toString('utf8');

  if (m.find === m.replace) {
    harnessErrors.push(`${m.name}: find === replace (no-op mutation)`);
    console.log(`  ERROR    ${m.name} — find and replace are identical`);
    continue;
  }
  if (!text.includes(m.find)) {
    harnessErrors.push(`${m.name}: find string not present in ${m.file}`);
    console.log(`  ERROR    ${m.name} — find string not found in ${m.file}`);
    continue;
  }
  const mutated = text.replace(m.find, m.replace);
  if (mutated === text) {
    harnessErrors.push(`${m.name}: replace produced no change`);
    console.log(`  ERROR    ${m.name} — replace produced no change`);
    continue;
  }

  inFlight = { path, original };
  if (!applied.has(m.file)) applied.set(m.file, []);
  applied.get(m.file).push({ find: m.find, replace: m.replace });
  let res;
  try {
    writeFileSync(path, mutated);
    if (seam) await seamHook(m);
    res = runSuite(m.suite);
  } finally {
    writeFileSync(path, original);
    inFlight = null;
  }

  if (res.status === null) {
    harnessErrors.push(`${m.name}: could not run suite (${res.error ? res.error.message : 'unknown'})`);
    console.log(`  ERROR    ${m.name} — suite did not run`);
    continue;
  }

  if (res.status !== 0) {
    console.log(`  KILLED   ${m.name}  [${m.file} -> ${m.suite}]`);
  } else {
    survivors.push(m);
    console.log(`  SURVIVED ${m.name}  [${m.file} -> ${m.suite}]  expected kill: ${m.killedBy}`);
  }
}

// ── Summary ──
console.log(`\n${'='.repeat(60)}`);
const killed = selected.length - survivors.length - harnessErrors.length;
console.log(`Mutations: ${selected.length}  killed: ${killed}  survived: ${survivors.length}  errors: ${harnessErrors.length}`);
if (survivors.length) {
  console.error('\nSURVIVORS (real coverage gaps — the test owner must add coverage):');
  for (const m of survivors) {
    console.error(`  - ${m.name}: expected ${m.killedBy} to fail, but ${m.suite} stayed green.`);
  }
}
if (harnessErrors.length) {
  console.error('\nHARNESS ERRORS:');
  for (const e of harnessErrors) console.error(`  - ${e}`);
}
const manifestDirty = verifyManifest();
if (survivors.length || harnessErrors.length || manifestDirty) {
  if (seam) console.error(`\n${subsetTrailer()}`);
  process.exit(1);
}
if (seam) {
  console.log(`\n${subsetTrailer()}`);
  process.exit(SUBSET_EXIT);
}
console.log(`\nAll ${mutations.length} mutations killed. The suites pin the rules they claim to.`);
