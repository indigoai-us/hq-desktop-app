/** Human-readable label helpers for text that is rendered in the desktop UI. */

export interface PersonLabelSource {
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
}

export interface CompanyLabelSource {
  uid?: string | null;
  companyUid?: string | null;
  cloudUid?: string | null;
  name?: string | null;
  companyName?: string | null;
  displayName?: string | null;
  slug?: string | null;
}

const RAW_PERSON_UID = /\bprs_[A-Za-z0-9_-]+\b/g;
const RAW_COMPANY_UID = /\bcmp_[A-Za-z0-9_-]+\b/g;
const RAW_UID_ONLY = /^(?:prs_|cmp_)[A-Za-z0-9_-]+$/;

function readable(value: string | null | undefined): string | null {
  const label = value?.trim();
  return label && !RAW_UID_ONLY.test(label) ? label : null;
}

export function humanPersonLabel(
  person: PersonLabelSource,
  fallback = 'Unknown user',
): string {
  // TODO(display-name): needs historical-person API enrichment when current contacts omit labels.
  return (
    readable(person.displayName) ??
    readable(person.name) ??
    readable(person.email) ??
    fallback
  );
}

export function humanCompanyLabel(
  company: CompanyLabelSource,
  fallback = 'Company',
): string {
  // TODO(display-name): needs historical-company API enrichment for departed memberships.
  return (
    readable(company.companyName) ??
    readable(company.name) ??
    readable(company.displayName) ??
    readable(company.slug) ??
    fallback
  );
}

function companyUid(company: CompanyLabelSource): string | null {
  return company.uid?.trim() || company.companyUid?.trim() || company.cloudUid?.trim() || null;
}

export function sanitizeVisibleIdentifiers(
  value: string | null | undefined,
  options: {
    companies?: CompanyLabelSource[];
    personLabel?: string | null;
  } = {},
): string {
  let visible = value ?? '';
  const companies = [...(options.companies ?? [])]
    .map((company) => ({ uid: companyUid(company), label: humanCompanyLabel(company) }))
    .filter((company): company is { uid: string; label: string } => Boolean(company.uid))
    .sort((a, b) => b.uid.length - a.uid.length);

  for (const company of companies) {
    visible = visible.split(company.uid).join(company.label);
  }

  const personLabel = readable(options.personLabel) ?? 'your account';
  return visible.replace(RAW_PERSON_UID, personLabel).replace(RAW_COMPANY_UID, 'Company');
}
