/**
 * Tests for PNG tEXt chunk injection and reading.
 * Verifies the crop metadata round-trip works for the Jimp fallback path.
 *
 * Run: npx ts-node src/test/pngTextChunk.test.ts
 */

import * as zlib from 'zlib';

// ── Copies of the functions under test (same as thumbnailService.ts) ──────

function pngInjectText(png: Buffer, keyword: string, value: string): Buffer {
  const keyBuf = Buffer.from(keyword, 'latin1');
  const valBuf = Buffer.from(value, 'latin1');
  const data = Buffer.concat([keyBuf, Buffer.from([0]), valBuf]);
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'ascii'), data]);
  const crc = zlib.crc32(typeAndData);

  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc >>> 0, 8 + data.length);

  // Scan for IEND chunk and insert before it
  let iendOffset = png.length - 12; // fallback
  let offset = 8;
  while (offset + 8 <= png.length) {
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IEND') { iendOffset = offset; break; }
    offset += 12 + png.readUInt32BE(offset);
  }
  return Buffer.concat([png.subarray(0, iendOffset), chunk, png.subarray(iendOffset)]);
}

function pngReadText(png: Buffer, keyword: string): string | null {
  let offset = 8;
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'tEXt' && offset + 12 + len <= png.length) {
      const data = png.subarray(offset + 8, offset + 8 + len);
      const nullIdx = data.indexOf(0);
      if (nullIdx >= 0) {
        const key = data.subarray(0, nullIdx).toString('latin1');
        if (key === keyword) {
          return data.subarray(nullIdx + 1).toString('latin1');
        }
      }
    }
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  return null;
}

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

  printResults();
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
