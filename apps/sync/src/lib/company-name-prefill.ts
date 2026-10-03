/** Email providers that must never be used to suggest a company name. */
export const COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'yahoo.com',
  'yahoo.co.uk',
  'proton.com',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'gmx.de',
  'yandex.com',
  'qq.com',
  '163.com',
  'mail.com',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'zoho.com',
  'tutanota.com',
  'tutanota.de',
  'tuta.com',
  'tuta.io',
  'pm.me',
  'msn.com',
  'ymail.com',
  'rocketmail.com',
  'web.de',
  'mail.ru',
  'naver.com',
  '126.com',
  'sina.com',
  'rediffmail.com',
  'inbox.com',
  'hushmail.com',
] as const;

const FREE_MAIL_DOMAINS = new Set<string>(COMPANY_NAME_PREFILL_FREE_MAIL_DOMAINS);
const GENERIC_SECOND_LEVEL_LABELS = new Set([
  'com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go',
]);
const MULTIPART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'co.nz',
  'org.nz',
  'co.jp',
  'co.in',
  'firm.in',
  'net.in',
  'org.in',
  'com.br',
  'com.cn',
  'com.sg',
  'com.mx',
  'com.tr',
  'co.za',
]);

/** Derive a readable company suggestion from a business email domain. */
export function companyNameFromEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1 || trimmed.indexOf('@') !== at) return null;

  const domain = trimmed.slice(at + 1).replace(/\.$/, '').toLowerCase();
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null;
  }

  const secondLevel = labels.at(-2)!;
  const countryCodeTld = labels.at(-1)!.length === 2;
  if (countryCodeTld && GENERIC_SECOND_LEVEL_LABELS.has(secondLevel)) return null;

  const suffix = labels.slice(-2).join('.');
  const registrableLabel = MULTIPART_PUBLIC_SUFFIXES.has(suffix)
    ? labels.at(-3)
    : secondLevel;
  if (!registrableLabel || FREE_MAIL_DOMAINS.has(domain)) return null;

  return registrableLabel
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export type CompanyNamePrefillStatus = 'offered_kept' | 'offered_edited' | 'not_offered';

export function companyNamePrefillStatus(
  offeredName: string | null,
  finalName: string,
): CompanyNamePrefillStatus {
  if (offeredName === null) return 'not_offered';
  return finalName.trim() === offeredName ? 'offered_kept' : 'offered_edited';
}
