import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getSharp, getSharpError } from './sharpLoader';
import { parsePpmx } from './ppmxParser';
import { CROP_RECT_KEYWORD, CropMeta, parseCropMeta, pngReadText } from './pngText';
import { buildPack, parsePack, PackEntry } from './thumbPack';
import { DECK_IMAGE_MAX_DIM, DECK_JPEG_QUALITY } from './pptxDeck';
import { passthroughMime } from './imageMime';
import { debugEnabled, debugVerbose, emptyPackLoadStat, emptyTierStats, formatBytes, PackLoadStat, ThumbTier, TierStats } from './debugLog';

/** Byte-capped, not entry-capped: `thumbnailSize` maxes at 200, so entries range 4x in size. Sized
 *  past a realistic session — a real cache of 26k thumbnails at ~4.3KB of raw JPEG each is ~110MB,
 *  and a cap that bites turns every revisit into a disk read on the mounts this extension exists to
 *  serve. The cap also bounds the packfile snapshot built from this cache. */
const MEMORY_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const PACK_SNAPSHOT_IDLE_MS = 30_000;

/** Every tier stores and returns what both backends encode — JPEG (docs/image-backends.md: backends-agree-output). */
export const THUMBNAIL_MIME = 'image/jpeg';

/** Generates and caches thumbnails via Sharp, falling back to Jimp. See docs/image-backends.md. */
export class ThumbnailService {
  private cacheDir: vscode.Uri;
  /** Raw JPEG bytes, delivered as-is: one representation feeds hits, the wire and the pack snapshot alike. */
  private memoryCache: Map<string, Buffer> = new Map();
  private memoryCacheBytes = 0;
  private packMap: Map<string, Buffer> | undefined;
  private packLoad: Promise<Map<string, Buffer>> | undefined;
  private packDirty = false;
  private packTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once a pack was loaded from disk: only then can a sweep leave a hole this session must refill (docs/image-backends.md: thumb-cache-expires-by-use). */
  private packLoadedFromDisk = false;
  /** Last key seen per URI (not per URI+size — every call site uses the same `thumbnailSize`), so an overwritten file's dead entry is dropped instead of accumulating (docs/image-backends.md: thumb-key-sees-overwrite). */
  private keyByUri: Map<string, string> = new Map();
  /** Serializes snapshot writes, and is what `flush()` awaits (docs/image-backends.md: thumb-pack-survives-close). */
  private packWrite: Promise<void> = Promise.resolve();
  /** Lazily loaded Jimp constructor — only required when Sharp is unavailable. */
  private jimpModule: any = undefined;
  private jimpLoadAttempted = false;
  /** Cumulative, debug-only: the sweep diffs two snapshots to report its own tier histogram. */
  private tierStats: TierStats = emptyTierStats();
  /** Cumulative, debug-only: the shared pack read, kept out of the tiers (docs/loading-architecture.md: shared-waits-are-not-per-item-work). */
  private packLoadStat: PackLoadStat = emptyPackLoadStat();

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
  private getCacheKey(uri: vscode.Uri, mtime: number, ctime: number, size: number): string {
    const hash = crypto.createHash('sha256');
    hash.update(uri.toString());
    hash.update(mtime.toString());
    // Inode change time: the one component an mtime-preserving overwrite cannot fake (docs/image-backends.md: thumb-key-sees-overwrite).
    hash.update(ctime.toString());
    hash.update(size.toString());
    return hash.digest('hex').substring(0, 16);
  }

  /** vscode's own `FileStat.ctime` is *birth* time, which an in-place overwrite leaves untouched — so file URIs are statted through node (docs/image-backends.md: thumb-key-sees-overwrite). */
  private async statForKey(uri: vscode.Uri): Promise<{ mtime: number; ctime: number; size: number }> {
    if (uri.scheme === 'file') {
      const s = await fs.promises.stat(uri.fsPath);
      return { mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size };
    }
    const s = await vscode.workspace.fs.stat(uri);
    return { mtime: s.mtime, ctime: s.ctime, size: s.size };
  }

  /** Drop every copy of the key this URI has outgrown — memory, loaded pack, per-entry file (docs/image-backends.md: thumb-key-sees-overwrite). */
  private evictSuperseded(uri: vscode.Uri, cacheKey: string): void {
    const uriKey = uri.toString();
    const prev = this.keyByUri.get(uriKey);
    this.keyByUri.set(uriKey, cacheKey);
    if (prev === undefined || prev === cacheKey) return;
    const dead = this.memoryCache.get(prev);
    if (dead !== undefined) {
      this.memoryCache.delete(prev);
      this.memoryCacheBytes -= dead.length;
      this.packDirty = true;
    }
    this.packMap?.delete(prev);
    void this.deleteFromDiskCache(prev);
  }

  /** Snapshot of the cumulative per-tier accounting; empty unless `imageCompare.debug` was on. */
  thumbTierStats(): TierStats {
    const out = emptyTierStats();
    for (const tier of Object.keys(out) as ThumbTier[]) out[tier] = { ...this.tierStats[tier] };
    return out;
  }

  /** Snapshot of the cumulative shared-pack-load accounting; empty unless `imageCompare.debug` was on. */
  thumbPackLoadStat(): PackLoadStat {
    return { ...this.packLoadStat };
  }

  /** Debug-only tier accounting; the caller's guard is the flag, so the off path never times or counts (docs/loading-architecture.md: debug-off-costs-nothing). */
  private noteTier(tier: ThumbTier, startedAt: number, waitedMs: number, bytes: number, uri: vscode.Uri): void {
    // Time blocked on the pack load everyone shares is this item's wait, not its work (docs/loading-architecture.md: shared-waits-are-not-per-item-work).
    const ms = Math.max(0, Date.now() - startedAt - waitedMs);
    const stat = this.tierStats[tier];
    stat.count++;
    stat.ms += ms;
    stat.bytes += bytes;
    if (waitedMs > 0) {
      this.packLoadStat.blocked++;
      this.packLoadStat.waitedMs += waitedMs;
    }
    debugVerbose('[IC-THUMB]', () => `${tier} ${ms}ms${waitedMs > 0 ? ` +${waitedMs}ms packLoad wait` : ''} ${formatBytes(bytes)} ${uri.path}`);
  }

  /** Raw JPEG bytes (`THUMBNAIL_MIME`); the caller owns the wire shape — see docs/loading-architecture.md. */
  async getThumbnail(uri: vscode.Uri, size: number): Promise<Buffer> {
    // One boolean read is the whole cost when debug is off: no clock, no counters, no strings.
    const timed = debugEnabled();
    const startedAt = timed ? Date.now() : 0;
    try {
      const stat = await this.statForKey(uri);
      const cacheKey = this.getCacheKey(uri, stat.mtime, stat.ctime, size);
      this.evictSuperseded(uri, cacheKey);

      const hit = this.memoryCache.get(cacheKey);
      if (hit !== undefined) {
        /* Re-insert so eviction is by recency — the rows a user scrolls back to are the oldest. */
        this.memoryCache.delete(cacheKey);
        this.memoryCache.set(cacheKey, hit);
        // A memory hit returns above the pack load, so it can never carry a shared wait.
        if (timed) this.noteTier('memory', startedAt, 0, hit.length, uri);
        return hit;
      }

      // One sequential read serves the whole warm open; per-entry files are the fallback (docs/image-backends.md).
      const waitStartedAt = timed ? Date.now() : 0;
      const packMap = await this.ensurePackLoaded();
      // Every tier below memory queues behind this one read, so each subtracts its own wait (docs/loading-architecture.md: shared-waits-are-not-per-item-work).
      const waitedMs = timed ? Date.now() - waitStartedAt : 0;
      const packed = packMap.get(cacheKey);
      if (packed !== undefined) {
        this.rememberInMemory(cacheKey, packed, false);
        if (timed) this.noteTier('pack', startedAt, waitedMs, packed.length, uri);
        return packed;
      }

      const cachedBytes = await this.loadFromDiskCache(cacheKey);
      if (cachedBytes) {
        // Pack-dirty on purpose: per-entry files expire, so a disk hit must reach the next snapshot (docs/image-backends.md: thumb-cache-expires-by-use).
        this.rememberInMemory(cacheKey, cachedBytes, true);
        if (timed) this.noteTier('disk', startedAt, waitedMs, cachedBytes.length, uri);
        return cachedBytes;
      }

      const bytes = await this.generateThumbnail(uri, size);

      this.rememberInMemory(cacheKey, bytes, true);
      this.saveToDiskCache(cacheKey, bytes); // deliberately not awaited

      if (timed) this.noteTier('generated', startedAt, waitedMs, bytes.length, uri);
      return bytes;
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

  async loadFullImage(uri: vscode.Uri): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    // Browser-decodable formats pass through as original bytes (docs/image-backends.md: passthrough-no-backend).
    const mime = passthroughMime(ext);
    if (mime) {
      // No backend call at all, not even metadata(); width/height 0 means "webview sizes from naturalWidth/Height".
      return { bytes: buffer, mime, width: 0, height: 0 };
    }

    return this.convertFullImage(buffer, ext);
  }

  /** Non-passthrough conversion tier — Sharp, else Jimp, else throw; serveImage's convert io on the provider side. */
  async convertFullImage(buffer: Buffer, ext: string): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
    const sharp = getSharp();
    if (sharp) {
      // `inst` is reused for metadata() and png(): Sharp re-reads its input buffer (docs/image-backends.md).
      const inst = this.createSharpInstance(sharp, buffer, ext);
      const metadata = await inst.metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const imageBuffer = await inst.png().toBuffer();
      return { bytes: imageBuffer, mime: 'image/png', width, height };
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    const pngBuffer: Buffer = await image.getBuffer('image/png');
    return { bytes: pngBuffer, mime: 'image/png', width: image.width, height: image.height };
  }

  /** Jimp fallback for slide images: cap at the shared deck bound (no enlargement) and recompress, mirroring the provider's Sharp branch; null when Jimp is unavailable (docs/crop-and-pptx.md: deck-images-bounded). */
  async capSlideImage(buffer: Buffer, ext: string): Promise<{ bytes: Buffer; width: number; height: number } | null> {
    const Jimp = this.getJimp();
    if (!Jimp) {
      return null;
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    const width: number = image.width;
    const height: number = image.height;
    if (width > DECK_IMAGE_MAX_DIM || height > DECK_IMAGE_MAX_DIM) {
      image.scaleToFit({ w: DECK_IMAGE_MAX_DIM, h: DECK_IMAGE_MAX_DIM });
    }
    const bytes: Buffer = await image.getBuffer('image/jpeg', { quality: DECK_JPEG_QUALITY });
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

  /** Extract `rect` as PNG; the shared crop flow injects the tEXt copy of `cropMeta`, this adds only the Sharp-path EXIF copy (docs/image-backends.md: metadata-written-twice). */
  async cropImage(
    uri: vscode.Uri,
    rect: { x: number; y: number; w: number; h: number },
    cropMeta: string
  ): Promise<Buffer> {
    const fileData = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileData);
    const ext = path.extname(uri.path).toLowerCase();

    const sharp = getSharp();
    if (sharp) {
      return this.createSharpInstance(sharp, buffer, ext)
        .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
        .png({ compressionLevel: 6 })
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: `${CROP_RECT_KEYWORD}=${cropMeta}` }
          }
        })
        .toBuffer();
    }

    const Jimp = this.getJimp();
    if (!Jimp) {
      throw new Error('No image processing backend available (Sharp and Jimp both failed)');
    }
    const image = await this.createJimpImage(Jimp, buffer, ext);
    image.crop({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    return image.getBuffer('image/png');
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

  private async deleteFromDiskCache(cacheKey: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.cacheDir, `${cacheKey}.jpg`));
    } catch {
      // Never written, already swept, or read-only storage — a dead file costs only space
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
        // Measured once, here, where the file is actually read (docs/loading-architecture.md: shared-waits-are-not-per-item-work).
        const timed = debugEnabled();
        const startedAt = timed ? Date.now() : 0;
        let readBytes = 0;
        try {
          const idx = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'thumbs.idx'))).toString('utf8');
          const pack = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, 'thumbs.pack')));
          readBytes = idx.length + pack.length;
          const parsed = parsePack(idx, pack);
          this.packMap = parsed ?? new Map();
          // Expiry is by last use, and a warm session rewrites nothing (docs/image-backends.md: thumb-cache-expires-by-use).
          if (parsed) { this.packLoadedFromDisk = true; await this.touchPack(); }
        } catch {
          this.packMap = new Map(); // no pack yet, or unreadable: per-entry files serve everything
        }
        if (timed) {
          this.packLoadStat.count++;
          this.packLoadStat.ms += Date.now() - startedAt;
          this.packLoadStat.bytes += readBytes;
        }
        return this.packMap;
      })();
    }
    return this.packLoad;
  }

  /** Two utimes for the whole session — the pack's mtime is its last-use stamp (docs/image-backends.md: thumb-cache-expires-by-use). */
  private async touchPack(): Promise<void> {
    if (this.cacheDir.scheme !== 'file') return;
    const now = new Date();
    for (const name of ['thumbs.pack', 'thumbs.idx']) {
      try {
        await fs.promises.utimes(vscode.Uri.joinPath(this.cacheDir, name).fsPath, now, now);
      } catch {
        // Swept between the read and the touch, or unwritable — the next publish re-dates it
      }
    }
  }

  private schedulePackSnapshot(): void {
    if (this.packTimer) clearTimeout(this.packTimer);
    // Idle-debounced: one snapshot after the churn, not one per thumbnail.
    this.packTimer = setTimeout(() => { void this.queuePackSnapshot(); }, PACK_SNAPSHOT_IDLE_MS);
  }

  /** Two stats per publish *decision*, never per thumbnail, and only when nothing else would publish (docs/image-backends.md: thumb-cache-expires-by-use). */
  private async packGone(): Promise<boolean> {
    if (!this.packLoadedFromDisk) return false;
    for (const name of ['thumbs.pack', 'thumbs.idx']) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.cacheDir, name));
      } catch {
        return true; // Either half missing makes the pair unusable (docs/image-backends.md: thumb-pack-atomic)
      }
    }
    return false;
  }

  /** Queue a snapshot of the cache as it stands now; writes are chained, so a flush awaits the one in flight (docs/image-backends.md: thumb-pack-survives-close). */
  private async queuePackSnapshot(): Promise<void> {
    // Guard order is load-bearing: on the dirty path no `await` runs, so entries are still captured synchronously (docs/image-backends.md: thumb-pack-survives-close).
    if (!this.packDirty && this.memoryCache.size > 0 && await this.packGone()) this.packDirty = true;
    if (!this.packDirty || this.memoryCache.size === 0) return this.packWrite;
    // Entries are read here, not inside the write: a clearMemoryCache racing the close must never publish an empty pack (docs/image-backends.md: thumb-pack-survives-close).
    const entries = [...this.memoryCache].map(([key, bytes]) => ({ key, bytes }));
    this.packDirty = false;
    this.packWrite = this.packWrite.then(() => this.writePackSnapshot(entries));
    return this.packWrite;
  }

  private async writePackSnapshot(entries: PackEntry[]): Promise<void> {
    try {
      const uuid = crypto.randomUUID();
      const { pack, idx } = buildPack(uuid, entries);
      const packTmp = vscode.Uri.joinPath(this.cacheDir, `thumbs.pack.tmp-${process.pid}`);
      const idxTmp = vscode.Uri.joinPath(this.cacheDir, `thumbs.idx.tmp-${process.pid}`);
      await vscode.workspace.fs.writeFile(packTmp, pack);
      await vscode.workspace.fs.writeFile(idxTmp, Buffer.from(idx, 'utf8'));
      // Rename-only publication: the uuid pairing lets a reader reject any torn pack/idx combination (docs/image-backends.md: thumb-pack-atomic).
      await vscode.workspace.fs.rename(packTmp, vscode.Uri.joinPath(this.cacheDir, 'thumbs.pack'), { overwrite: true });
      await vscode.workspace.fs.rename(idxTmp, vscode.Uri.joinPath(this.cacheDir, 'thumbs.idx'), { overwrite: true });
    } catch (err) {
      this.packDirty = true;
      console.warn(`Failed to write thumbnail pack: ${err}`);
    }
  }

  /** Publish any pending snapshot and resolve once it is on disk; the shutdown path awaits this (docs/image-backends.md: thumb-pack-survives-close). */
  async flush(): Promise<void> {
    if (this.packTimer) {
      clearTimeout(this.packTimer);
      this.packTimer = undefined;
    }
    await this.queuePackSnapshot();
  }

  dispose(): void {
    // A disposable's dispose is sync, so it starts the pending write; `deactivate` is what awaits it (docs/image-backends.md: thumb-pack-survives-close).
    void this.flush();
  }

  /** Age-prunes the cache dir by last *use*, not last write (docs/image-backends.md: thumb-cache-expires-by-use); `initialize` starts it without awaiting. */
  async cleanupOldCache(): Promise<void> {
    const config = vscode.workspace.getConfiguration('imageCompare');
    const maxAgeDays = config.get<number>('cacheMaxAgeDays', 7);
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
      const entries = await vscode.workspace.fs.readDirectory(this.cacheDir);
      // Bitmask, never equality — same classification rule as every other listing (docs/tuple-matching.md: entry-type-is-a-bitmask).
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.File) !== 0) {
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
