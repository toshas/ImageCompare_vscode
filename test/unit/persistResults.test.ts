import { describe, it, expect, vi } from 'vitest';
import { persistResults } from '../../src/resultsFile';

// The expected serialized bytes are committed literals, external to the implementation.
const TUPLES = [{ name: 'img_001' }, { name: 'img_002' }];
const MODALITIES = ['gt', 'pred'];

function recordingIo(log: string[], written: string[], opts: { failWrite?: boolean; failDelete?: boolean } = {}) {
  return {
    writeText: async (text: string) => {
      log.push('write');
      written.push(text);
      if (opts.failWrite) throw new Error('disk full');
    },
    deleteFile: async () => {
      log.push('delete');
      if (opts.failDelete) throw new Error('locked');
    },
  };
}

describe('results persist flow (real resultsFile code)', () => {
  it('empty winners delete the results file and never write', async () => {
    const log: string[] = [];
    await persistResults(TUPLES, MODALITIES, new Map(), recordingIo(log, []));
    expect(log).toEqual(['delete']);
  });

  it('winners serialize through the shared format and write exactly once, byte-pinned', async () => {
    const log: string[] = [];
    const written: string[] = [];
    const winners = new Map<number, number>([[0, 1], [1, 0]]);
    await persistResults(TUPLES, MODALITIES, winners, recordingIo(log, written), new Date('2024-01-02T03:04:05.000Z'));
    expect(log).toEqual(['write']);
    expect(written[0]).toBe(
      '# ImageCompare Results\n' +
      '# Generated: 2024-01-02T03:04:05.000Z\n' +
      '# Modalities: gt, pred\n' +
      '#\n' +
      '# Format: tuple_key = winner_modality\n' +
      '# Delete a line to remove the vote, edit modality name to change vote\n' +
      '\n' +
      'img_001 = pred\n' +
      'img_002 = gt\n'
    );
  });

  it('a winner whose column no longer resolves is dropped from the text, but the file is still written, never deleted', async () => {
    const log: string[] = [];
    const written: string[] = [];
    // winners.size > 0 decides write-vs-delete; name resolution only shapes the vote lines.
    await persistResults(TUPLES, MODALITIES, new Map([[0, 5]]), recordingIo(log, written), new Date('2024-01-02T03:04:05.000Z'));
    expect(log).toEqual(['write']);
    expect(written[0]).toBe(
      '# ImageCompare Results\n' +
      '# Generated: 2024-01-02T03:04:05.000Z\n' +
      '# Modalities: gt, pred\n' +
      '#\n' +
      '# Format: tuple_key = winner_modality\n' +
      '# Delete a line to remove the vote, edit modality name to change vote\n' +
      '\n'
    );
  });

  it('a failing delete is swallowed (file already absent is fine)', async () => {
    const log: string[] = [];
    await expect(
      persistResults(TUPLES, MODALITIES, new Map(), recordingIo(log, [], { failDelete: true }))
    ).resolves.toBeUndefined();
    expect(log).toEqual(['delete']);
  });

  it('a failing write is swallowed and logged (the results file is optional)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    await expect(
      persistResults(TUPLES, MODALITIES, new Map([[0, 0]]), recordingIo(log, [], { failWrite: true }))
    ).resolves.toBeUndefined();
    expect(log).toEqual(['write']);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
