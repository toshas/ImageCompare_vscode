/**
 * Headers here are byte-for-byte what real producers emit — the parser once
 * required the "P7" magic and a flags line, and rejected every real file.
 * Both magics and the optional flags line are one format. See docs/image-backends.md.
 */
import { describe, it, expect } from 'vitest';
import { parsePpmx } from '../../src/ppmxParser';

function floats(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}

function ppmx(w: number, h: number, values: number[], opts: { magic?: string; flags?: string } = {}): Buffer {
  const magic = opts.magic ?? 'PPMX';
  const flagLine = opts.flags === undefined ? '' : `${opts.flags}\n`;
  return Buffer.concat([Buffer.from(`${magic}\n${w} ${h}\n${flagLine}`, 'ascii'), floats(values)]);
}

describe('PPMX parser (real ppmxParser code)', () => {
  it('Test 1: every magic x flags combination is the same format', () => {
    for (const magic of ['PPMX', 'P7']) {
      for (const flags of [undefined, '00000000000']) {
        const label = `${magic}, flags=${flags ?? 'absent'}`;
        const r = parsePpmx(ppmx(2, 2, [0, 1, 2, 3], { magic, flags }));
        expect(r.width === 2 && r.height === 2, `${label}: dimensions parsed`).toBe(true);
        expect(r.rgbBuffer.length, `${label}: RGB buffer is w*h*3`).toBe(2 * 2 * 3);
        expect(r.rgbBuffer[0] === 0 && r.rgbBuffer[11] === 255, `${label}: data starts at the right offset`).toBe(true);
      }
    }
  });

  it('Test 2: an unknown flags value still parses (warns only)', () => {
    const r = parsePpmx(ppmx(2, 2, [0, 1, 2, 3], { flags: '00000000001' }));
    expect(r.width === 2 && r.height === 2, 'unknown flags do not reject the file').toBe(true);
    expect(r.rgbBuffer[0] === 0 && r.rgbBuffer[11] === 255, 'flags line still consumed').toBe(true);
  });

  it('Test 3: variable-length headers (13b and 15b) consume exactly', () => {
    // Markers at the first and last pixel: any off-by-one in the header offset shifts every
    // float, so neither marker lands on its expected byte and the greys change.
    const marked = (n: number): number[] => {
      const v = new Array(n).fill(0);
      v[0] = 5;      // min 0, max 10 -> this renders as mid grey
      v[n - 1] = 10; // -> 255
      return v;
    };

    for (const [dim, headerLen] of [[512, 13], [1024, 15]] as Array<[number, number]>) {
      const n = dim * dim;
      const buf = ppmx(dim, dim, marked(n));
      const label = `${dim}x${dim} (${headerLen}-byte header)`;
      expect(buf.length, `${label}: fixture header really is ${headerLen} bytes`).toBe(headerLen + n * 4);
      const r = parsePpmx(buf);
      expect(r.width === dim && r.height === dim, `${label}: dimensions parsed`).toBe(true);
      expect(r.rgbBuffer.length, `${label}: RGB buffer is w*h*3`).toBe(n * 3);
      expect(r.rgbBuffer[0], `${label}: first pixel starts exactly at byte ${headerLen}`).toBe(128);
      expect(r.rgbBuffer[(n - 1) * 3], `${label}: last pixel consumed exactly, no slack`).toBe(255);
    }
  });

  it('Test 4: min/max normalization spans 0-255', () => {
    const r = parsePpmx(ppmx(2, 2, [10, 20, 30, 40]));
    expect(r.rgbBuffer[0], 'min maps to 0').toBe(0);
    expect(r.rgbBuffer[9], 'max maps to 255').toBe(255);
    expect(r.rgbBuffer[3], 'mid maps proportionally').toBe(85);
  });

  it('Test 5: grayscale — R, G and B are equal per pixel', () => {
    const r = parsePpmx(ppmx(2, 1, [0, 7]));
    expect(r.rgbBuffer[3] === r.rgbBuffer[4] && r.rgbBuffer[4] === r.rgbBuffer[5], 'channels equal').toBe(true);
  });

  it('Test 6: a constant image does not divide by zero', () => {
    const r = parsePpmx(ppmx(2, 1, [5, 5]));
    expect(r.rgbBuffer.every(v => v === 0), 'zero range yields a uniform image, no NaN').toBe(true);
  });

  it('Test 7: non-finite values are treated as 0 and ignored by min/max', () => {
    // If the NaN were folded into min/max as 0, min would be 0 and 4 would render as 85, not 0.
    const r = parsePpmx(ppmx(3, 1, [NaN, 4, 12]));
    expect(r.rgbBuffer[0], 'NaN pixel renders as 0').toBe(0);
    expect(r.rgbBuffer[3], 'min is 4 (not the NaN read as 0), so 4 renders as 0').toBe(0);
    expect(r.rgbBuffer[6], 'max is 12 and renders as 255').toBe(255);
  });

  it('Test 8: an unknown magic is rejected, naming both accepted forms', () => {
    let msg = '';
    try {
      parsePpmx(Buffer.from('P6\n2 2\n\x00\x00\x00\x00', 'ascii'));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.includes('P6'), 'error quotes the offending magic').toBe(true);
    expect(msg.includes('PPMX') && msg.includes('P7'), 'error names both accepted magics').toBe(true);
  });

  it('Test 8b: flags are detected by size, not by sniffing for a newline in the data', () => {
    // writeFloatLE(1.4e-44) is 0a 00 00 00 — pixel data whose first byte IS a \n. (1.4e-42 is
    // e7 03 00 00 and contains no 0x0A at all, so it probes nothing.) Anything that decides
    // "is there a flags line?" by looking for a newline eats that byte as an empty flags line.
    const NEWLINE_PIXEL = 1.4e-44;

    // No flags line: header 9b + data 8b, so buffer.length - pos === expectedBytes and the probe
    // must not be entered. A content-sniffing probe consumes the 0x0A and the data runs 1 byte short.
    const bare = ppmx(2, 1, [NEWLINE_PIXEL, 1]);
    expect(bare.length, 'fixture: no flags line, so the size already matches exactly').toBe(9 + 8);
    expect(bare[9], 'fixture: the first pixel byte is a newline').toBe(0x0A);
    const r = parsePpmx(bare);
    expect(r.width === 2 && r.height === 1, 'dimensions intact').toBe(true);
    expect(r.rgbBuffer[0] === 0 && r.rgbBuffer[3] === 255, 'the newline byte is kept as pixel data').toBe(true);

    // Flags line present: header 9b + flags 12b + data 8b, so the byte count forces the probe in.
    // It must consume the flags line exactly — no more, no less — leaving the 0x0A pixel intact.
    const flagged = ppmx(2, 1, [NEWLINE_PIXEL, 1], { flags: '00000000000' });
    expect(flagged.length - 9 !== 8, 'fixture: the size mismatch forces the flags probe to run').toBe(true);
    expect(flagged[21], 'fixture: the first pixel byte after the flags line is a newline').toBe(0x0A);
    const rf = parsePpmx(flagged);
    expect(rf.width === 2 && rf.height === 1, 'dimensions intact behind a flags line').toBe(true);
    expect(rf.rgbBuffer[0] === 0 && rf.rgbBuffer[3] === 255, 'the probe stops at the flags newline').toBe(true);
  });

  it('Test 9: malformed dimensions are rejected', () => {
    let threw = false;
    try {
      parsePpmx(Buffer.concat([Buffer.from('PPMX\nnope\n', 'ascii'), floats([1])]));
    } catch {
      threw = true;
    }
    expect(threw, 'non-numeric dimensions throw').toBe(true);
  });

  it('Test 10: truncated data is rejected rather than silently padded', () => {
    let threw = false;
    try {
      parsePpmx(ppmx(4, 4, [1, 2, 3]));
    } catch {
      threw = true;
    }
    expect(threw, 'short data buffer throws').toBe(true);
  });

  it('Test 11: a 0x0A first pixel plus a trailing byte is not mistaken for a flags line', () => {
    // No flags line; first pixel is 0x0000000A and one byte trails (a producer padding EOF). The size
    // mismatch enters the probe, where an empty "line" would eat the pixel's 0x0A and make the count
    // match at a 1-byte offset. Only the "flags must be non-empty printable" guard rejects that.
    // Three pixels, not two: a shift still yields min=0/max=255 at the ends, so only a MIDDLE value
    // distinguishes a correct parse from a shifted one.
    const body = Buffer.concat([floats([1.4e-44, 1.5, 3]), Buffer.from([0x0a])]);
    const r = parsePpmx(Buffer.concat([Buffer.from('PPMX\n3 1\n', 'ascii'), body]));
    expect(r.width === 3 && r.height === 1, 'dimensions intact').toBe(true);
    expect(r.rgbBuffer[0], 'first pixel is the min').toBe(0);
    expect(r.rgbBuffer[3], 'middle pixel is 1.5 of 3 — data was not shifted by one byte').toBe(128);
    expect(r.rgbBuffer[6], 'last pixel is the max').toBe(255);
  });
});
