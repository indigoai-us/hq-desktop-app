import { describe, expect, it } from 'vitest';
import { humanCompanyLabel, sanitizeVisibleIdentifiers } from './visible-labels';

describe('Windows visible labels', () => {
  it('uses company names and removes raw IDs from visible diagnostics', () => {
    expect(humanCompanyLabel({ companyName: null, slug: 'indigo' })).toBe('indigo');
    const visible = sanitizeVisibleIdentifiers('membership prs_1 cannot fetch cmp_1', {
      companies: [{ cloudUid: 'cmp_1', displayName: 'Indigo' }],
    });
    expect(visible).toBe('membership your account cannot fetch Indigo');
    expect(visible).not.toMatch(/\b(?:prs|cmp)_/);
  });
});
