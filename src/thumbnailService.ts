import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { getSharp, getSharpError } from './sharpLoader';
import { parsePpmx } from './ppmxParser';
import { CROP_RECT_KEYWORD, CropMeta, encodeCropMeta, parseCropMeta, pngInjectText, pngReadText } from './pngText';
import { buildPack, parsePack } from './thumbPack';

/** Byte-capped, not entry-capped: `thumbnailSize` maxes at 200, so entries range 4x in size. Sized
 *  past a realistic session — a real cache of 26k thumbnails at ~4.3KB of raw JPEG each is ~110MB,
 *  and a cap that bites turns every revisit into a disk read on the mounts this extension exists to
 *  serve. The cap also bounds the packfile snapshot built from this cache. */
const MEMORY_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const PACK_SNAPSHOT_IDLE_MS = 30_000;

const toDataUrl = (bytes: Buffer): string => `data:image/jpeg;base64,${bytes.toString('base64')}`;

/** Generates and caches thumbnails via Sharp, falling back to Jimp. See docs/image-backends.md. */
export class ThumbnailService {
  private cacheDir: vscode.Uri;
  /** Raw JPEG bytes, base64-encoded per delivery: one representation feeds hits and the pack snapshot alike. */
  private memoryCache: Map<string, Buffer> = new Map();
  private memoryCacheBytes = 0;
  private packMap: Map<string, Buffer> | undefined;
  private packLoad: Promise<Map<string, Buffer>> | undefined;
  private packDirty = false;
  private packTimer: ReturnType<typeof setTimeout> | undefined;
  private packWriting = false;
  /** Lazily loaded Jimp constructor — only required when Sharp is unavailable. */
  private jimpModule: any = undefined;
  private jimpLoadAttempted = false;

  constructor(context: vscode.ExtensionContext) {
    this.cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'thumbnail-cache');
  }

  /** Create the cache directory, report the active backend, and sweep stale entries. */
  async initialize(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.cacheDir);
    } catch {
      // Directory may already exist
    }

    const sharp = getSharp();
    if (sharp) {
      console.log('[ImageCompare] Using Sharp for image processing.');
    } else {
      console.warn(
        '[ImageCompare] Sharp unavailable (' + (getSharpError() ?? 'unknown') + '). ' +
        'Falling back to Jimp (slower).'
      );
      vscode.window.showWarningMessage(
        'ImageCompare: Sharp could not be loaded — using Jimp fallback (slower thumbnail generation).'
      );
    }

    this.cleanupOldCache(); // deliberately not awaited
  }

  // ---------------------------------------------------------------------------
  // Backend helpers
  // ---------------------------------------------------------------------------

  /** Lazily require Jimp — never a static import, which would cost parse time on every activation (docs/image-backends.md: jimp-lazy-required). */
  private getJimp(): any {
    if (!this.jimpLoadAttempted) {
      this.jimpLoadAttempted = true;
      try {
        this.jimpModule = require('jimp').Jimp;
      } catch (e: any) {
        console.error('[ImageCompare] Jimp also failed to load:', e?.message);
        this.jimpModule = null;
      }
    }
    return this.jimpModule;
  }

  /** Create a Sharp instance, handling PPMX raw data. */
  private createSharpInstance(
    sharp: NonNullable<ReturnType<typeof getSharp>>,
    buffer: Buffer,
    ext: string
  ) {
    if (ext === '.ppmx') {
      const ppmx = parsePpmx(buffer);
      return sharp(ppmx.rgbBuffer, {
        raw: { width: ppmx.width, height: ppmx.height, channels: 3 }
      });
    }
    return sharp(buffer);
  }

  /** Create a Jimp instance, handling PPMX raw data. */
  private async createJimpImage(
    Jimp: any,
    buffer: Buffer,
    ext: string
  ): Promise<any> {
    if (ext === '.ppmx') {
      const ppmx = parsePpmx(buffer);
      const rgbaBuffer = Buffer.alloc(ppmx.width * ppmx.height * 4);
      for (let i = 0; i < ppmx.width * ppmx.height; i++) {
        rgbaBuffer[i * 4] = ppmx.rgbBuffer[i * 3];
        rgbaBuffer[i * 4 + 1] = ppmx.rgbBuffer[i * 3 + 1];
        rgbaBuffer[i * 4 + 2] = ppmx.rgbBuffer[i * 3 + 2];
        rgbaBuffer[i * 4 + 3] = 255;
      }
      return Jimp.fromBitmap({
        width: ppmx.width,
        height: ppmx.height,
        data: rgbaBuffer
      });
    }
    return Jimp.fromBuffer(buffer);
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------

  /** Keyed on size too: mtime never changes when the thumbnailSize setting does, so entries would otherwise stay at the old size forever. */
  private getCacheKey(uri: vscode.Uri, mtime: number, size: number): string {
    const hash = crypto.createHash('sha256');
    hash.update(uri.toString());
    hash.update(mtime.toString());
    hash.update(size.toString());
    return hash.digest('hex').substring(0, 16);
  }

  async getThumbnail(uri: vscode.Uri, size: number): Promise<string> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cacheKey = this.getCacheKey(uri, stat.mtime, size);

      const hit = this.memoryCache.get(cacheKey);
      if (hit !== undefined) {
        /* Re-insert so eviction is by recency — the rows a user scrolls back to are the oldest. */
        this.memoryCache.delete(cacheKey);
        this.memoryCache.set(cacheKey, hit);
        return toDataUrl(hit);
      }

      // One sequential read serves the whole warm open; per-entry files are the fallback (docs/image-backends.md).
      const packed = (await this.ensurePackLoaded()).get(cacheKey);
      if (packed !== undefined) {
        this.rememberInMemory(cacheKey, packed, false);
        return toDataUrl(packed);
      }

      const cachedBytes = await this.loadFromDiskCache(cacheKey);
      if (cachedBytes) {
        this.rememberInMemory(cacheKey, cachedBytes, true);
        return toDataUrl(cachedBytes);
      }

      const bytes = await this.generateThumbnail(uri, size);

      this.rememberInMemory(cacheKey, bytes, true);
      this.saveToDiskCache(cacheKey, bytes); // deliberately not awaited

      return toDataUrl(bytes);
    } catch (error) {
      console.error(`Failed to generate thumbnail for ${uri.toString()}:`, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Thumbnail generation
  // ---------------------------------------------------------------------------

  private async generateThumbnail(uri: vscode.Uri, size: number): Promise<Buffer> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    const sharp = getSharp();
    if (sharp) {
      const inst = this.createSharpInstance(sharp, buffer, ext);
      // Both backends must emit identical size and JPEG quality 70, or which one ran becomes user-visible (docs/image-backends.md: backends-agree-output).
      return inst
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 70 })
        .toBuffer();
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    // Must match the Sharp branch's size and quality 70 above (docs/image-backends.md: backends-agree-output).
    image.scaleToFit({ w: size, h: size });
    return image.getBuffer('image/jpeg', { quality: 70 });
  }

  // ---------------------------------------------------------------------------
  // Full image loading
  // ---------------------------------------------------------------------------

  async loadFullImage(uri: vscode.Uri): Promise<{ dataUrl: string; width: number; height: number }> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    // Browser-decodable formats pass through as original bytes (docs/image-backends.md: passthrough-no-backend).
    const passthroughMime: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
    };
    const mime = passthroughMime[ext];
    if (mime) {
      // No backend call at all, not even metadata(); width/height 0 means "webview sizes from naturalWidth/Height".
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, width: 0, height: 0 };
    }

    const sharp = getSharp();
    if (sharp) {
      // `inst` is reused for metadata() and png(): Sharp re-reads its input buffer (docs/image-backends.md).
      const inst = this.createSharpInstance(sharp, buffer, ext);
      const metadata = await inst.metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const imageBuffer = await inst.png().toBuffer();
      return { dataUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`, width, height };
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    const pngBuffer: Buffer = await image.getBuffer('image/png');
    return {
      dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
      width: image.width,
      height: image.height
    };
  }

  /** Jimp fallback for slide images: cap at 2560px longest side (no enlargement), JPEG quality 85, mirroring the provider's Sharp branch; null when Jimp is unavailable (docs/crop-and-pptx.md: deck-images-bounded). */
  async capSlideImage(buffer: Buffer, ext: string): Promise<{ bytes: Buffer; width: number; height: number } | null> {
    const Jimp = this.getJimp();
    if (!Jimp) {
      return null;
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    const width: number = image.width;
    const height: number = image.height;
    if (width > 2560 || height > 2560) {
      image.scaleToFit({ w: 2560, h: 2560 });
    }
    const bytes: Buffer = await image.getBuffer('image/jpeg', { quality: 85 });
    return { bytes, width, height };
  }

  // ---------------------------------------------------------------------------
  // Image metadata
  // ---------------------------------------------------------------------------

  async getImageDimensions(uri: vscode.Uri): Promise<{ width: number; height: number }> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    const sharp = getSharp();
    if (sharp) {
      const meta = await this.createSharpInstance(sharp, buffer, ext).metadata();
      return { width: meta.width || 0, height: meta.height || 0 };
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    return { width: image.width, height: image.height };
  }

  // ---------------------------------------------------------------------------
  // Cropping
  // ---------------------------------------------------------------------------

  async cropImage(
    uri: vscode.Uri,
    rect: { x: number; y: number; w: number; h: number },
    sourceWidth: number,
    sourceHeight: number
  ): Promise<Buffer> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    // Crop metadata payload, written twice below — EXIF and tEXt (docs/image-backends.md: metadata-written-twice).
    const cropMeta = encodeCropMeta(rect, sourceWidth, sourceHeight);

    const sharp = getSharp();
    if (sharp) {
      const pngBuf = await this.createSharpInstance(sharp, buffer, ext)
        .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
        .png({ compressionLevel: 6 })
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: `${CROP_RECT_KEYWORD}=${cropMeta}` }
          }
        })
        .toBuffer();
      // tEXt as well: the cross-tool contract the standalone HTML tool reads.
      return pngInjectText(pngBuf, CROP_RECT_KEYWORD, cropMeta);
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    image.crop({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    const pngBuf: Buffer = await image.getBuffer('image/png');
    return pngInjectText(pngBuf, CROP_RECT_KEYWORD, cropMeta);
  }

  /** Read crop metadata from a PNG, or null if it is not a crop file. */
  async readCropMetadata(uri: vscode.Uri): Promise<CropMeta | null> {
    try {
      const fileData = await vscode.workspace.fs.readFile(uri);
      const buffer = Buffer.from(fileData);

      // Try EXIF (Sharp path writes here)
      const sharp = getSharp();
      if (sharp) {
        // Bypasses createSharpInstance: safe only because crops are always PNG (docs/image-backends.md: ppmx-through-helpers).
        const meta = await sharp(buffer).metadata();
        const desc = meta.exif ? this.parseExifDescription(meta.exif) : null;
        if (desc && desc.startsWith(`${CROP_RECT_KEYWORD}=`)) {
          const parsed = parseCropMeta(desc.replace(`${CROP_RECT_KEYWORD}=`, ''));
          if (parsed) return parsed;
        }
      }

      // Fallback: try PNG tEXt chunk (Jimp path writes here)
      const textVal = pngReadText(buffer, CROP_RECT_KEYWORD);
      if (textVal) {
        const parsed = parseCropMeta(textVal);
        if (parsed) return parsed;
      }

      return null;
    } catch {
      return null;
    }
  }

  /** Extract ImageDescription (IFD0 tag 0x010E) from an EXIF buffer, or null. */
  private parseExifDescription(exifBuffer: Buffer): string | null {
    try {
      // Marker search rather than a real EXIF walk — we only ever read this one tag.
      const str = exifBuffer.toString('latin1');
      const marker = `${CROP_RECT_KEYWORD}=`;
      const idx = str.indexOf(marker);
      if (idx >= 0) {
        let end = idx + marker.length;
        while (end < str.length && /[\d,]/.test(str[end])) end++;
        return str.slice(idx, end);
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Disk cache
  // ---------------------------------------------------------------------------

  private async loadFromDiskCache(cacheKey: string): Promise<Buffer | null> {
    const cacheFile = vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`);
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(cacheFile));
    } catch {
      return null;
    }
  }

  private async saveToDiskCache(cacheKey: string, bytes: Buffer): Promise<void> {
    const cacheFile = vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`);
    try {
      await vscode.workspace.fs.writeFile(cacheFile, bytes);
    } catch (err) {
      console.warn(`Failed to save thumbnail to cache: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Packfile snapshot — a rename-only snapshot of the memory cache; one sequential read on a warm open (docs/image-backends.md: thumb-pack-atomic).
  // ---------------------------------------------------------------------------

  private ensurePackLoaded(): Promise<Map<string, Buffer>> {
    if (this.packMap) return Promise.resolve(this.packMap);
    if (!this.packLoad) {
      this.packLoad = (async () => {
        try {
          const idx = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'thumbs.idx'))).toString('utf8');
          const pack = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'thumbs.pack')));
          this.packMap = parsePack(idx, pack) ?? new Map();
        } catch {
          this.packMap = new Map(); // no pack yet, or unreadable: per-entry files serve everything
        }
        return this.packMap;
      })();
    }
    return this.packLoad;
  }

  private schedulePackSnapshot(): void {
    if (this.packTimer) clearTimeout(this.packTimer);
    // Idle-debounced: one snapshot after the churn, not one per thumbnail.
    this.packTimer = setTimeout(() => { void this.writePackSnapshot(); }, PACK_SNAPSHOT_IDLE_MS);
  }

  private async writePackSnapshot(): Promise<void> {
    if (this.packWriting || !this.packDirty) return;
    this.packWriting = true;
    try {
      const uuid = crypto.randomUUID();
      const entries = [...this.memoryCache].map(([key, bytes]) => ({ key, bytes }));
      const { pack, idx } = buildPack(uuid, entries);
      const packTmp = vscode.Uri.joinPath(this.cacheDir, `thumbs.pack.tmp-${process.pid}`);
      const idxTmp = vscode.Uri.joinPath(this.cacheDir, `thumbs.idx.tmp-${process.pid}`);
      await vscode.workspace.fs.writeFile(packTmp, pack);
      await vscode.workspace.fs.writeFile(idxTmp, Buffer.from(idx, 'utf8'));
      // Rename-only publication: the uuid pairing lets a reader reject any torn pack/idx combination (docs/image-backends.md: thumb-pack-atomic).
      await vscode.workspace.fs.rename(packTmp, vscode.Uri.joinPath(this.cacheDir, 'thumbs.pack'), { overwrite: true });
      await vscode.workspace.fs.rename(idxTmp, vscode.Uri.joinPath(this.cacheDir, 'thumbs.idx'), { overwrite: true });
      this.packDirty = false;
    } catch (err) {
      console.warn(`Failed to write thumbnail pack: ${err}`);
    } finally {
      this.packWriting = false;
    }
  }

  dispose(): void {
    if (this.packTimer) clearTimeout(this.packTimer);
  }

  private async cleanupOldCache(): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const maxAgeDays = config.get<number>('cacheMaxAgeDays', 7);
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
      const entries = await vscode.workspace.fs.readDirectory(this.cacheDir);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File) {
          const fileUri = vscode.Uri.joinPath(this.cacheDir, name);
          try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            if (now - stat.mtime > maxAgeMs) {
              await vscode.workspace.fs.delete(fileUri);
            }
          } catch {
            // Ignore errors for individual files
          }
        }
      }
    } catch {
      // Cache directory may not exist yet
    }
  }

  /** Least-recently-used eviction, by bytes: the disk cache backs every entry, so a miss costs one readFile. */
  private rememberInMemory(cacheKey: string, bytes: Buffer, newToPack: boolean): void {
    const prev = this.memoryCache.get(cacheKey);
    if (prev !== undefined) this.memoryCacheBytes -= prev.length;
    this.memoryCache.set(cacheKey, bytes);
    this.memoryCacheBytes += bytes.length;
    while (this.memoryCacheBytes > MEMORY_CACHE_MAX_BYTES) {
      const oldest = this.memoryCache.keys().next();
      if (oldest.done) break;
      const evicted = this.memoryCache.get(oldest.value);
      this.memoryCache.delete(oldest.value);
      this.memoryCacheBytes -= evicted ? evicted.length : 0;
    }
    if (newToPack) this.packDirty = true;
    this.schedulePackSnapshot();
  }

  clearMemoryCache(): void {
    this.memoryCache.clear();
    this.memoryCacheBytes = 0;
  }
}
