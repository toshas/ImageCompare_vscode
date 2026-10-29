/** The sharing script's node IO: the filesystem, and sharp for strip thumbnails only — comparison images are copied, never decoded (docs/standalone.md: pack-refuses-never-alters). */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { EntryKind, ShareIo } from './sharePlan';

async function kindOf(p: string): Promise<EntryKind> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

export const nodeShareIo: ShareIo = {
  kind: kindOf,
  list: async dir => Promise.all((await readdir(dir)).map(async name => ({ name, kind: await kindOf(join(dir, name)) }))),
  readText: p => readFile(p, 'utf8'),
  size: async p => (await stat(p)).size,
  thumbnail: async (source, maxSide, mime, jpegQuality) => {
    try {
      // The bytes, never the path: on Windows libvips can keep a path-opened file locked (docs/testing.md, Findings).
      const resized = sharp(await readFile(source)).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
      const encoded = mime === 'image/png' ? resized.png() : resized.jpeg({ quality: jpegQuality });
      return new Uint8Array(await encoded.toBuffer());
    } catch {
      return null;
    }
  },
  mkdirp: async dir => { await mkdir(dir, { recursive: true }); },
  copyFile: (from, to) => copyFile(from, to),
  writeFile: (p, content) => writeFile(p, content),
  removeTree: p => rm(p, { recursive: true, force: true }),
};

export const nodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
