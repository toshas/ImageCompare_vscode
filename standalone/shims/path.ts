/** Browser shim of node `path` (POSIX only) — just the surface sessionFile.ts and the adapter touch, kept complete by scripts/check-sidedness.mjs gate (d) (docs/standalone.md: shim-covers-bundled-calls). */

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

function normalizeSegments(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  return out;
}

export function join(...parts: string[]): string {
  const joined = parts.filter(p => p.length > 0).join('/');
  const abs = isAbsolute(joined);
  const norm = normalizeSegments(joined).join('/');
  return abs ? `/${norm}` : norm || '.';
}

export function resolve(...parts: string[]): string {
  let acc = '/';
  for (const part of parts) {
    acc = isAbsolute(part) ? part : `${acc}/${part}`;
  }
  return `/${normalizeSegments(acc).join('/')}`;
}

export function relative(from: string, to: string): string {
  const a = normalizeSegments(resolve(from));
  const b = normalizeSegments(resolve(to));
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const ups = new Array(a.length - common).fill('..');
  return [...ups, ...b.slice(common)].join('/');
}

export function dirname(p: string): string {
  const cut = p.replace(/\/+$/, '').lastIndexOf('/');
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return p.substring(0, cut);
}

export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || '';
}

export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.substring(dot) : '';
}
