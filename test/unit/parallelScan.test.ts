import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FileType, Uri, workspace } from '../mocks/vscode';
import { scanForImages } from '../../src/fileService';

// The open path's cost over NFS is per-DIRECTORY latency, not per-file work: 11 modality dirs
// x ~350 ms of cold round trip is the ~20 s blank window this suite exists to keep closed. The
// fixtures are real temp dirs scanned by the real scanForImages (mode 2); only the latency and
// the entry order of `workspace.fs.readDirectory` are simulated, because a local tmpfs has no
// latency to parallelize away and node's readdir order is filesystem-defined.

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const realReadDirectory = workspace.fs.readDirectory;
afterEach(() => {
  workspace.fs.readDirectory = realReadDirectory;
});

/** N modality dirs, each holding the same image basenames, returned as URIs in creation order. */
function makeDirs(dirNames: string[], files: string[]): Uri[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-parscan-'));
  tmpRoots.push(root);
  return dirNames.map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    for (const f of files) fs.writeFileSync(path.join(dir, f), '');
    return Uri.file(dir);
  });
}

interface Hooks {
  /** Milliseconds of simulated round trip per directory basename. */
  delayMs?: (dirName: string) => number;
  /** Directory basenames whose listing rejects, as an unreadable dir does today. */
  failing?: Map<string, string>;
  /** Replaces the listed entry order, so a fixture can be "unsorted" deterministically. */
  order?: (dirName: string, entries: Array<[string, FileType]>) => Array<[string, FileType]>;
}

interface Probe {
  maxInFlight: number;
  completionOrder: string[];
}

function instrument(hooks: Hooks): Probe {
  const probe: Probe = { maxInFlight: 0, completionOrder: [] };
  let inFlight = 0;
  workspace.fs.readDirectory = async (uri: Uri): Promise<Array<[string, FileType]>> => {
    const name = uri.path.split('/').pop() ?? '';
    inFlight++;
    probe.maxInFlight = Math.max(probe.maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, hooks.delayMs ? hooks.delayMs(name) : 0));
      const failure = hooks.failing?.get(name);
      if (failure) throw new Error(failure);
      const entries = await realReadDirectory(uri);
      return hooks.order ? hooks.order(name, entries) : entries;
    } finally {
      inFlight--;
      probe.completionOrder.push(name);
    }
  };
  return probe;
}

const names = (n: number, prefix = 'mod'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

describe('scanForImages: modality directories are listed concurrently', () => {
  // 11 dirs is the field case. Serial, this is 11 x 40 ms; concurrent, it is one 40 ms wait.
  it('issues all 11 directory listings at once instead of one after another', async () => {
    const dirs = makeDirs(names(11), ['img_001.png', 'img_002.png']);
    const probe = instrument({ delayMs: () => 40 });

    const started = Date.now();
    const result = await scanForImages(dirs as never);
    const elapsed = Date.now() - started;

    expect(result.modalities.length).toBe(11);
    expect(probe.maxInFlight).toBe(11);
    expect(elapsed).toBeLessThan(11 * 40 * 0.5);
  });

  // Mode 1 (one root, subdirs as modalities) reaches the same listing helper, one level down:
  // the root's own listing is serial and first, then the six subdirs overlap.
  it('overlaps the subdirectory listings of a mode-1 root as well', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-parscan-mode1-'));
    tmpRoots.push(root);
    for (const name of names(6)) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'img_001.png'), '');
    }
    const probe = instrument({ delayMs: () => 30 });

    const result = await scanForImages([Uri.file(root)] as never);

    expect(result.mode).toBe(1);
    expect(result.modalities).toEqual(names(6));
    expect(probe.maxInFlight).toBe(6);
  });

  // The fan-out is capped so a session naming dozens of directories does not open with a
  // thundering herd; 40 dirs must therefore run in waves, never all at once. The cap is pinned
  // EXACTLY: an upper bound alone leaves DIR_LISTING_CONCURRENCY free to fall to the 11 the
  // field case needs, which is a silent halving of the open-path parallelism no test would see.
  it('caps the fan-out at exactly 16 and lists in waves for a 40-directory session', async () => {
    const dirs = makeDirs(names(40), ['img_001.png']);
    const probe = instrument({ delayMs: () => 5 });

    const result = await scanForImages(dirs as never);

    expect(probe.maxInFlight).toBe(16);
    expect(result.modalities).toEqual(names(40));
  });
});

describe('scanForImages: modality order is the input order, not the completion order', () => {
  // Slowest first: the dirs finish in exactly reverse input order, so an implementation that
  // assembles the Map as listings land produces the reversed column order.
  it('keeps the caller order when the directories resolve slowest-first', async () => {
    const dirNames = names(5);
    const dirs = makeDirs(dirNames, ['img_001.png', 'img_002.png']);
    const probe = instrument({ delayMs: (name) => (dirNames.length - dirNames.indexOf(name)) * 20 });

    const result = await scanForImages(dirs as never);

    expect(probe.completionOrder).toEqual([...dirNames].reverse());
    expect(result.modalities).toEqual(dirNames);
    for (const tuple of result.tuples) {
      expect(tuple.images.map((i) => i.modality)).toEqual(dirNames);
    }
  });

  // Same trap across the cap boundary: with 20 dirs the listings land in several waves, and
  // within each wave out of order.
  it('keeps the caller order across concurrency waves', async () => {
    const dirNames = names(20);
    const dirs = makeDirs(dirNames, ['img_001.png']);
    instrument({ delayMs: (name) => (dirNames.length - dirNames.indexOf(name)) * 2 });

    const result = await scanForImages(dirs as never);

    expect(result.modalities).toEqual(dirNames);
  });
});

describe('scanForImages: the listing loop behaves as it did when it was serial', () => {
  it('omits a directory with no images from the modality list', async () => {
    const dirs = makeDirs(['GT', 'EMPTY', 'pred'], []);
    for (const dir of dirs) {
      if (dir.path.endsWith('/EMPTY')) continue;
      fs.writeFileSync(path.join(dir.fsPath, 'img_001.png'), '');
      fs.writeFileSync(path.join(dir.fsPath, 'notes.txt'), '');
    }
    instrument({ delayMs: (name) => (name === 'GT' ? 30 : 0) });

    const result = await scanForImages(dirs as never);

    expect(result.modalities).toEqual(['GT', 'pred']);
  });

  it('rejects when only one directory of a concurrent listing has images', async () => {
    const dirs = makeDirs(['GT', 'EMPTY'], []);
    fs.writeFileSync(path.join(dirs[0].fsPath, 'img_001.png'), '');
    instrument({ delayMs: (name) => (name === 'GT' ? 20 : 0) });

    await expect(scanForImages(dirs as never)).rejects.toThrow(/must each contain images/);
  });

  // The tie-break comparator is greedy from candidate 0, and candidate order is the reference
  // array's order — so with img_c tied against img_a and img_b on every rule (same length, LCS
  // 4 to both), the query lands on whichever comes first. Only the per-directory natural sort
  // makes that img_a while the listing hands back b before a.
  it('sorts each directory naturally, whatever order the listing returns', async () => {
    const dirs = makeDirs(['GT', 'query'], []);
    fs.writeFileSync(path.join(dirs[0].fsPath, 'img_a.png'), '');
    fs.writeFileSync(path.join(dirs[0].fsPath, 'img_b.png'), '');
    fs.writeFileSync(path.join(dirs[1].fsPath, 'img_c.png'), '');
    instrument({ order: (_name, entries) => [...entries].sort((x, y) => (x[0] < y[0] ? 1 : -1)) });

    const result = await scanForImages(dirs as never);

    const withQuery = result.tuples.filter((t) => t.images.some((i) => i.modality === 'query'));
    expect(withQuery.length).toBe(1);
    expect(withQuery[0].images.find((i) => i.modality === 'GT')?.name).toBe('img_a.png');
  });

  it('propagates a listing failure instead of skipping the directory', async () => {
    const dirs = makeDirs(['GT', 'broken', 'pred'], ['img_001.png']);
    instrument({ failing: new Map([['broken', 'EACCES: broken']]) });

    await expect(scanForImages(dirs as never)).rejects.toThrow(/EACCES: broken/);
  });

  // Serially, the first failing directory in input order was the one that threw — a later,
  // faster failure never got the chance. Concurrency must not change which error the user sees.
  it('propagates the earliest failing directory when a later one fails first', async () => {
    const dirs = makeDirs(['GT', 'slowbroken', 'pred', 'fastbroken'], ['img_001.png']);
    instrument({
      delayMs: (name) => (name === 'slowbroken' ? 40 : 0),
      failing: new Map([['slowbroken', 'EACCES: slowbroken'], ['fastbroken', 'EACCES: fastbroken']]),
    });

    await expect(scanForImages(dirs as never)).rejects.toThrow(/EACCES: slowbroken/);
  });
});
