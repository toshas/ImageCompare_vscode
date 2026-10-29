/** Pure: the one rule for a path a published listing may name — the page applies it to imagecompare.json, the sharing script to everything it stages (docs/standalone.md: published-comparison-opens-itself). */

/** True for a relative path inside the page's directory: no leading `/`, no URL scheme, no backslash, no empty, `.` or `..` segment. */
export function isPublishedPath(file: unknown): file is string {
  return !(typeof file !== 'string' || /^\/|^[a-z][a-z0-9+.-]*:|\\/i.test(file) || file.split('/').some(s => s === '.' || s === '..' || s === ''));
}
