/** Resolve writer attribution against the person's rail roster. Missing means personal. */
export interface BriefCompanyIdentity { uid: string; slug?: string | null }
export type BriefCompanyScope = readonly BriefCompanyIdentity[] | string | null;
export function briefCompanyUid(company: unknown, scope: BriefCompanyScope): string | null {
  // Compatibility for callers explicitly parsing an older single-company file.
  if (!Array.isArray(scope)) return typeof scope === "string" ? scope : null;
  if (typeof company !== "string" || !company.trim()) return null;
  return scope.find(c => c.uid === company.trim() || c.slug === company.trim())?.uid ?? null;
}
