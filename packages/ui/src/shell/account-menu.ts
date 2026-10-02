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

/** Shown on Profile when a company's roster gave no role for the person. */
export const UNKNOWN_ROLE = "\u2014";

/**
 * The signed-in person's role in one company's member roster (the contacts
 * read scoped to the company uid, the same source Team lists). Accepts the
 * bare array or `{ contacts: [...] }`. The row matches on person uid, or on
 * email when the person signed in under a second identity. Null when the
 * person is not listed or the row has no role.
 */
export function selfRoleFromRoster(
  payload: unknown,
  selfUid: string,
  selfEmail: string = "",
): string | null {
  const uid = selfUid.trim();
  const email = selfEmail.trim().toLowerCase();
  if (!uid && !email) return null;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { contacts?: unknown }).contacts)
      ? (payload as { contacts: unknown[] }).contacts
      : [];
  const roleOf = (rec: Record<string, unknown>): string | null => {
    const role = [rec.role, rec.membershipRole].find((v) => typeof v === "string" && v.trim());
    return typeof role === "string" ? role.trim() : null;
  };
  let byEmail: string | null = null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = [rec.personUid, rec.uid, rec.id].find((v) => typeof v === "string" && v.trim());
    if (uid && typeof id === "string" && id.trim() === uid) return roleOf(rec);
    const rowEmail = typeof rec.email === "string" ? rec.email.trim().toLowerCase() : "";
    if (email && rowEmail === email && byEmail == null) byEmail = roleOf(rec);
  }
  return byEmail;
}

/**
 * One row per company membership. The role comes only from the company's
 * member roster, the source Team lists, so Profile and Team agree (QA-048).
 * A company whose roster has not loaded, or gave no role for the person,
 * shows UNKNOWN_ROLE. The cached membership role is never shown: it said
 * owner for every company while Team said member.
 */
export function accountRoleRows(
  companies: readonly AccountRoleInput[],
  rosterRoles: Readonly<Record<string, string | null>> = {},
): AccountRoleRow[] {
  const rows: AccountRoleRow[] = [];
  for (const company of companies) {
    if (company.kind === "personal") continue;
    const uid = company.uid.trim();
    if (!uid) continue;
    rows.push({
      uid,
      label: company.label.trim() || uid,
      role: rosterRoles[uid]?.trim() || UNKNOWN_ROLE,
    });
  }
  return rows;
}

const ROSTER_ROLES_KEY = "hq.account.rosterRoles.v1";

/** Last roster roles read for Profile, keyed by person uid then company uid. */
export function readRosterRolesCache(selfUid: string): Record<string, string | null> {
  try {
    const raw = globalThis.localStorage?.getItem(ROSTER_ROLES_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, Record<string, string | null>>;
    const mine = all?.[selfUid];
    return mine && typeof mine === "object" ? { ...mine } : {};
  } catch (err) {
    console.warn("[account] roster role cache read failed", err);
    return {};
  }
}

export function writeRosterRolesCache(selfUid: string, roles: Record<string, string | null>): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const raw = storage.getItem(ROSTER_ROLES_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    storage.setItem(ROSTER_ROLES_KEY, JSON.stringify({ ...all, [selfUid]: roles }));
  } catch (err) {
    console.warn("[account] roster role cache write failed", err);
  }
}

export interface OwnLiveWork {
  live: boolean;
  /** Hover text. Empty when PresenceStore has no online row for this person. */
  work: string;
}

/**
 * The signed-in person's live dot and hover line. The dot comes from a
 * PresenceStore snapshot. "Working in" names the company shown in the main
 * pane (`activeCompanyUid`) whenever one is open, so every company change
 * (rail, More companies, Connections link, palette, deep link) updates it.
 * With no company open it falls back to the first company where the person
 * is online.
 */
export function ownLiveWork(
  snapshot: PresenceSnapshot,
  selfUid: string,
  companyLabels: Readonly<Record<string, string>> = {},
  activeCompanyUid: string | null = null,
): OwnLiveWork {
  const uid = selfUid.trim();
  if (!uid) return { live: false, work: "" };
  let live = false;
  let firstOnline: string | null = null;
  for (const [companyUid, actors] of snapshot) {
    if (actors.get(uid)?.status !== "online") continue;
    live = true;
    firstOnline ??= companyUid;
  }
  if (!live) return { live: false, work: "" };
  const active = activeCompanyUid?.trim() || null;
  const companyUid = active ?? firstOnline;
  const name = (companyUid && companyLabels[companyUid]?.trim()) || "a company";
  return { live: true, work: `Working in ${name}` };
}
