/** Pure (no vscode): the thumbnail packfile wire format — see docs/image-backends.md. */

export const PACK_MAGIC = 'ICTHUMBPACK1';

export interface PackEntry {
  key: string;
  bytes: Buffer;
}

/** One header line carrying the uuid, then the blobs back to back; the idx JSON repeats the uuid and maps key -> offset/length. */
export function buildPack(uuid: string, entries: ReadonlyArray<PackEntry>): { pack: Buffer; idx: string } {
  const header = Buffer.from(`${PACK_MAGIC} ${uuid}\n`, 'utf8');
  const chunks: Buffer[] = [header];
  const idxEntries: Array<{ k: string; o: number; l: number }> = [];
  let offset = header.length;
  for (const e of entries) {
    idxEntries.push({ k: e.key, o: offset, l: e.bytes.length });
    chunks.push(e.bytes);
    offset += e.bytes.length;
  }
  return {
    pack: Buffer.concat(chunks),
    idx: JSON.stringify({ magic: PACK_MAGIC, uuid, size: offset, entries: idxEntries })
  };
}

/** Returns null on ANY inconsistency: a discarded pack costs a re-read; a wrongly served blob costs a wrong thumbnail. */
export function parsePack(idxJson: string, pack: Buffer): Map<string, Buffer> | null {
  let idx: { magic?: unknown; uuid?: unknown; size?: unknown; entries?: unknown };
  try {
    idx = JSON.parse(idxJson);
  } catch {
    return null;
  }
  if (!idx || idx.magic !== PACK_MAGIC || typeof idx.uuid !== 'string' || !Array.isArray(idx.entries)) return null;
  if (idx.size !== pack.length) return null;
  const header = Buffer.from(`${PACK_MAGIC} ${idx.uuid}\n`, 'utf8');
  // The uuid pairing: idx and pack are written as a pair, so a torn combination must never serve bytes (docs/image-backends.md: thumb-pack-atomic).
  if (pack.length < header.length || !pack.subarray(0, header.length).equals(header)) return null;
  const out = new Map<string, Buffer>();
  for (const e of idx.entries as Array<{ k?: unknown; o?: unknown; l?: unknown }>) {
    if (typeof e.k !== 'string' || !Number.isInteger(e.o) || !Number.isInteger(e.l)) return null;
    const o = e.o as number;
    const l = e.l as number;
    if (o < header.length || l < 0 || o + l > pack.length || out.has(e.k)) return null;
    // subarray shares the pack's memory: 26k entries cost one buffer, not 26k copies.
    out.set(e.k, pack.subarray(o, o + l));
  }
  return out;
}
