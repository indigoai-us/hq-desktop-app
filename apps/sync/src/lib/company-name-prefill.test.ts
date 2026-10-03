import { describe, expect, it } from 'vitest';
import {
  COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS,
  companyNameFromEmail,
  companyNamePrefillStatus,
} from './company-name-prefill';

describe('companyNameFromEmail', () => {
  it('uses the registrable label before a known non-generic multipart suffix', () => {
    expect(companyNameFromEmail('owner@acme.firm.in')).toBe('Acme');
  });

  it('turns domain hyphens into title-cased words', () => {
    expect(companyNameFromEmail('owner@my-co.com')).toBe('My Co');
  });

  it('does not guess registrable labels when a generic second-level label precedes a ccTLD', () => {
    for (const domain of ['acme.com.ar', 'acme.co.kr', 'acme.com.br', 'acme.co.za']) {
      expect(companyNameFromEmail(`owner@${domain}`)).toBeNull();
    }
  });

  it('does not offer names for free-mail domains', () => {
    for (const domain of COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS) {
      expect(companyNameFromEmail(`owner@${domain}`)).toBeNull();
    }
    expect(companyNameFromEmail('owner@yahoo.co.uk')).toBeNull();
    for (const domain of [
      'mail.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'zoho.com',
      'tutanota.com', 'tuta.com', 'pm.me', 'msn.com', 'ymail.com',
      'rocketmail.com', 'web.de', 'mail.ru', 'naver.com', '126.com',
      'sina.com', 'rediffmail.com', 'inbox.com', 'hushmail.com',
    ]) {
      expect(COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS).toContain(domain);
    }
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
