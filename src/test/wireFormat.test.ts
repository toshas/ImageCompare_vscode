/**
 * Tests for the extension→webview image payload contract.
 * Imports the real implementation (wireFormat.ts has no vscode dependency).
 *
 * Run: npx ts-node src/test/wireFormat.test.ts
 */

import { normalizeImageBytes } from '../wireFormat';

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

console.log('Test 1: a Buffer is converted to a plain Uint8Array with identical bytes');
{
  // The exact production shape: Sharp/fs hand the provider Buffers, and Buffer is a Uint8Array
  // subclass whose species even survives Uint8Array.prototype.slice — the bug that shipped.
  const buf = Buffer.from([1, 2, 3, 4, 5]);
  const out = normalizeImageBytes(buf);
  assert(out.constructor === Uint8Array, `constructor must be Uint8Array, got ${out.constructor.name}`);
  assert(out !== buf, 'a Buffer must be copied, not passed through');
  assert(out.byteOffset === 0 && out.byteLength === out.buffer.byteLength, 'output must be tight');
  assert(Buffer.compare(Buffer.from(out), buf) === 0, 'bytes must be identical');
}

console.log('Test 2: an offset view is copied to exactly its range');
{
  const backing = new Uint8Array([9, 9, 7, 8, 9, 9]);
  const view = backing.subarray(2, 5);
  const out = normalizeImageBytes(view);
  assert(out !== view, 'a view must be copied');
  assert(out.byteLength === 3 && out.buffer.byteLength === 3, `copy must be tight to the range, got buffer ${out.buffer.byteLength}`);
  assert(out[0] === 7 && out[1] === 8 && out[2] === 9, 'copy must hold the view range only');
}

console.log('Test 3: an already-normal payload passes through without a copy');
{
  const plain = new Uint8Array([1, 2, 3]);
  assert(normalizeImageBytes(plain) === plain, 'a tight plain Uint8Array must be returned as-is');
}

console.log('Test 4: normalized payloads survive structuredClone as plain Uint8Array');
{
  // Pins the property the webview depends on: the payload is clonable binary, not a
  // JSON-mangled object ({type:"Buffer",data:[...]}).
  const out = normalizeImageBytes(Buffer.from([10, 20, 30]));
  const cloned = structuredClone(out);
  assert(cloned instanceof Uint8Array, `clone must stay a Uint8Array, got ${Object.prototype.toString.call(cloned)}`);
  assert(cloned.byteLength === 3 && cloned[1] === 20, 'clone must hold the same bytes');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
