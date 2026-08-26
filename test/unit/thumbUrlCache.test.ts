import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { ThumbUrlCache, isObjectUrl, BLANK_THUMB } from '../../src/webview/thumbUrlCache';

// The ✕ placeholder the webview caches for a missing/undecodable slot: a shared data url, so the
// cache must store it and never revoke it (revoking a shared url once would break every other slot).
const PLACEHOLDER = 'data:image/png;base64,PLACEHOLDER';

function rig() {
  const revoked: string[] = [];
  const log: string[] = [];
  const cache = new ThumbUrlCache(url => {
    revoked.push(url);
    log.push(`revoke:${url}`);
  });
  return { cache, revoked, log };
}

describe('ThumbUrlCache (real src/webview/thumbUrlCache.ts)', () => {
  it('revokes the superseded url and never the incoming one', () => {
    const { cache, revoked } = rig();
    cache.set('0-0', 'blob:a');
    expect(revoked).toEqual([]);
    expect(cache.get('0-0')).toBe('blob:a');

    cache.set('0-0', 'blob:b');
    expect(revoked).toEqual(['blob:a']);
    expect(cache.get('0-0')).toBe('blob:b');
    expect(cache.liveCount).toBe(1);
  });

  it('adopts the successor before revoking the loser', () => {
    const { cache, log } = rig();
    cache.set('0-0', 'blob:a');
    cache.set('0-0', 'blob:b', () => log.push('adopt:blob:b'));
    // Revoking first is the early-revoke bug: the tile is still loading the url when it dies.
    expect(log).toEqual(['adopt:blob:b', 'revoke:blob:a']);
  });

  it('re-setting the same url adopts without revoking or double-counting', () => {
    const { cache, revoked, log } = rig();
    cache.set('0-0', 'blob:a');
    cache.set('0-0', 'blob:a', () => log.push('adopt'));
    expect(revoked).toEqual([]);
    expect(log).toEqual(['adopt']);
    expect(cache.liveCount).toBe(1);
  });

  it('stores the placeholder data url but never revokes it', () => {
    const { cache, revoked } = rig();
    cache.set('0-0', PLACEHOLDER);
    expect(isObjectUrl(PLACEHOLDER)).toBe(false);
    expect(cache.liveCount).toBe(0);

    cache.set('0-0', 'blob:a');
    expect(revoked).toEqual([]);
    // A placeholder overwriting an object url is still an eviction of that object url.
    cache.set('0-0', PLACEHOLDER);
    expect(revoked).toEqual(['blob:a']);
    expect(cache.liveCount).toBe(0);
  });

  it('delete and clear revoke exactly what they drop', () => {
    const { cache, revoked } = rig();
    cache.set('0-0', 'blob:a');
    cache.set('0-1', 'blob:b');
    cache.set('1-0', PLACEHOLDER);

    cache.delete('0-0');
    expect(revoked).toEqual(['blob:a']);
    expect(cache.get('0-0')).toBeUndefined();
    // Deleting an absent key revokes nothing.
    cache.delete('0-0');
    expect(revoked).toEqual(['blob:a']);

    cache.clear();
    expect(revoked).toEqual(['blob:a', 'blob:b']);
    expect(cache.get('0-1')).toBeUndefined();
    expect(cache.liveCount).toBe(0);
  });

  it('re-keys a row removal: survivors shift and keep their urls, the dropped row is revoked', () => {
    const { cache, revoked } = rig();
    cache.set('0-0', 'blob:t0m0');
    cache.set('1-0', 'blob:t1m0');
    cache.set('1-1', 'blob:t1m1');
    cache.set('2-0', 'blob:t2m0');

    // Removing tuple 1: rows above shift down one, the removed row's urls belong to nobody.
    cache.rekey((t, m) => (t === 1 ? null : `${t > 1 ? t - 1 : t}-${m}`));

    expect(revoked.sort()).toEqual(['blob:t1m0', 'blob:t1m1']);
    expect(cache.get('0-0')).toBe('blob:t0m0');
    expect(cache.get('1-0')).toBe('blob:t2m0');
    expect(cache.get('2-0')).toBeUndefined();
    expect(cache.liveCount).toBe(2);
  });

  // A tile whose slot has no thumbnail must still hold a src that LOADS: Chromium leaves an
  // <img> whose src was removed in the broken state and paints its broken-image glyph there,
  // firing no error event, so the ✕ fallback never runs. The bytes are pinned here from outside
  // the implementation (PNG header + inflated pixel), not by comparing the constant to itself.
  it('the blank tile src is a decodable 1x1 fully transparent png', () => {
    const [prefix, b64] = BLANK_THUMB.split(',');
    expect(prefix).toBe('data:image/png;base64');
    const png = Buffer.from(b64, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1); // width
    expect(png.readUInt32BE(20)).toBe(1); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // truecolour + alpha
    // Fully transparent: an opaque blank would tint every not-yet-loaded tile instead of showing
    // the placeholder background. Scanline = one filter byte + RGBA.
    const idat = png.indexOf(Buffer.from('IDAT', 'latin1')) + 4;
    const len = png.readUInt32BE(idat - 8);
    expect([...inflateSync(png.subarray(idat, idat + len))]).toEqual([0, 0, 0, 0, 0]);
    // Never an object url, so nothing ever revokes it (it is shared by every empty tile).
    expect(isObjectUrl(BLANK_THUMB)).toBe(false);
  });

  it('re-keys a column insert without revoking anything', () => {
    const { cache, revoked } = rig();
    cache.set('0-0', 'blob:m0');
    cache.set('0-1', 'blob:m1');

    // A modality inserted at index 0 shifts every column up; no tile loses its url.
    cache.rekey((t, m) => `${t}-${m + 1}`);

    expect(revoked).toEqual([]);
    expect(cache.get('0-1')).toBe('blob:m0');
    expect(cache.get('0-2')).toBe('blob:m1');
    expect(cache.get('0-0')).toBeUndefined();
    expect(cache.liveCount).toBe(2);
  });
});
