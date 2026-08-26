import { describe, it, expect } from 'vitest';
import {
  BarrenMemo,
  diffSnapshots,
  pairRenames,
  planDirSweep,
  planSweepDirs,
  pruneBarrenMemos,
  recordDirListing,
} from '../../src/pollPlan';

// Fixture literals are external to the implementation: expected listings, diffs and pairings are
// written out by hand from the documented rules (docs/file-watching.md), never derived from the code.

describe('pollPlan planSweepDirs (real pollPlan code)', () => {
  it('Test 1: a dir with no memo is listed', () => {
    const memos = new Map<string, BarrenMemo>();
    expect(planSweepDirs([{ dir: '/base/logs', mtime: 100 }], memos, 6)).toEqual(['/base/logs']);
  });

  it('Test 2: an unchanged-mtime memo with budget left is skipped and the skip spends one budget unit', () => {
    const memos = new Map<string, BarrenMemo>([['/base/logs', { mtime: 100, sweeps: 0 }]]);
    expect(planSweepDirs([{ dir: '/base/logs', mtime: 100 }], memos, 6)).toEqual([]);
    expect(memos.get('/base/logs')).toEqual({ mtime: 100, sweeps: 1 });
  });

  it('Test 3: an advanced mtime forces a re-listing even with budget left', () => {
    const memos = new Map<string, BarrenMemo>([['/base/logs', { mtime: 100, sweeps: 0 }]]);
    expect(planSweepDirs([{ dir: '/base/logs', mtime: 101 }], memos, 6)).toEqual(['/base/logs']);
  });

  it('Test 4: a never-advancing mtime is re-listed once the sweep budget is spent', () => {
    const memos = new Map<string, BarrenMemo>([['/base/ckpt', { mtime: 100, sweeps: 0 }]]);
    // Budget 3: three skips, then the pinned mtime no longer counts as proof of emptiness.
    expect(planSweepDirs([{ dir: '/base/ckpt', mtime: 100 }], memos, 3)).toEqual([]);
    expect(planSweepDirs([{ dir: '/base/ckpt', mtime: 100 }], memos, 3)).toEqual([]);
    expect(planSweepDirs([{ dir: '/base/ckpt', mtime: 100 }], memos, 3)).toEqual([]);
    expect(planSweepDirs([{ dir: '/base/ckpt', mtime: 100 }], memos, 3)).toEqual(['/base/ckpt']);
  });

  it('Test 5: a batch keeps only the dirs that need listing, in candidate order', () => {
    const memos = new Map<string, BarrenMemo>([
      ['/base/skip', { mtime: 5, sweeps: 0 }],
      ['/base/stale', { mtime: 5, sweeps: 0 }],
    ]);
    const out = planSweepDirs(
      [
        { dir: '/base/new', mtime: 1 },
        { dir: '/base/skip', mtime: 5 },
        { dir: '/base/stale', mtime: 9 },
      ],
      memos,
      6
    );
    expect(out).toEqual(['/base/new', '/base/stale']);
  });

  it('Test 6: recordDirListing memoizes an image-less dir with a fresh budget and forgets one with images', () => {
    const memos = new Map<string, BarrenMemo>();
    recordDirListing(memos, '/base/logs', 100, false);
    expect(memos.get('/base/logs')).toEqual({ mtime: 100, sweeps: 0 });
    recordDirListing(memos, '/base/logs', 100, true);
    expect(memos.has('/base/logs')).toBe(false);
  });

  it('Test 7: recordDirListing after a spent budget resets the memo (still image-less, still skippable)', () => {
    const memos = new Map<string, BarrenMemo>([['/base/logs', { mtime: 100, sweeps: 3 }]]);
    recordDirListing(memos, '/base/logs', 100, false);
    expect(memos.get('/base/logs')).toEqual({ mtime: 100, sweeps: 0 });
  });

  it('Test 8: pruneBarrenMemos drops exactly the memos whose dirs are gone', () => {
    const memos = new Map<string, BarrenMemo>([
      ['/base/live', { mtime: 1, sweeps: 0 }],
      ['/base/gone', { mtime: 2, sweeps: 1 }],
    ]);
    pruneBarrenMemos(memos, new Set(['/base/live']));
    expect([...memos.keys()]).toEqual(['/base/live']);
  });
});

describe('pollPlan diffSnapshots (real pollPlan code)', () => {
  it('Test 1: name-set diff yields added and removed, in listing order', () => {
    const diff = diffSnapshots(
      [{ name: 'a.png' }, { name: 'b.png' }, { name: 'c.png' }],
      [{ name: 'c.png' }, { name: 'd.png' }, { name: 'a.png' }, { name: 'e.png' }]
    );
    expect(diff.added).toEqual(['d.png', 'e.png']);
    expect(diff.removed).toEqual(['b.png']);
    expect(diff.changed).toEqual([]);
  });

  it('Test 2: a changed mtime on a name present in both sides reports changed', () => {
    const diff = diffSnapshots(
      [{ name: 'a.png', mtime: 100, size: 10 }],
      [{ name: 'a.png', mtime: 200, size: 10 }]
    );
    expect(diff).toEqual({ added: [], removed: [], changed: ['a.png'] });
  });

  it('Test 3: a changed size alone reports changed (mtime granularity can hide a rewrite)', () => {
    const diff = diffSnapshots(
      [{ name: 'a.png', mtime: 100, size: 10 }],
      [{ name: 'a.png', mtime: 100, size: 11 }]
    );
    expect(diff.changed).toEqual(['a.png']);
  });

  it('Test 4: identical fingerprints report nothing', () => {
    const diff = diffSnapshots(
      [{ name: 'a.png', mtime: 100, size: 10 }],
      [{ name: 'a.png', mtime: 100, size: 10 }]
    );
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it('Test 5: the lazy-fingerprint contract — a side missing its fingerprint is never "changed"', () => {
    // Names-only next (fingerprints not fetched yet): must not misread absence as a change.
    expect(diffSnapshots([{ name: 'a.png', mtime: 100, size: 10 }], [{ name: 'a.png' }]).changed).toEqual([]);
    // Names-only prev (a file first seen last cycle without a baseline): same rule.
    expect(diffSnapshots([{ name: 'a.png' }], [{ name: 'a.png', mtime: 100, size: 10 }]).changed).toEqual([]);
    // Partial fingerprints compare only the fields both sides carry.
    expect(diffSnapshots([{ name: 'a.png', size: 10 }], [{ name: 'a.png', mtime: 5, size: 12 }]).changed).toEqual(['a.png']);
    expect(diffSnapshots([{ name: 'a.png', size: 10 }], [{ name: 'a.png', mtime: 5, size: 10 }]).changed).toEqual([]);
  });

  it('Test 6: an added name is never also reported changed', () => {
    const diff = diffSnapshots([], [{ name: 'a.png', mtime: 1, size: 2 }]);
    expect(diff.added).toEqual(['a.png']);
    expect(diff.changed).toEqual([]);
  });
});

describe('pollPlan planDirSweep (real pollPlan code)', () => {
  const file = (name: string) => ({ name, isFile: true });

  it('Test 1: an unchanged directory yields no arrivals and — the point of the change — no candidates to check', () => {
    const known = ['a.png', 'b.png', 'c.png'];
    expect(planDirSweep(known, known.map(file))).toEqual({ added: [], candidates: [] });
  });

  it('Test 2: a name that left the listing is a candidate, not a report', () => {
    expect(planDirSweep(['a.png', 'b.png'], [file('a.png')])).toEqual({ added: [], candidates: ['b.png'] });
  });

  it('Test 3: an unknown listed name is an arrival', () => {
    expect(planDirSweep(['a.png'], [file('a.png'), file('new.png')])).toEqual({ added: ['new.png'], candidates: [] });
  });

  it('Test 4: a directory that could not be listed falls every tracked name back to its own check', () => {
    expect(planDirSweep(['a.png', 'b.png'], undefined)).toEqual({ added: [], candidates: ['a.png', 'b.png'] });
  });

  it('Test 5: an empty listing is not the same thing as an unlistable one — but both yield the same candidates', () => {
    expect(planDirSweep(['a.png'], [])).toEqual({ added: [], candidates: ['a.png'] });
  });

  it('Test 6: a listed name that is not a file — a dangling symlink — stays a candidate, and is never an arrival', () => {
    // The disk provider types a link by its target, so a broken link lists as Unknown|SymbolicLink.
    expect(planDirSweep(['a.png'], [{ name: 'a.png', isFile: false }])).toEqual({ added: [], candidates: ['a.png'] });
    expect(planDirSweep([], [{ name: 'new.png', isFile: false }])).toEqual({ added: [], candidates: [] });
  });
});

describe('pollPlan pairRenames (real pollPlan code)', () => {
  const entry = (dir: string, name: string, modality = 'gt') => ({ dir, name, modality });

  it('Test 1: one removed and one added in the same dir pair as a rename', () => {
    const out = pairRenames([entry('/r/gt', 'old.png')], [entry('/r/gt', 'new.png')], true);
    expect(out.renames).toEqual([{ from: entry('/r/gt', 'old.png'), to: entry('/r/gt', 'new.png') }]);
    expect(out.removed).toEqual([]);
    expect(out.added).toEqual([]);
  });

  it('Test 2: two removals in the same dir are never guessed — the add stays an add, both removals stand', () => {
    const removed = [entry('/r/gt', 'a.png'), entry('/r/gt', 'b.png')];
    const out = pairRenames(removed, [entry('/r/gt', 'c.png')], true);
    expect(out.renames).toEqual([]);
    expect(out.removed).toEqual(removed);
    expect(out.added).toEqual([entry('/r/gt', 'c.png')]);
  });

  it('Test 3: a sibling-dir identical filename pairs only in multi-tuple mode', () => {
    const removed = [entry('/r/old_gt', 'img.png')];
    const added = [entry('/r/new_gt', 'img.png')];
    expect(pairRenames(removed, added, true).renames).toHaveLength(1);
    const single = pairRenames(removed, added, false);
    expect(single.renames).toEqual([]);
    expect(single.removed).toEqual(removed);
    expect(single.added).toEqual(added);
  });

  it('Test 4: adds claim sequentially — the first claims the lone pending removal, the second stays an add', () => {
    const out = pairRenames(
      [entry('/r/gt', 'old.png')],
      [entry('/r/gt', 'new1.png'), entry('/r/gt', 'new2.png')],
      true
    );
    expect(out.renames).toEqual([{ from: entry('/r/gt', 'old.png'), to: entry('/r/gt', 'new1.png') }]);
    expect(out.added).toEqual([entry('/r/gt', 'new2.png')]);
    expect(out.removed).toEqual([]);
  });

  it('Test 5: the carrier shape survives pairing (extra fields flow through untouched)', () => {
    const out = pairRenames(
      [entry('/r/pred', 'old.png', 'pred')],
      [entry('/r/pred', 'new.png', 'pred')],
      true
    );
    expect(out.renames[0].from.modality).toBe('pred');
    expect(out.renames[0].to.modality).toBe('pred');
  });
});
