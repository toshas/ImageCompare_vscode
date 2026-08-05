/** Pure (vscode-free, unit-testable) PNG tEXt reader/writer and the crop-metadata wire format — see docs/crop-and-pptx.md. */

/** Crop metadata decoded from a crop PNG: the rect plus the source dimensions it was measured against. */
export interface CropMeta {
  x: number;
  y: number;
  w: number;
  h: number;
  srcW: number;
  srcH: number;
}

/** tEXt keyword, and the EXIF ImageDescription prefix, carrying the crop rect. */
export const CROP_RECT_KEYWORD = 'ImageCompare:CropRect';

/** IEEE CRC-32 lookup table, built once — zlib.crc32 needs Node 20.15+, newer than our oldest supported VSCode. */
const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE, the PNG variety) of a buffer, as an unsigned 32-bit value. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Inject a PNG tEXt chunk (length + "tEXt" + keyword + \0 + value + CRC32) before IEND. */
export function pngInjectText(png: Buffer, keyword: string, value: string): Buffer {
  const keyBuf = Buffer.from(keyword, 'latin1');
  const valBuf = Buffer.from(value, 'latin1');
  const data = Buffer.concat([keyBuf, Buffer.from([0]), valBuf]);
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'ascii'), data]);
  const crc = crc32(typeAndData);

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

/** Read a PNG tEXt chunk value by keyword; null if not found. */
export function pngReadText(png: Buffer, keyword: string): string | null {
  let offset = 8; // skip the PNG signature

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
    offset += 12 + len; // 4 len + 4 type + data + 4 crc
  }
  return null;
}

/** Encode the crop rect: six ints, source-image pixels — a wire format an external tool also parses (docs/crop-and-pptx.md: croprect-six-integers). */
export function encodeCropMeta(
  rect: { x: number; y: number; w: number; h: number },
  sourceWidth: number,
  sourceHeight: number
): string {
  return `${rect.x},${rect.y},${rect.w},${rect.h},${sourceWidth},${sourceHeight}`;
}

/** Decode the `x,y,w,h,srcW,srcH` value written by encodeCropMeta; null if it is not that format (docs/crop-and-pptx.md: croprect-six-integers). */
export function parseCropMeta(value: string): CropMeta | null {
  const parts = value.split(',').map(Number);
  if (parts.length !== 6 || !parts.every(n => !isNaN(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3], srcW: parts[4], srcH: parts[5] };
}
