import { describe, it, expect } from 'vitest';
import { nextPptxName } from '../../src/pptxDeck';

describe('pptx export naming (nextPptxName, real code)', () => {
  it('suggests comparison_01.pptx for an empty or unreadable directory listing', () => {
    expect(nextPptxName([])).toBe('comparison_01.pptx');
  });

  it('increments past the max existing number, not the count of files', () => {
    // Two files but max is 05: the next name must be 06, not 03.
    expect(nextPptxName(['comparison_05.pptx', 'comparison_02.pptx'])).toBe('comparison_06.pptx');
  });

  it('ignores files that do not match the comparison_NN.pptx pattern exactly', () => {
    expect(nextPptxName(['comparison_99.txt', 'my_comparison_07.pptx', 'comparison_.pptx', 'notes.md']))
      .toBe('comparison_01.pptx');
  });

  it('zero-pads to two digits and grows past 99 unpadded', () => {
    expect(nextPptxName(['comparison_09.pptx'])).toBe('comparison_10.pptx');
    expect(nextPptxName(['comparison_99.pptx'])).toBe('comparison_100.pptx');
  });
});
