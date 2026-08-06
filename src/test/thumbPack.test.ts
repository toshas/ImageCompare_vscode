/**
 * Tests for the thumbnail packfile wire format. Imports the real implementation
 * (thumbPack.ts has no vscode dependency).
 *
 * Run: npx ts-node src/test/thumbPack.test.ts
 */

import { buildPack, parsePack, PACK_MAGIC } from '../thumbPack';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';

const entries = [
  { key: 'aaaa', bytes: Buffer.from('first-blob') },
  { key: 'bbbb', bytes: Buffer.from('second, longer blob \x00\x01\xff', 'binary') },
  { key: 'cccc', bytes: Buffer.alloc(0) }
];

console.log('Test 1: round-trip — every key comes back byte-identical');
{
  const { pack, idx } = buildPack(U1, entries);
  const map = parsePack(idx, pack);
  assert(map !== null, 'a self-consistent pack parses');
  assert(map!.size === 3, `all entries present: ${map!.size}`);
  for (const e of entries) {
    assert(map!.get(e.key)!.equals(e.bytes), `bytes for ${e.key} survive the round-trip`);
  }
}

console.log('Test 2: empty pack round-trips');
{
  const { pack, idx } = buildPack(U1, []);
  const map = parsePack(idx, pack);
  assert(map !== null && map.size === 0, 'zero entries is a valid pack');
}

console.log('Test 3: uuid mismatch between idx and pack is rejected (same sizes, so only the pairing check can catch it)');
{
  const a = buildPack(U1, entries);
  const b = buildPack(U2, entries);
  assert(a.pack.length === b.pack.length, 'fixture premise: both packs are the same size');
  assert(parsePack(a.idx, b.pack) === null, 'idx of one snapshot must not read another snapshot\'s pack');
}

console.log('Test 4: truncated pack is rejected');
{
  const { pack, idx } = buildPack(U1, entries);
  assert(parsePack(idx, pack.subarray(0, pack.length - 1)) === null, 'a short pack must not parse');
}

console.log('Test 5: an entry pointing past the pack is rejected');
{
  const { pack, idx } = buildPack(U1, entries);
  const parsed = JSON.parse(idx);
  parsed.entries[1].l += 1000;
  assert(parsePack(JSON.stringify(parsed), pack) === null, 'an overflowing offset must not parse');
}

console.log('Test 6: an entry pointing into the header is rejected');
{
  const { pack, idx } = buildPack(U1, entries);
  const parsed = JSON.parse(idx);
  parsed.entries[0].o = 0;
  assert(parsePack(JSON.stringify(parsed), pack) === null, 'header bytes are not blob bytes');
}

console.log('Test 7: duplicate keys are rejected');
{
  const { pack, idx } = buildPack(U1, entries);
  const parsed = JSON.parse(idx);
  parsed.entries[1].k = parsed.entries[0].k;
  assert(parsePack(JSON.stringify(parsed), pack) === null, 'a key must map to exactly one blob');
}

console.log('Test 8: garbage idx is rejected, not thrown');
{
  const { pack } = buildPack(U1, entries);
  assert(parsePack('not json at all', pack) === null, 'unparseable idx returns null');
  assert(parsePack(JSON.stringify({ magic: 'WRONG', uuid: U1, size: pack.length, entries: [] }), pack) === null, 'wrong magic returns null');
}

console.log('Test 9: the header carries the magic');
{
  const { pack } = buildPack(U1, []);
  assert(pack.subarray(0, PACK_MAGIC.length).toString('utf8') === PACK_MAGIC, 'pack starts with the magic');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
