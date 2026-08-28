/**
 * Per-company board scopes (US-008 AC4).
 *
 * Multi-company users get one board section per company membership, within
 * the STS credential policy budget. Companies the credential vend dropped
 * (2048-char IoT policy cap — see MeshClient's `droppedCompanies` event)
 * still render, flagged as realtime-degraded, NEVER silently hidden.
 */

export interface WorkspaceMembershipInput {
  companyUid?: string | null;
  company_uid?: string | null;
  uid?: string | null;
  slug?: string | null;
  name?: string | null;
  displayName?: string | null;
}

export interface CompanyBoardScope {
  companyUid: string;
  label: string;
  /** True when the STS policy budget excluded this company's thread topics. */
  realtimeDropped: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Build board scopes from workspace memberships + the latest droppedCompanies
 * emission. Dropped companies sort last so healthy boards paint first, but
 * they remain present and visibly flagged.
 */
export function buildCompanyScopes(
  workspaces: readonly WorkspaceMembershipInput[] | null | undefined,
  droppedCompanyUids: readonly string[] = [],
): CompanyBoardScope[] {
  const dropped = new Set(droppedCompanyUids);
  const seen = new Set<string>();
  const scopes: CompanyBoardScope[] = [];
  for (const w of workspaces ?? []) {
    const companyUid = str(w.companyUid) || str(w.company_uid) || str(w.uid);
    if (!companyUid || seen.has(companyUid)) continue;
    seen.add(companyUid);
    scopes.push({
      companyUid,
      label: str(w.displayName) || str(w.name) || str(w.slug) || companyUid,
      realtimeDropped: dropped.has(companyUid),
    });
  }
  // Surface dropped companies too even if they were not in the membership
  // list (defensive — the vend is authoritative about what got excluded).
  for (const uid of dropped) {
    if (!seen.has(uid)) {
      seen.add(uid);
      scopes.push({ companyUid: uid, label: uid, realtimeDropped: true });
    }
  }
  scopes.sort((a, b) =>
    a.realtimeDropped === b.realtimeDropped
      ? a.label.localeCompare(b.label)
      : a.realtimeDropped
        ? 1
        : -1,
  );
  return scopes;
}
