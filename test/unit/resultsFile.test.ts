import { describe, it, expect } from 'vitest';
import { parseResults, serializeResults } from '../../src/resultsFile';

// Pins the on-disk results.txt format (docs/standalone.md: results-format-shared): the expected
// strings below are committed literals, not round-trips through the serializer itself, so a header
// or line-format change fails here even though parse/serialize would still agree with each other.
describe('results file format (resultsFile.ts, real code)', () => {
  const FIXED_DATE = new Date('2026-01-02T03:04:05.678Z');

  it('serializes the exact header and vote lines (byte-pinned)', () => {
    const out = serializeResults(
      [{ name: 'scene_000' }, { name: 'scene_001' }, { name: 'scene_002' }],
      new Map([[0, 'GT'], [2, 'PRED']]),
      ['GT', 'PRED'],
      FIXED_DATE
    );
    expect(out).toBe(
      '# ImageCompare Results\n' +
      '# Generated: 2026-01-02T03:04:05.678Z\n' +
      '# Modalities: GT, PRED\n' +
      '#\n' +
      '# Format: tuple_key = winner_modality\n' +
      '# Delete a line to remove the vote, edit modality name to change vote\n' +
      '\n' +
      'scene_000 = GT\n' +
      'scene_002 = PRED\n'
    );
  });

  it('serializes only the header block when no votes exist (the caller decides deletion)', () => {
    const out = serializeResults([{ name: 'scene_000' }], new Map(), ['GT'], FIXED_DATE);
    expect(out).toBe(
      '# ImageCompare Results\n' +
      '# Generated: 2026-01-02T03:04:05.678Z\n' +
      '# Modalities: GT\n' +
      '#\n' +
      '# Format: tuple_key = winner_modality\n' +
      '# Delete a line to remove the vote, edit modality name to change vote\n' +
      '\n'
    );
  });

  it('round-trips through serialize and parse (votes keyed by tuple name)', () => {
    const out = serializeResults(
      [{ name: 'scene_000' }, { name: 'scene_001' }],
      new Map([[0, 'PRED'], [1, 'GT']]),
      ['GT', 'PRED']
    );
    const winners = parseResults(out);
    expect(winners.size).toBe(2);
    expect(winners.get('scene_000')).toBe('PRED');
    expect(winners.get('scene_001')).toBe('GT');
  });

  it('parses CRLF-encoded results text without stray \\r on keys or values', () => {
    const winners = parseResults(
      '# ImageCompare Results\r\n# comment\r\nscene_000 = GT\r\nscene_001 = PRED\r\n'
    );
    expect(winners.get('scene_000')).toBe('GT');
    expect(winners.get('scene_001')).toBe('PRED');
  });

  it('skips comments, blank lines, and malformed lines', () => {
    const winners = parseResults(
      '# a comment\n' +
      '\n' +
      '   \n' +
      'no_equals_sign\n' +
      '= only_value\n' +
      'only_key =\n' +
      'good = GT\n'
    );
    expect(winners.size).toBe(1);
    expect(winners.get('good')).toBe('GT');
  });

  it('keeps spaces inside tuple names and modality names, trimming only the edges', () => {
    const winners = parseResults('my scene 01 = deep model v2\n');
    expect(winners.get('my scene 01')).toBe('deep model v2');
  });
});
