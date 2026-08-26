// Pure mime policy (no vscode): which formats the webview decodes natively vs need backend conversion.

// Browser-decodable formats pass through as original bytes (docs/image-backends.md: passthrough-no-backend).
const PASSTHROUGH_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

/** Mime type for extensions the webview can decode natively, else undefined. */
export function passthroughMime(ext: string): string | undefined {
  return PASSTHROUGH_MIME[ext];
}
