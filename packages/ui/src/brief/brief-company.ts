/** Resolve writer attribution against the person's rail roster. Missing means personal. */
export interface BriefCompanyIdentity { uid: string; slug?: string | null }
export type BriefCompanyScope = readonly BriefCompanyIdentity[] | string | null;

/** Keep absent/personal attribution distinct from an explicitly excluded company. */
export function briefCompanyAllowed(company: unknown, scope: BriefCompanyScope): boolean {
  if (!Array.isArray(scope) || company == null || company === "") return true;
  return typeof company === "string" && scope.some(c => c.uid === company.trim() || c.slug === company.trim());
}

/** Legacy missing/null/empty attribution inherits its enclosing scope; excluded rows are discarded. */
export function scopeBriefCompanyData(value: unknown, scope: BriefCompanyScope, inherited: unknown = null, tagRecord = true): unknown {
  if (Array.isArray(value)) return value.map(row => scopeBriefCompanyData(row, scope, inherited)).filter(row => row !== undefined);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const origin = row.origin && typeof row.origin === "object" ? row.origin as Record<string, unknown> : {};
  const company = [row.company, origin.company, origin.companyUid, inherited].find(value => value != null && !(typeof value === "string" && !value.trim())) ?? null;
  if (!briefCompanyAllowed(company, scope)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(row)) {
    const scoped = scopeBriefCompanyData(child, scope, company, false);
    if (scoped !== undefined) result[key] = scoped;
  }
  if (tagRecord || row.company !== undefined) result.company = company;
  return result;
}
export function briefCompanyUid(company: unknown, scope: BriefCompanyScope): string | null {
  // Compatibility for callers explicitly parsing an older single-company file.
  if (!Array.isArray(scope)) return typeof scope === "string" ? scope : null;
  if (typeof company !== "string" || !company.trim()) return null;
  return scope.find(c => c.uid === company.trim() || c.slug === company.trim())?.uid ?? null;
}
