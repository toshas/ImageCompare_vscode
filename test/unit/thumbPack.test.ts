import { describe, it, expect } from 'vitest';
import { buildPack, parsePack, PACK_MAGIC } from '../../src/thumbPack';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';

const entries = [
  { key: 'aaaa', bytes: Buffer.from('first-blob') },
  { key: 'bbbb', bytes: Buffer.from('second, longer blob \x00\x01\xff', 'binary') },
  { key: 'cccc', bytes: Buffer.alloc(0) }
];

describe('thumbnail packfile wire format (real thumbPack code)', () => {
  it('Test 1: round-trip — every key comes back byte-identical', () => {
    const { pack, idx } = buildPack(U1, entries);
    const map = parsePack(idx, pack);
    expect(map, 'a self-consistent pack parses').not.toBeNull();
    expect(map!.size, `all entries present: ${map!.size}`).toBe(3);
    for (const e of entries) {
      expect(map!.get(e.key)!.equals(e.bytes), `bytes for ${e.key} survive the round-trip`).toBe(true);
    }
  });

  it('Test 2: empty pack round-trips', () => {
    const { pack, idx } = buildPack(U1, []);
    const map = parsePack(idx, pack);
    expect(map !== null && map.size === 0, 'zero entries is a valid pack').toBe(true);
  });

  it('Test 3: uuid mismatch between idx and pack is rejected (same sizes, so only the pairing check can catch it)', () => {
    const a = buildPack(U1, entries);
    const b = buildPack(U2, entries);
    expect(a.pack.length, 'fixture premise: both packs are the same size').toBe(b.pack.length);
    expect(parsePack(a.idx, b.pack), 'idx of one snapshot must not read another snapshot\'s pack').toBeNull();
  });

  it('Test 4: truncated pack is rejected', () => {
    const { pack, idx } = buildPack(U1, entries);
    expect(parsePack(idx, pack.subarray(0, pack.length - 1)), 'a short pack must not parse').toBeNull();
  });

  it('Test 5: an entry pointing past the pack is rejected', () => {
    const { pack, idx } = buildPack(U1, entries);
    const parsed = JSON.parse(idx);
    parsed.entries[1].l += 1000;
    expect(parsePack(JSON.stringify(parsed), pack), 'an overflowing offset must not parse').toBeNull();
  });

  it('Test 6: an entry pointing into the header is rejected', () => {
    const { pack, idx } = buildPack(U1, entries);
    const parsed = JSON.parse(idx);
    parsed.entries[0].o = 0;
    expect(parsePack(JSON.stringify(parsed), pack), 'header bytes are not blob bytes').toBeNull();
  });

  it('Test 7: duplicate keys are rejected', () => {
    const { pack, idx } = buildPack(U1, entries);
    const parsed = JSON.parse(idx);
    parsed.entries[1].k = parsed.entries[0].k;
    expect(parsePack(JSON.stringify(parsed), pack), 'a key must map to exactly one blob').toBeNull();
  });

  it('Test 8: garbage idx is rejected, not thrown', () => {
    const { pack } = buildPack(U1, entries);
    expect(parsePack('not json at all', pack), 'unparseable idx returns null').toBeNull();
    expect(parsePack(JSON.stringify({ magic: 'WRONG', uuid: U1, size: pack.length, entries: [] }), pack), 'wrong magic returns null').toBeNull();
  });

  it('Test 9: the header carries the magic', () => {
    const { pack } = buildPack(U1, []);
    expect(pack.subarray(0, PACK_MAGIC.length).toString('utf8'), 'pack starts with the magic').toBe(PACK_MAGIC);
  });
});
