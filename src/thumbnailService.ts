import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { getSharp, getSharpError } from './sharpLoader';
import { parsePpmx } from './ppmxParser';
import { CROP_RECT_KEYWORD, CropMeta, encodeCropMeta, parseCropMeta, pngInjectText, pngReadText } from './pngText';

/** Byte-capped, not entry-capped: `thumbnailSize` maxes at 200, so entries range 4x in size. Sized
 *  past a realistic session — a real cache of 26k thumbnails at ~5.7KB each is ~143MB, and a cap that
 *  bites turns every revisit into a disk read on the mounts this extension exists to serve. */
const MEMORY_CACHE_MAX_BYTES = 192 * 1024 * 1024;

/** Generates and caches thumbnails via Sharp, falling back to Jimp. See docs/image-backends.md. */
export class ThumbnailService {
  private cacheDir: vscode.Uri;
  /** Bounded: a 2000x4 session is ~8000 base64 thumbnails, ~85MB retained for the host's lifetime otherwise. */
  private memoryCache: Map<string, string> = new Map();
  private memoryCacheBytes = 0;
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
        return hit;
      }

      const cachedDataUrl = await this.loadFromDiskCache(cacheKey);
      if (cachedDataUrl) {
        this.rememberInMemory(cacheKey, cachedDataUrl);
        return cachedDataUrl;
      }

      const dataUrl = await this.generateThumbnail(uri, size);

      this.rememberInMemory(cacheKey, dataUrl);
      this.saveToDiskCache(cacheKey, dataUrl); // deliberately not awaited

      return dataUrl;
    } catch (error) {
      console.error(`Failed to generate thumbnail for ${uri.toString()}:`, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Thumbnail generation
  // ---------------------------------------------------------------------------

  private async generateThumbnail(uri: vscode.Uri, size: number): Promise<string> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    const sharp = getSharp();
    if (sharp) {
      const inst = this.createSharpInstance(sharp, buffer, ext);
      // Both backends must emit identical size and JPEG quality 70, or which one ran becomes user-visible (docs/image-backends.md: backends-agree-output).
      const thumbnailBuffer = await inst
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 70 })
        .toBuffer();
      return `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    // Must match the Sharp branch's size and quality 70 above (docs/image-backends.md: backends-agree-output).
    image.scaleToFit({ w: size, h: size });
    const jpegBuffer: Buffer = await image.getBuffer('image/jpeg', { quality: 70 });
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
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

  private async loadFromDiskCache(cacheKey: string): Promise<string | null> {
    const cacheFile = vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`);
    try {
      const data = await vscode.workspace.fs.readFile(cacheFile);
      return `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`;
    } catch {
      return null;
    }
  }

  private async saveToDiskCache(cacheKey: string, dataUrl: string): Promise<void> {
    const cacheFile = vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`);
    try {
      const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await vscode.workspace.fs.writeFile(cacheFile, buffer);
    } catch (err) {
      console.warn(`Failed to save thumbnail to cache: ${err}`);
    }
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
  private rememberInMemory(cacheKey: string, dataUrl: string): void {
    const prev = this.memoryCache.get(cacheKey);
    if (prev !== undefined) this.memoryCacheBytes -= prev.length;
    this.memoryCache.set(cacheKey, dataUrl);
    this.memoryCacheBytes += dataUrl.length;
    while (this.memoryCacheBytes > MEMORY_CACHE_MAX_BYTES) {
      const oldest = this.memoryCache.keys().next();
      if (oldest.done) break;
      const evicted = this.memoryCache.get(oldest.value);
      this.memoryCache.delete(oldest.value);
      this.memoryCacheBytes -= evicted ? evicted.length : 0;
    }
  }

  clearMemoryCache(): void {
    this.memoryCache.clear();
    this.memoryCacheBytes = 0;
  }
}
