import { describe, expect, it } from 'vitest';
import {
  humanCompanyLabel,
  humanPersonLabel,
  sanitizeVisibleIdentifiers,
} from './visible-labels';

describe('visible labels', () => {
  it('never uses an opaque person or company UID as a human label', () => {
    expect(humanPersonLabel({ displayName: 'prs_hidden', email: '' })).toBe('Unknown user');
    expect(humanCompanyLabel({ companyName: 'cmp_hidden', slug: '' })).toBe('Company');
  });

  it('uses human-readable fields already supplied by APIs', () => {
    expect(humanPersonLabel({ displayName: 'Ada', email: 'ada@example.com' })).toBe('Ada');
    expect(humanPersonLabel({ displayName: '', email: 'ada@example.com' })).toBe(
      'ada@example.com',
    );
    expect(humanCompanyLabel({ displayName: 'Analytical Engines', slug: 'engines' })).toBe(
      'Analytical Engines',
    );
  });

  it('replaces IDs in visible diagnostics with names or graceful fallbacks', () => {
    const visible = sanitizeVisibleIdentifiers(
      'fetch entity cmp_known for membership prs_member#cmp_unknown',
      {
        companies: [{ cloudUid: 'cmp_known', displayName: 'Indigo' }],
        personLabel: 'ada@example.com',
      },
    );
    expect(visible).toBe('fetch entity Indigo for membership ada@example.com#Company');
    expect(visible).not.toMatch(/\b(?:prs|cmp)_/);
  });
});
