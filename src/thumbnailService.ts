import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { getSharp, getSharpError } from './sharpLoader';
import { parsePpmx } from './ppmxParser';

/**
 * Service for generating and caching image thumbnails.
 *
 * Tries Sharp (native → WASM) first for performance.
 * Falls back to Jimp (pure JS) when Sharp is completely unavailable.
 */
export class ThumbnailService {
  private cacheDir: vscode.Uri;
  private memoryCache: Map<string, string> = new Map();
  /** Lazily loaded Jimp constructor — only required when Sharp is unavailable. */
  private jimpModule: any = undefined;
  private jimpLoadAttempted = false;

  constructor(private context: vscode.ExtensionContext) {
    this.cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'thumbnail-cache');
  }

  /**
   * Initialize the cache directory
   */
  async initialize(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.cacheDir);
    } catch {
      // Directory may already exist
    }

    // Log which backend will be used
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

    // Clean up old cache entries in background
    this.cleanupOldCache();
  }

  // ---------------------------------------------------------------------------
  // Backend helpers
  // ---------------------------------------------------------------------------

  /** Lazily load Jimp so we don't pay the cost when Sharp works fine. */
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

  private getCacheKey(uri: vscode.Uri, mtime: number): string {
    const hash = crypto.createHash('sha256');
    hash.update(uri.toString());
    hash.update(mtime.toString());
    return hash.digest('hex').substring(0, 16);
  }

  async getThumbnail(uri: vscode.Uri, size: number): Promise<string> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cacheKey = this.getCacheKey(uri, stat.mtime);

      // Check memory cache first
      if (this.memoryCache.has(cacheKey)) {
        return this.memoryCache.get(cacheKey)!;
      }

      // Check disk cache
      const cachedDataUrl = await this.loadFromDiskCache(cacheKey);
      if (cachedDataUrl) {
        this.memoryCache.set(cacheKey, cachedDataUrl);
        return cachedDataUrl;
      }

      // Generate new thumbnail
      const dataUrl = await this.generateThumbnail(uri, size);

      // Cache it
      this.memoryCache.set(cacheKey, dataUrl);
      this.saveToDiskCache(cacheKey, dataUrl); // Don't await - save in background

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

    const sharp = getSharp();
    if (sharp) {
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
  // Thumbnail queue
  // ---------------------------------------------------------------------------

  queueThumbnails(
    items: Array<{ uri: vscode.Uri; tupleIndex: number; modalityIndex: number }>,
    size: number,
    onComplete: (tupleIndex: number, modalityIndex: number, dataUrl: string) => void,
    onError: (tupleIndex: number, modalityIndex: number, error: string) => void,
    onProgress: (current: number, total: number) => void
  ): void {
    let completed = 0;
    const total = items.length;

    for (const item of items) {
      this.getThumbnail(item.uri, size)
        .then(dataUrl => {
          completed++;
          onComplete(item.tupleIndex, item.modalityIndex, dataUrl);
          onProgress(completed, total);
        })
        .catch(err => {
          completed++;
          onError(item.tupleIndex, item.modalityIndex, err.message);
          onProgress(completed, total);
        });
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

  clearMemoryCache(): void {
    this.memoryCache.clear();
  }
}
