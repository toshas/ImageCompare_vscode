/**
 * Tests for PNG tEXt chunk injection and reading — the real shipped code in ../pngText,
 * which thumbnailService.ts imports. Verifies the crop metadata round-trip works for the
 * Jimp fallback path.
 *
 * Run: npx ts-node src/test/pngTextChunk.test.ts
 */

import { crc32, pngInjectText, pngReadText } from '../pngText';

// ── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function printResults() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed!');
}

// ── Tests (all async, need a proper PNG from Sharp) ───────────────────────

async function runTests() {
  // Create a valid 4x4 red PNG using Sharp
  const sharp = require('sharp');
  const testPng: Buffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } }
  }).png().toBuffer();

  console.log(`Test PNG: ${testPng.length} bytes`);

  // Test 1: Basic round-trip
  {
    console.log('\nTest 1: Basic inject + read round-trip');
    const keyword = 'TestKey';
    const value = 'hello,world,123';
    const injected = pngInjectText(testPng, keyword, value);
    const result = pngReadText(injected, keyword);
    assert(result === value, `Expected "${value}", got "${result}"`);
    assert(injected.length > testPng.length, `Injected should be larger: ${injected.length} > ${testPng.length}`);
  }

  // Test 2: Crop metadata format
  {
    console.log('\nTest 2: Crop metadata format round-trip');
    const keyword = 'ImageCompare:CropRect';
    const cropMeta = '100,200,300,400,1920,1080';
    const injected = pngInjectText(testPng, keyword, cropMeta);
    const result = pngReadText(injected, keyword);
    assert(result === cropMeta, `Expected "${cropMeta}", got "${result}"`);

    if (result) {
      const parts = result.split(',').map(Number);
      assert(parts.length === 6, `Expected 6 parts, got ${parts.length}`);
      assert(parts[0] === 100, `x=${parts[0]}`);
      assert(parts[1] === 200, `y=${parts[1]}`);
      assert(parts[2] === 300, `w=${parts[2]}`);
      assert(parts[3] === 400, `h=${parts[3]}`);
      assert(parts[4] === 1920, `srcW=${parts[4]}`);
      assert(parts[5] === 1080, `srcH=${parts[5]}`);
    }
  }

  // Test 3: Missing keyword
  {
    console.log('\nTest 3: Read missing keyword returns null');
    const result = pngReadText(testPng, 'NonExistent');
    assert(result === null, `Expected null, got "${result}"`);
  }

  // Test 4: Wrong keyword
  {
    console.log('\nTest 4: Read wrong keyword from injected PNG');
    const injected = pngInjectText(testPng, 'KeyA', 'valueA');
    const result = pngReadText(injected, 'KeyB');
    assert(result === null, `Expected null for wrong keyword, got "${result}"`);
  }

  // Test 5: Multiple chunks
  {
    console.log('\nTest 5: Multiple tEXt chunks, read each independently');
    let png = pngInjectText(testPng, 'First', 'one');
    png = pngInjectText(png, 'Second', 'two');
    assert(pngReadText(png, 'First') === 'one', `First should be "one"`);
    assert(pngReadText(png, 'Second') === 'two', `Second should be "two"`);
  }

  // Test 6: PNG structure preserved
  {
    console.log('\nTest 6: PNG structure preserved after injection');
    const injected = pngInjectText(testPng, 'Test', 'data');
    assert(injected[0] === 0x89, 'Byte 0 should be 0x89');
    assert(injected.subarray(1, 4).toString('ascii') === 'PNG', 'Bytes 1-3 should be "PNG"');
    // Find IEND
    let off = 8;
    let lastType = '';
    while (off + 8 <= injected.length) {
      lastType = injected.subarray(off + 4, off + 8).toString('ascii');
      if (lastType === 'IEND') break;
      off += 12 + injected.readUInt32BE(off);
    }
    assert(lastType === 'IEND', `Last chunk should be IEND, got "${lastType}"`);
  }

  // Test 7: Sharp can still read the modified PNG
  {
    console.log('\nTest 7: Sharp validates injected PNG');
    const injected = pngInjectText(testPng, 'ImageCompare:CropRect', '10,20,30,40,100,100');
    const meta = await sharp(injected).metadata();
    assert(meta.width === 4, `Width should be 4, got ${meta.width}`);
    assert(meta.height === 4, `Height should be 4, got ${meta.height}`);
    assert(meta.format === 'png', `Format should be png, got ${meta.format}`);
  }

  // Test 8: Large crop values
  {
    console.log('\nTest 8: Large coordinate values');
    const value = '9999,8888,7777,6666,15360,8640';
    const injected = pngInjectText(testPng, 'ImageCompare:CropRect', value);
    const result = pngReadText(injected, 'ImageCompare:CropRect');
    assert(result === value, `Expected "${value}", got "${result}"`);
  }

  // Test 9: CRC-32 pinned to the IEEE check value, not to our own (or zlib's) implementation
  {
    console.log('\nTest 9: CRC-32 matches the canonical IEEE check value');
    const check = crc32(Buffer.from('123456789', 'ascii'));
    assert(check === 0xcbf43926, `CRC-32("123456789") should be 0xCBF43926, got 0x${check.toString(16).toUpperCase()}`);
    assert(crc32(Buffer.alloc(0)) === 0, `CRC-32 of an empty buffer should be 0, got ${crc32(Buffer.alloc(0))}`);
    // "123456789" touches only 8 of the 256 table entries; these bytes touch all 256, so any single
    // corrupt entry moves the result. Expected value cross-checked against zlib.crc32 and a
    // table-free bitwise CRC-32 — pinned as a constant so neither is needed at run time.
    const fullTableProbe = Buffer.from(
      'fffe6be0d834aa3263bdabe8bf53cd5514aea85c16fa64fcad736526719d039bfa88ae3445a937affe20367522ce50c8' +
      '893335c18b67f96130eef8bbec009e0627c5a2e4e30f9109588690d38468f66e2f9593672dc15fc796485e1d4aa638a0' +
      'c1b3950f7e920c94c51b0d4e19f56bf3b2080efab05cc25a0bd5c380d73ba53d9c5eba44ae42dc4415cbdd9ec925bb23' +
      '62d8de2a608c128adb05135007eb75ed8cfed84233df41d98856400354b826beff4543b7fd118f1746988ecd9a76e870' +
      '51b3d4929579e77f2ef0e6a5f21e801859e3e5115bb729b1e03e286b3cd04ed6b7c5e37908e47ae2b36d7b386f831d85' +
      'c47e788cc62ab42c7da3b5f6a14dd34b',
      'hex'
    );
    const probe = crc32(fullTableProbe);
    assert(probe === 0xd2a7d615, `CRC-32 of the full-table probe should be 0xD2A7D615, got 0x${probe.toString(16).toUpperCase()}`);
    // The bytes a decoder checks: chunk CRC covers type+data and lands in the last 4 bytes of the chunk.
    const injected = pngInjectText(testPng, 'K', 'v');
    let off = 8;
    let found = false;
    while (off + 8 <= injected.length) {
      const len = injected.readUInt32BE(off);
      const type = injected.subarray(off + 4, off + 8).toString('ascii');
      if (type === 'tEXt') {
        const stored = injected.readUInt32BE(off + 8 + len);
        assert(stored === crc32(injected.subarray(off + 4, off + 8 + len)), `Stored tEXt CRC 0x${stored.toString(16)} disagrees with the chunk bytes`);
        found = true;
        break;
      }
      if (type === 'IEND') break;
      off += 12 + len;
    }
    assert(found, 'Injected PNG should contain a tEXt chunk');
  }

  printResults();
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
