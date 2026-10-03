import { describe, expect, it } from 'vitest';
import {
  COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS,
  companyNameFromEmail,
  companyNamePrefillStatus,
} from './company-name-prefill';

describe('companyNameFromEmail', () => {
  it('uses the registrable label before a multipart public suffix', () => {
    expect(companyNameFromEmail('owner@acme.co.uk')).toBe('Acme');
    expect(companyNameFromEmail('owner@studio.com.au')).toBe('Studio');
  });

  it('turns domain hyphens into title-cased words', () => {
    expect(companyNameFromEmail('owner@my-co.com')).toBe('My Co');
  });

  it('does not offer names for free-mail domains', () => {
    for (const domain of COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS) {
      expect(companyNameFromEmail(`owner@${domain}.com`)).toBeNull();
    }
    expect(companyNameFromEmail('owner@yahoo.co.uk')).toBeNull();
  });

  it('returns null for missing or malformed email addresses', () => {
    expect(companyNameFromEmail(null)).toBeNull();
    expect(companyNameFromEmail('')).toBeNull();
    expect(companyNameFromEmail('no-at-sign')).toBeNull();
    expect(companyNameFromEmail('owner@localhost')).toBeNull();
  });

  it('leaves an empty field empty when prefill is not offered and records only bounded statuses', () => {
    expect(companyNamePrefillStatus(null, '')).toBe('not_offered');
    expect(companyNamePrefillStatus('Acme', 'Acme')).toBe('offered_kept');
    expect(companyNamePrefillStatus('Acme', '')).toBe('offered_edited');
  });
});
