import { describe, it, expect } from 'vitest';
import { winnersToNames } from '../../src/resultsFile';

describe('winnersToNames (real resultsFile code)', () => {
  it('Test 1: maps winner indices to durable modality names', () => {
    const named = winnersToNames(new Map([[0, 1], [2, 0]]), ['gt', 'pred']);
    expect([...named]).toEqual([[0, 'pred'], [2, 'gt']]);
  });

  it('Test 2: a winner whose modality index no longer resolves is dropped, never written', () => {
    const named = winnersToNames(new Map([[0, 5], [1, 0]]), ['gt']);
    expect([...named]).toEqual([[1, 'gt']]);
  });
});
