/**
 * Parser for PPMX format (custom float32 grayscale format)
 *
 * Format:
 * - Line 1: "P7" (magic header)
 * - Line 2: "width height" (dimensions)
 * - Line 3: flags (e.g., "00000000000")
 * - Binary data: width*height float32 values (little-endian)
 */

export interface PpmxData {
  width: number;
  height: number;
  rgbBuffer: Buffer;
}

/**
 * Parse a PPMX file and return grayscale image data as RGB buffer
 */
export function parsePpmx(buffer: Buffer): PpmxData {
  let pos = 0;
  const lines: string[] = [];

  for (let i = 0; i < 3; i++) {
    let lineEnd = pos;
    while (lineEnd < buffer.length && buffer[lineEnd] !== 10) {
      lineEnd++;
    }
    lines.push(buffer.slice(pos, lineEnd).toString('utf8').trim());
    pos = lineEnd + 1;
  }

  const [header, dims, flags] = lines;

  if (header !== 'P7') {
    throw new Error(`Unexpected PPMX header: "${header}", expected "P7"`);
  }

  const dimParts = dims.split(/\s+/);
  const width = parseInt(dimParts[0], 10);
  const height = parseInt(dimParts[1], 10);

  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid PPMX dimensions: "${dims}"`);
  }

  const KNOWN_FLAGS = new Set(['00000000000']);
  if (!KNOWN_FLAGS.has(flags)) {
    console.warn(`Unknown PPMX flags: "${flags}"`);
  }

  const dataBuffer = buffer.slice(pos);
  const expectedBytes = width * height * 4;

  if (dataBuffer.length < expectedBytes) {
    throw new Error(`PPMX data size mismatch: expected ${expectedBytes} bytes, got ${dataBuffer.length}`);
  }

  const floatData = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    floatData[i] = dataBuffer.readFloatLE(i * 4);
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of floatData) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const rgbBuffer = Buffer.alloc(width * height * 3);
  const range = max - min || 1;

  for (let i = 0; i < floatData.length; i++) {
    const v = floatData[i];
    const normalized = Number.isFinite(v) ? (v - min) / range : 0;
    const gray = Math.round(normalized * 255);
    const pi = i * 3;
    rgbBuffer[pi] = gray;
    rgbBuffer[pi + 1] = gray;
    rgbBuffer[pi + 2] = gray;
  }

  return { width, height, rgbBuffer };
}
