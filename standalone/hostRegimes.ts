/** Pure: what each hosting regime a published comparison names lets the page offer, and what publishing to it allows — one row per regime (docs/standalone.md: host-regime-is-one-table). */

/** The capability flags a published page states on `init` for its regime. */
export interface RegimeCapabilities {
  exportPptx: boolean;
  copyResults: boolean;
}

/** What publishing to a regime allows; byte limits are decimal (1 MB = 1 000 000 bytes), the conservative reading. */
export interface PublishLimits {
  /** Lower-case image extensions the host serves; anything else is refused at publish. */
  imageExtensions: readonly string[];
  /** Files per published version: page, manifest, thumbs files and images. */
  maxFilesPerVersion: number;
  maxBytesPerVersion: number;
  maxBytesPerImage: number;
  /** Per text file: the page, the manifest, each thumbs file. */
  maxBytesPerTextFile: number;
  maxFilesPerPublish: number;
  maxBytesPerPublish: number;
}

export interface HostRegime {
  capabilities: RegimeCapabilities;
  /** `null`: the regime imposes nothing the sharing script checks. */
  limits: PublishLimits | null;
}

const MB = 1_000_000;

/** The table; a new way of sharing is a new row (docs/standalone.md: host-regime-is-one-table). */
export const HOST_REGIMES = {
  static: {
    capabilities: { exportPptx: true, copyResults: true },
    limits: null,
  },
  'claude-artifact': {
    // Every page-initiated download is blocked in the artifact frame; the clipboard works for every viewer.
    capabilities: { exportPptx: false, copyResults: true },
    limits: {
      imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
      maxFilesPerVersion: 511,
      maxBytesPerVersion: 256 * MB,
      maxBytesPerImage: 15 * MB,
      maxBytesPerTextFile: 16 * MB,
      maxFilesPerPublish: 255,
      maxBytesPerPublish: 64 * MB,
    },
  },
} as const satisfies Record<string, HostRegime>;

export type HostRegimeName = keyof typeof HOST_REGIMES;

/** A manifest that names no `host` is published as plain static files. */
export const DEFAULT_HOST_REGIME: HostRegimeName = 'static';

export function isHostRegimeName(name: unknown): name is HostRegimeName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(HOST_REGIMES, name);
}

/** The named row; an unknown name throws rather than defaulting (docs/standalone.md: host-regime-is-one-table). */
export function hostRegime(name: string): HostRegime {
  if (!isHostRegimeName(name)) throw new Error(`unknown host ${JSON.stringify(name)} (known: ${Object.keys(HOST_REGIMES).join(', ')})`);
  return HOST_REGIMES[name];
}
