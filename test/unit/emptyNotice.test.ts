import { describe, it, expect } from 'vitest';
import { emptyNotice } from '../../src/webview/emptyNotice';

const BASE = { tupleCount: 3, modalityCount: 2, missingRootPath: null };

describe('emptyNotice (the terminal state of an emptied comparison)', () => {
  it('says nothing while there is anything to draw', () => {
    expect(emptyNotice(BASE)).toBeNull();
  });

  // The per-file sweep path: the last row's removal takes the row, then its columns.
  it('speaks at zero rows, whatever the columns say', () => {
    expect(emptyNotice({ ...BASE, tupleCount: 0 })).not.toBeNull();
    expect(emptyNotice({ ...BASE, tupleCount: 0, modalityCount: 0 })).not.toBeNull();
  });

  // The modality-dir path: removeModalityStep strips every column but leaves the emptied rows behind.
  it('speaks at zero columns, though the emptied rows survive', () => {
    expect(emptyNotice({ ...BASE, modalityCount: 0 })).not.toBeNull();
  });

  it('names the folder when the host established the root is gone', () => {
    expect(emptyNotice({ tupleCount: 0, modalityCount: 0, missingRootPath: '/data/exp1' })).toEqual({
      title: 'Folder no longer exists',
      detail: '/data/exp1',
    });
  });

  // Two different facts to a user staring at an experiment output dir: an emptied folder is not a deleted one.
  it('distinguishes an emptied comparison from a folder that went away', () => {
    const emptied = emptyNotice({ tupleCount: 0, modalityCount: 0, missingRootPath: null });
    const gone = emptyNotice({ tupleCount: 0, modalityCount: 0, missingRootPath: '/data/exp1' });
    expect(emptied!.title).not.toEqual(gone!.title);
    expect(emptied!.detail).toMatch(/deleted/i);
    expect(emptied!.detail).not.toContain('/data/exp1');
  });

  // Recoverability in pure form: the folder's return is content's return, and content wins.
  it('falls silent again as soon as content returns, even while the root is still flagged missing', () => {
    expect(emptyNotice({ tupleCount: 1, modalityCount: 1, missingRootPath: '/data/exp1' })).toBeNull();
  });
});
