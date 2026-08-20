/** Pure (no DOM/vscode): ownership of the webview's carousel thumbnail urls — see docs/loading-architecture.md. */

/** Only object urls are owned; the shared ✕ placeholder is a data url the cache stores but must never revoke (docs/loading-architecture.md: thumb-url-owned-by-cache). */
export const isObjectUrl = (url: string): boolean => url.startsWith('blob:');

/** Transparent 1x1 png: what a tile shows while its slot has no thumbnail — never an absent src (docs/loading-architecture.md: empty-tile-never-broken). */
export const BLANK_THUMB =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==';

/** Keyed `"<tupleIndex>-<modalityIndex>"` in original (global) modality space, like every other webview slot map. */
export class ThumbUrlCache {
  private readonly urls = new Map<string, string>();
  private live = 0;

  constructor(private readonly revokeObjectUrl: (url: string) => void) {}

  get(key: string): string | undefined {
    return this.urls.get(key);
  }

  /** Object urls held and not yet revoked — the leak this class exists to prevent, made observable. */
  get liveCount(): number {
    return this.live;
  }

  /** Adopt `url` for `key`: map and tile point at the successor (via `adopt`) BEFORE the superseded url is revoked, and the incoming url is never revoked here (docs/loading-architecture.md: thumb-url-owned-by-cache). */
  set(key: string, url: string, adopt?: () => void): void {
    const prev = this.urls.get(key);
    this.urls.set(key, url);
    if (prev !== url && isObjectUrl(url)) this.live++;
    if (adopt) adopt();
    if (prev !== url) this.release(prev);
  }

  delete(key: string): void {
    const prev = this.urls.get(key);
    this.urls.delete(key);
    this.release(prev);
  }

  clear(): void {
    for (const url of this.urls.values()) this.release(url);
    this.urls.clear();
  }

  /** Re-index every key after a row/column splice; a null mapping drops that entry, which is the only place a re-key revokes (docs/loading-architecture.md: thumb-url-owned-by-cache). */
  rekey(mapKey: (tupleIndex: number, modalityIndex: number) => string | null): void {
    const next = new Map<string, string>();
    for (const [key, url] of this.urls) {
      const [tupleIndex, modalityIndex] = key.split('-').map(Number);
      const moved = mapKey(tupleIndex, modalityIndex);
      if (moved === null) this.release(url);
      else next.set(moved, url);
    }
    this.urls.clear();
    for (const [key, url] of next) this.urls.set(key, url);
  }

  private release(url: string | undefined): void {
    if (url === undefined || !isObjectUrl(url)) return;
    this.revokeObjectUrl(url);
    this.live--;
  }
}
