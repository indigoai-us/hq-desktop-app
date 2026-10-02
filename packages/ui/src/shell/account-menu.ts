/**
 * Account menu (console-rail US-010).
 *
 * The You avatar at the bottom of the rail opens this menu. Profile, Billing,
 * and Settings are placeholder frames until US-035 builds the pages. Company
 * role rows open that company's settings. Live state is read from the
 * PresenceStore snapshot the shell already mirrors — this module does no I/O.
 */

import type { PresenceSnapshot } from "@hq/core";

export type AccountPageId = "profile" | "billing" | "settings";

export interface AccountPlaceholder {
  id: AccountPageId;
  title: string;
  /** Story that replaces the placeholder with the real page. */
  story: string;
  summary: string;
}

export const ACCOUNT_PAGE_PREFIX = "account-";

/** US-035 owns the real Profile, Billing, and Settings pages. */
export const ACCOUNT_PLACEHOLDERS: Record<AccountPageId, AccountPlaceholder> = {
  profile: {
    id: "profile",
    title: "Profile",
    story: "US-035",
    summary: "Your name, email, and the companies you belong to.",
  },
  billing: {
    id: "billing",
    title: "Billing",
    story: "US-035",
    summary: "Plan, usage, and invoices. Manage payment opens in Stripe.",
  },
  settings: {
    id: "settings",
    title: "Settings",
    story: "US-035",
    summary: "Appearance, shortcuts, and this Mac.",
  },
};

export function accountPageId(id: AccountPageId): string {
  return `${ACCOUNT_PAGE_PREFIX}${id}`;
}

export function accountPlaceholderForPage(
  page: string | null | undefined,
): AccountPlaceholder | null {
  if (!page || !page.startsWith(ACCOUNT_PAGE_PREFIX)) return null;
  const id = page.slice(ACCOUNT_PAGE_PREFIX.length) as AccountPageId;
  return Object.prototype.hasOwnProperty.call(ACCOUNT_PLACEHOLDERS, id)
    ? ACCOUNT_PLACEHOLDERS[id]
    : null;
}

export interface AccountRoleInput {
  uid: string;
  label: string;
  role: string | null;
  kind?: string;
}

export interface AccountRoleRow {
  uid: string;
  label: string;
  role: string;
}

/**
 * The signed-in person's role in one company's member roster (the contacts
 * read scoped to the company uid, the same source Team lists). Accepts the
 * bare array or `{ contacts: [...] }`. Null when the person is not listed or
 * the row has no role.
 */
export function selfRoleFromRoster(payload: unknown, selfUid: string): string | null {
  const uid = selfUid.trim();
  if (!uid) return null;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { contacts?: unknown }).contacts)
      ? (payload as { contacts: unknown[] }).contacts
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = [rec.personUid, rec.uid, rec.id].find((v) => typeof v === "string" && v.trim());
    if (typeof id !== "string" || id.trim() !== uid) continue;
    const role = [rec.role, rec.membershipRole].find((v) => typeof v === "string" && v.trim());
    return typeof role === "string" ? role.trim() : null;
  }
  return null;
}

/**
 * One row per company membership that has a role. A role read from the
 * company's member roster wins over the cached membership role, so Profile
 * agrees with Team (QA-048).
 */
export function accountRoleRows(
  companies: readonly AccountRoleInput[],
  rosterRoles: Readonly<Record<string, string>> = {},
): AccountRoleRow[] {
  const rows: AccountRoleRow[] = [];
  for (const company of companies) {
    if (company.kind === "personal") continue;
    const uid = company.uid.trim();
    const role = rosterRoles[uid]?.trim() || company.role?.trim() || "";
    if (!uid || !role) continue;
    rows.push({
      uid,
      label: company.label.trim() || uid,
      role,
    });
  }
  return rows;
}

export interface OwnLiveWork {
  live: boolean;
  /** Hover text. Empty when PresenceStore has no online row for this person. */
  work: string;
}

/**
 * The signed-in person's live dot and hover line, from a PresenceStore
 * snapshot only. The first company where they are online wins.
 */
export function ownLiveWork(
  snapshot: PresenceSnapshot,
  selfUid: string,
  companyLabels: Readonly<Record<string, string>> = {},
): OwnLiveWork {
  const uid = selfUid.trim();
  if (!uid) return { live: false, work: "" };
  for (const [companyUid, actors] of snapshot) {
    if (actors.get(uid)?.status !== "online") continue;
    const name = companyLabels[companyUid]?.trim() || "a company";
    return { live: true, work: `Working in ${name}` };
  }
  return { live: false, work: "" };
}
