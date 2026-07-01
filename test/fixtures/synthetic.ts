/**
 * Synthetic, deterministic test assets shared across all test layers.
 *
 * Everything here is procedurally generated (no photos) so that byte output —
 * and therefore visual-regression screenshots — is stable across runs.
 */

/**
 * Build a valid PPMX buffer (P7 float32 grayscale format).
 * Values are laid out row-major, little-endian float32.
 */
export function makePpmx(width: number, height: number, fill: (x: number, y: number) => number): Buffer {
  const header = Buffer.from(`P7\n${width} ${height}\n00000000000\n`, 'utf8');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.writeFloatLE(fill(x, y), (y * width + x) * 4);
    }
  }
  return Buffer.concat([header, data]);
}

/**
 * Build a minimal valid PNG of a solid RGB color, with no compression
 * (stored zlib blocks). Pure JS so tests need no image library.
 */
export function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = buildCrcTable();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crc]);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines: filter byte 0 + width*3 color bytes per row.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const idat = zlibStore(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** zlib "stored" (uncompressed) wrapper around raw bytes. */
function zlibStore(raw: Buffer): Buffer {
  const blocks: Buffer[] = [];
  const MAX = 65535;
  let offset = 0;
  while (offset < raw.length) {
    const len = Math.min(MAX, raw.length - offset);
    const isLast = offset + len >= raw.length;
    const header = Buffer.alloc(5);
    header[0] = isLast ? 1 : 0;
    header.writeUInt16LE(len, 1);
    header.writeUInt16LE(~len & 0xffff, 3);
    blocks.push(header, raw.subarray(offset, offset + len));
    offset += len;
  }
  const adler = adler32(raw);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler, 0);
  return Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adlerBuf]);
}

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}
