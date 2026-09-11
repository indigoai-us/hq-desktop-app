import { describe, expect, it } from 'vitest';
import { citedLabel } from './ideas-cited-label';

describe('hq-idea-board citedLabel', () => {
  it('renders nothing for an uncited capture', () => {
    expect(citedLabel(0)).toBeNull();
  });

  it('renders the count with a multiplication sign', () => {
    expect(citedLabel(2)).toBe('Cited 2× by agents');
    expect(citedLabel(1)).toBe('Cited 1× by agents');
  });

  it('ignores negative, fractional, and non-finite counts', () => {
    expect(citedLabel(-1)).toBeNull();
    expect(citedLabel(Number.NaN)).toBeNull();
    expect(citedLabel(Number.POSITIVE_INFINITY)).toBeNull();
    expect(citedLabel(2.7)).toBe('Cited 2× by agents');
  });
});
