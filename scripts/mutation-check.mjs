#!/usr/bin/env node
/**
 * Mutation check: a green test suite is not evidence — see docs/testing.md.
 *
 * For each fixed mutation, apply it to a source file, run the suite that should
 * catch it, and assert the suite now FAILS. A mutation that leaves the suite
 * green "survived" — a real coverage gap. The baseline (no mutation) must be
 * green first. Every file is restored from its original bytes in a finally,
 * even on throw or interrupt, so no mutated source is ever left behind.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

/**
 * Each mutation names the file it edits, the suite that must kill it, and why
 * that file is the one under test. tupleMatching.test.ts embeds its own copy of
 * the matching functions (docs/tuple-matching.md), so those mutations target the
 * test file itself — mutating src/fileService.ts would not affect the suite. The
 * other suites import the real source, so those mutations hit src/*.
 */
const mutations = [
  // ── Tuple matching: the suite exercises an in-test copy, so mutate the test file ──
  {
    name: 'tuple: crop-deprioritization removed',
    file: 'src/test/tupleMatching.test.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: 'const isBetter = (!isCrop && bestIsCrop) ||',
    replace: 'const isBetter = (false && bestIsCrop) ||',
    killedBy: 'Test 4/5 (non-crop ref must win over a closer-length crop ref)'
  },
  {
    name: 'tuple: length tie-break comparator inverted',
    file: 'src/test/tupleMatching.test.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: '(isCrop === bestIsCrop && lenDiff < bestLenDiff) ||',
    replace: '(isCrop === bestIsCrop && lenDiff > bestLenDiff) ||',
    killedBy: 'Test 6 (closer-length ref must win)'
  },
  {
    name: 'tuple: LCS tie-break disabled',
    file: 'src/test/tupleMatching.test.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: '(isCrop === bestIsCrop && lenDiff === bestLenDiff && lcs > bestLcs);',
    replace: '(isCrop === bestIsCrop && lenDiff === bestLenDiff && false);',
    killedBy: 'Test 7 (higher-LCS ref must win)'
  },
  {
    name: 'tuple: final name-sort removed (display order falls back to key order)',
    file: 'src/test/tupleMatching.test.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: '  tuples.sort((a, b) => naturalSort(a.name, b.name));',
    replace: '  /* mutated: no final name sort */',
    killedBy: 'Test 8 (parent row precedes its crop despite reversed key order)'
  },
  {
    name: 'tuple: row sort reversed',
    file: 'src/test/tupleMatching.test.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: 'result.sort((a, b) => naturalSort(a.key, b.key));',
    replace: 'result.sort((a, b) => naturalSort(b.key, a.key));',
    killedBy: 'Test 8 (rows sorted by ref basename, asserted by index)'
  },

  // ── PPMX parser: the suite imports the real source ──
  {
    name: 'ppmx: size-based flags guard weakened (empty line accepted)',
    file: 'src/ppmxParser.ts',
    suite: 'src/test/ppmxParser.test.ts',
    find: 'const looksLikeFlags = flags.length > 0 && /^[\\x20-\\x7e]+$/.test(flags);',
    replace: 'const looksLikeFlags = /^[\\x20-\\x7e]*$/.test(flags);',
    killedBy: 'Test 11 (a 0x0A first pixel must not be eaten as an empty flags line)'
  },
  {
    name: 'ppmx: header magic check removed',
    file: 'src/ppmxParser.ts',
    suite: 'src/test/ppmxParser.test.ts',
    find: "if (header !== 'PPMX' && header !== 'P7') {",
    replace: 'if (false) {',
    killedBy: 'Test 8 (an unknown magic must be rejected)'
  },

  // ── PNG tEXt: the suite imports the real source ──
  {
    name: 'pngText: one CRC table entry corrupted',
    file: 'src/pngText.ts',
    suite: 'src/test/pngTextChunk.test.ts',
    find: '  return table;\n})();',
    replace: '  table[42] ^= 1; return table;\n})();',
    killedBy: 'Test 9 (the full-table CRC probe touches all 256 entries)'
  },
  {
    name: 'pngText: off-by-one in the tEXt chunk length',
    file: 'src/pngText.ts',
    suite: 'src/test/pngTextChunk.test.ts',
    find: 'chunk.writeUInt32BE(data.length, 0);',
    replace: 'chunk.writeUInt32BE(data.length + 1, 0);',
    killedBy: 'Test 1 (inject+read round-trip)'
  },

  {
    name: 'modalityNames: fallback stops de-duplicating collided names',
    file: 'src/modalityNames.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: "  while (taken.has(`${name} (${n})`)) n++;",
    replace: "  while (false) n++;",
    killedBy: 'Test 10 (unique modality names)'
  },
  {
    name: 'modalityNames: uniquify stops registering the name it hands out',
    file: 'src/modalityNames.ts',
    suite: 'src/test/tupleMatching.test.ts',
    find: "  taken.add(unique);",
    replace: "  /* mutated */",
    killedBy: 'Test 10 (unique modality names)'
  },
  {
    name: 'sessionFile: duplicate paths accepted',
    file: 'src/sessionFile.ts',
    suite: 'src/test/sessionFile.test.ts',
    find: "  if (new Set(compared).size !== compared.length) {",
    replace: "  if (false) {",
    killedBy: 'Test 12 (duplicate paths rejected)'
  },

  // ── Work pool: the suite imports the real source ──
  {
    name: 'workPool: priority ordering broken (class scan reversed)',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: 'for (let p = Priority.VISIBLE; p < Priority.PREFETCH; p++) {',
    replace: 'for (let p = Priority.PREFETCH - 1; p >= Priority.VISIBLE; p--) {',
    killedBy: 'Test 2/5 (strict priority ordering)'
  },
  {
    name: 'workPool: EXPORT demoted below speculation',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: '  EXPORT = 2, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation',
    replace: '  EXPORT = 3, // user-initiated crop and PPTX: asked for explicitly, so ahead of speculation',
    killedBy: 'Full priority ladder test'
  },
  {
    name: 'workPool: concurrency cap ignored',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: 'if (this.active >= this.concurrency) return false;',
    replace: 'if (false) return false;',
    killedBy: 'Test 1 (concurrency is never exceeded)'
  },
  {
    name: 'workPool: speculative slot reservation removed',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: 'return spec < this.concurrency - 1;',
    replace: 'return true;',
    killedBy: 'Test 11 (speculation leaves one slot free)'
  },
  {
    name: 'workPool: foreground courtesy to queued background removed',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: 'return atOrAbove < this.concurrency - (this.anyQueuedBelow(p) ? 1 : 0);',
    replace: 'return atOrAbove < this.concurrency;',
    killedBy: 'Test 13 (freed slot goes to the queued sweep item)'
  },
  {
    name: 'workPool: speculative fair-share removed (class can hog every spec slot)',
    file: 'src/workPool.ts',
    suite: 'src/test/workPool.test.ts',
    find: 'if (best === -1 || this.activeByPrio[q] < this.activeByPrio[best]) best = q;',
    replace: 'if (best === -1) best = q;',
    killedBy: 'Test 15 (freed spec slot goes to the waiting class)'
  },

  // ── Watcher logic: the suite imports the real source ──
  {
    name: 'watcher: ambiguous-multi-delete guard flipped to guess',
    file: 'src/watcherLogic.ts',
    suite: 'src/test/watcherLogic.test.ts',
    find: 'if (sameDir.length > 1) return -1;',
    replace: 'if (sameDir.length > 1) return sameDir[0].i;',
    killedBy: 'Test 2 (two same-dir deletes are ambiguous -> no match)'
  },
  {
    name: 'watcher: caller-ordered modality insertion comparator flipped',
    file: 'src/watcherLogic.ts',
    suite: 'src/test/watcherLogic.test.ts',
    find: 'if (r === -1 || r > rank) return i;',
    replace: 'if (r === -1 || r < rank) return i;',
    killedBy: 'Test 12/13 (mode-2 re-add lands at the caller-ordered position)'
  },
  {
    name: 'thumbPack: uuid pairing check removed (torn pack/idx combo served)',
    file: 'src/thumbPack.ts',
    suite: 'src/test/thumbPack.test.ts',
    find: 'if (pack.length < header.length || !pack.subarray(0, header.length).equals(header)) return null;',
    replace: 'if (pack.length < header.length) return null;',
    killedBy: 'Test 3 (uuid mismatch, same-size packs)'
  },
  {
    name: 'thumbPack: offset bounds check weakened',
    file: 'src/thumbPack.ts',
    suite: 'src/test/thumbPack.test.ts',
    find: 'if (o < header.length || l < 0 || o + l > pack.length || out.has(e.k)) return null;',
    replace: 'if (l < 0 || out.has(e.k)) return null;',
    killedBy: 'Test 5/6 (overflowing and header-pointing entries rejected)'
  },
  {
    name: 'modalityVisibility: hidden pills no longer skipped by cycling',
    file: 'src/webview/modalityVisibility.ts',
    suite: 'src/test/modalityVisibility.test.ts',
    find: 'if (!hidden[i]) return i;',
    replace: 'return i;',
    killedBy: 'Test 2/3 (hidden neighbours are skipped)'
  },
  {
    name: 'watcher: sorted row insertion degraded to append',
    file: 'src/watcherLogic.ts',
    suite: 'src/test/watcherLogic.test.ts',
    find: 'if (naturalCompare(name, existingNames[i]) < 0) return i;',
    replace: 'if (false) return i;',
    killedBy: 'Test 18/19 (crop row lands after its parent, natural-ordered)'
  },

  // ── Session files: the suite imports the real source ──
  {
    name: 'sessionFile: duplicate-label rejection removed',
    file: 'src/sessionFile.ts',
    suite: 'src/test/sessionFile.test.ts',
    find: 'if (new Set(labels).size !== labels.length) {',
    replace: 'if (false) {',
    killedBy: 'Test 6 (duplicate labels must throw "unique" — a modality name is the downstream join key)'
  },
  {
    name: 'sessionFile: relative paths resolved against cwd instead of the session dir',
    file: 'src/sessionFile.ts',
    suite: 'src/test/sessionFile.test.ts',
    find: 'const paths = rawPaths.map((p) => path.resolve(baseDir, p));',
    replace: 'const paths = rawPaths.map((p) => path.resolve(p));',
    killedBy: 'Test 2 (relative paths resolve against the session file dir, not cwd)'
  }
];

// Restore-on-interrupt: track the file currently mutated so a signal cannot leave it dirty.
let inFlight = null; // { path, original: Buffer }
function restoreInFlight() {
  if (inFlight) {
    writeFileSync(inFlight.path, inFlight.original);
    inFlight = null;
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreInFlight();
    process.exit(130);
  });
}

function runSuite(suite) {
  return spawnSync('npx', ['ts-node', suite], { cwd: repoRoot, encoding: 'utf8' });
}

function fail(msg, res) {
  console.error(`\n${msg}`);
  if (res) {
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
  }
}

// ── Baseline: every referenced suite must be green before we trust a kill ──
const suites = [...new Set(mutations.map((m) => m.suite))];
console.log('Baseline (no mutation) — every suite must be green:');
let baselineGreen = true;
for (const suite of suites) {
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
for (const m of mutations) {
  const path = join(repoRoot, m.file);
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
  let res;
  try {
    writeFileSync(path, mutated);
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
const killed = mutations.length - survivors.length - harnessErrors.length;
console.log(`Mutations: ${mutations.length}  killed: ${killed}  survived: ${survivors.length}  errors: ${harnessErrors.length}`);
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
if (survivors.length || harnessErrors.length) {
  process.exit(1);
}
console.log('\nAll mutations killed. The suites pin the rules they claim to.');
