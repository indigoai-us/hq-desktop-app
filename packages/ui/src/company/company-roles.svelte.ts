/**
 * OWNER-R9/R20/R24: the signed-in person's role in each company, read from
 * the membership roster (`GET /membership/company/{uid}`) — the contacts read
 * the app used before carries no role and leaves the caller out. One read per
 * company per session; Profile, Team and the company panel share it.
 */
import type { CompanyApi } from "@hq/platform";

export type CompanyRole = "Owner" | "Admin" | "Member" | "Guest";

const roles = $state<Record<string, CompanyRole | null>>({});
const inflight = new Set<string>();

function label(raw: unknown): CompanyRole | null {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (key === "owner") return "Owner";
  if (key === "admin") return "Admin";
  if (key === "member") return "Member";
  if (key === "guest") return "Guest";
  return null;
}

/** The caller's role in a company, or undefined while unknown. */
export function callerRole(companyUid: string | null | undefined): CompanyRole | null | undefined {
  if (!companyUid) return undefined;
  return companyUid in roles ? roles[companyUid] : undefined;
}

export function loadCallerRole(opts: {
  companyUid: string | null | undefined;
  selfUid?: string | null;
  selfEmail?: string | null;
  company?: Pick<CompanyApi, "listCompanyMemberships"> | null;
}): void {
  const { companyUid, selfUid, selfEmail, company } = opts;
  if (!companyUid || !company?.listCompanyMemberships) return;
  if (companyUid in roles || inflight.has(companyUid)) return;
  if (!selfUid && !selfEmail) return;
  inflight.add(companyUid);
  void Promise.resolve(company.listCompanyMemberships(companyUid))
    .then((res) => {
      if (!res.ok) {
        console.warn("[roles] membership read failed", companyUid, res.message ?? res.reason);
        return;
      }
      const value = res.value as { members?: unknown };
      const list = Array.isArray(value?.members) ? (value.members as Record<string, unknown>[]) : [];
      const email = (selfEmail ?? "").trim().toLowerCase();
      const mine = list.find(
        (m) =>
          (selfUid && m.personUid === selfUid) ||
          (email && typeof m.personEmail === "string" && m.personEmail.trim().toLowerCase() === email),
      );
      roles[companyUid] = mine ? label(mine.role) : null;
    })
    .catch((err: unknown) => {
      console.warn("[roles] membership read rejected", companyUid, err);
    })
    .finally(() => {
      inflight.delete(companyUid);
    });
}

/** Tests only. */
export function resetCallerRoles(): void {
  for (const key of Object.keys(roles)) delete roles[key];
  inflight.clear();
}
