/** PPMX: magic "PPMX" or "P7", "width height", an optional flags line, then width*height LE float32. See docs/image-backends.md. */

export interface PpmxData {
  width: number;
  height: number;
  rgbBuffer: Buffer;
}

/** Parse a PPMX file into a headerless RGB buffer, min/max normalized to 0-255. */
export function parsePpmx(buffer: Buffer): PpmxData {
  let pos = 0;
  const readLine = (): string => {
    let lineEnd = pos;
    while (lineEnd < buffer.length && buffer[lineEnd] !== 10) {
      lineEnd++;
    }
    const line = buffer.slice(pos, lineEnd).toString('utf8').trim();
    pos = lineEnd + 1;
    return line;
  };

  const header = readLine();

  if (header !== 'PPMX' && header !== 'P7') {
    throw new Error(`Unexpected PPMX header: "${header}", expected "PPMX" or "P7"`);
  }

  const dims = readLine();
  const dimParts = dims.split(/\s+/);
  const width = parseInt(dimParts[0], 10);
  const height = parseInt(dimParts[1], 10);

  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid PPMX dimensions: "${dims}"`);
  }

  const expectedBytes = width * height * 4;

  // The flags line is optional under either magic, so detect it by size rather than by variant.
  if (buffer.length - pos !== expectedBytes) {
    const afterDims = pos;
    const flags = readLine();
    // Size alone would accept an empty "line" that is really a 0x0A pixel byte (docs/image-backends.md).
    const looksLikeFlags = flags.length > 0 && /^[\x20-\x7e]+$/.test(flags);
    if (looksLikeFlags && buffer.length - pos === expectedBytes) {
      if (flags !== '00000000000') {
        console.warn(`Unknown PPMX flags: "${flags}"`);
      }
    } else {
      pos = afterDims;
    }
  }

  const dataBuffer = buffer.slice(pos);

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
