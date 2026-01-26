import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import sharp from 'sharp';
import { parsePpmx } from './ppmxParser';

/**
 * Service for generating and caching image thumbnails.
 * Uses Sharp (libvips) for fast native image processing.
 * Caches thumbnails to disk for faster subsequent loads.
 */
export class ThumbnailService {
  private cacheDir: vscode.Uri;
  private memoryCache: Map<string, string> = new Map();

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

    // Clean up old cache entries in background
    this.cleanupOldCache();
  }

  /**
   * Get cache key for a file based on path and modification time
   */
  private getCacheKey(uri: vscode.Uri, mtime: number): string {
    const hash = crypto.createHash('sha256');
    hash.update(uri.toString());
    hash.update(mtime.toString());
    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Generate a thumbnail for an image file (with caching)
   */
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

  /**
   * Generate thumbnail using Sharp
   */
  private async generateThumbnail(uri: vscode.Uri, size: number): Promise<string> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    let sharpInstance: sharp.Sharp;

    if (ext === '.ppmx') {
      const ppmx = parsePpmx(buffer);
      // Create Sharp instance from raw RGB data
      sharpInstance = sharp(ppmx.rgbBuffer, {
        raw: {
          width: ppmx.width,
          height: ppmx.height,
          channels: 3
        }
      });
    } else {
      sharpInstance = sharp(buffer);
    }

    // Resize maintaining aspect ratio (fit inside size x size)
    const thumbnailBuffer = await sharpInstance
      .resize(size, size, { fit: 'inside' })
      .jpeg({ quality: 70 })
      .toBuffer();

    return `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
  }

  /**
   * Load a full image and return its data URL and dimensions
   */
  async loadFullImage(uri: vscode.Uri): Promise<{ dataUrl: string; width: number; height: number }> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    let sharpInstance: sharp.Sharp;

    if (ext === '.ppmx') {
      const ppmx = parsePpmx(buffer);
      sharpInstance = sharp(ppmx.rgbBuffer, {
        raw: {
          width: ppmx.width,
          height: ppmx.height,
          channels: 3
        }
      });
    } else {
      sharpInstance = sharp(buffer);
    }

    const metadata = await sharpInstance.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    // Convert to PNG for lossless display
    const imageBuffer = await sharpInstance.png().toBuffer();
    const dataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;

    return { dataUrl, width, height };
  }

  /**
   * Queue multiple thumbnails for generation
   */
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

  /**
   * Load from disk cache
   */
  private async loadFromDiskCache(cacheKey: string): Promise<string | null> {
    const cacheFile = vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`);
    try {
      const data = await vscode.workspace.fs.readFile(cacheFile);
      return `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`;
    } catch {
      return null;
    }
  }

  /**
   * Save to disk cache (fire and forget)
   */
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

  /**
   * Clean up old cache entries based on cacheMaxAgeDays setting
   */
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

  /**
   * Clear memory cache
   */
  clearMemoryCache(): void {
    this.memoryCache.clear();
  }
}
