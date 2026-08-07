/**
 * Pure, vscode-free naming of modality columns from directory paths. Extracted so the rule can be
 * tested against the shipped code rather than a copy (docs/testing.md).
 */

/**
 * Makes `name` unique against everything already taken, by ` (2)`, ` (3)`… Probing the set rather
 * than counting occurrences is what stops a generated suffix colliding with a directory literally
 * named `x (2)` (docs/session-files.md: unique-modality-names).
 */
export function uniquify(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  const unique = `${name} (${n})`;
  taken.add(unique);
  return unique;
}

/**
 * Shortest unique tail of each path, extended leftward until no two collide. A duplicate name would
 * silently merge two modalities downstream, so the fallback suffixes any repeat it cannot separate
 * (docs/session-files.md: unique-modality-names).
 */
export function disambiguateDirectoryNames<T extends { path: string }>(uris: T[]): Array<{ name: string; uri: T }> {
  const segments = uris.map(u => u.path.split('/').filter(s => s.length > 0));
  let depth = 1;
  const maxDepth = Math.min(...segments.map(s => s.length));

  while (depth < maxDepth) {
    const names = segments.map(s => s.slice(s.length - depth).join('/'));
    const hasDuplicates = new Set(names).size < names.length;
    if (!hasDuplicates) {
      return uris.map((uri, i) => ({ name: names[i], uri }));
    }
    depth++;
  }

  /* Equal tails with one path shorter still collide here; uniquify probes rather than counts. */
  const taken = new Set<string>();
  return uris.map((uri, i) => ({
    name: uniquify(segments[i].slice(segments[i].length - depth).join('/'), taken),
    uri
  }));
}
