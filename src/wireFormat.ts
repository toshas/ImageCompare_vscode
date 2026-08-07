/** Pure (no vscode): the extension→webview image payload contract — see docs/loading-architecture.md. */

/** The wire accepts exactly a tight, plain Uint8Array: a subclass (Buffer) risks the serializer JSON-mangling it, an offset view ships its whole backing allocation (docs/loading-architecture.md: image-payload-normalized). */
export function normalizeImageBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor === Uint8Array && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes;
  }
  // new Uint8Array(view) copies exactly the view's range into a fresh, tight, plain-constructor array.
  return new Uint8Array(bytes);
}
