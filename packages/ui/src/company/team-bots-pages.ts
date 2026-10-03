/**
 * Company Team and Bots pages (console-rail US-027).
 *
 * Pure data. The views paint from the last roster the shell already holds
 * and refresh in the background. Nothing here runs before shell-ready.
 *
 * Team invites and the Guest role sheet live here so Revoke can remove a
 * pending invite only after confirmation. Pause on Bots is the same gate.
 */

import type { CompanyApi, MessagingApi } from "@hq/platform";
import {
  memberKindFromUid,
  normalizeCompanyTeamTelemetry,
  type TeamMember,
  type TeamTelemetryView,
} from "./team-telemetry.js";

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export const TEAM_FILTERS = ["all", "humans", "bots"] as const;
export type TeamFilter = (typeof TEAM_FILTERS)[number];

export const INVITE_ROLES = ["owner", "admin", "member", "guest"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const BOT_FILTERS = ["all", "local", "cloud", "live"] as const;
export type BotFilter = (typeof BOT_FILTERS)[number];

export const JOB_ALERTS = ["dm", "none"] as const;
export type JobAlert = (typeof JOB_ALERTS)[number];

const teamCache = new Map<string, { view: TeamTelemetryView; invites: PendingInvite[] }>();

export function readTeamCache(slug: string): { view: TeamTelemetryView; invites: PendingInvite[] } | null {
  return teamCache.get(slug) ?? null;
}

export function writeTeamCache(
  slug: string,
  value: { view: TeamTelemetryView; invites: PendingInvite[] },
): void {
  if (slug) teamCache.set(slug, value);
}

export interface PendingInvite {
  id: string;
  email: string;
  role: InviteRole;
  /** Vault prefixes. Meaningful for Guest. */
  prefixes: string[];
  groups: string[];
  sentLabel: string;
  sentBy: string;
}

export interface InviteDraft {
  email: string;
  role: InviteRole;
  prefixesText: string;
  groups: string[];
}

export function emptyInviteDraft(): InviteDraft {
  return { email: "", role: "member", prefixesText: "", groups: [] };
}

export function inviteRoleLabel(role: InviteRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "guest") return "Guest";
  return "Member";
}

/** Guest shows vault prefixes and hides Groups. Other roles do the reverse. */
export function inviteRoleFields(role: InviteRole): {
  showPrefixes: boolean;
  showGroups: boolean;
} {
  return { showPrefixes: role === "guest", showGroups: role !== "guest" };
}

export function parsePrefixes(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function inviteSummary(invite: PendingInvite): string {
  const role = inviteRoleLabel(invite.role);
  const scope =
    invite.role === "guest" && invite.prefixes.length > 0
      ? ` · ${invite.prefixes.join(", ")}`
      : "";
  const by = invite.sentBy ? ` · sent ${invite.sentLabel} by ${invite.sentBy}` : ` · sent ${invite.sentLabel}`;
  return `${role}${scope}${by}`;
}

export function addInvite(list: readonly PendingInvite[], draft: InviteDraft, sentBy: string): PendingInvite[] {
  const email = draft.email.trim();
  if (!email) return [...list];
  const fields = inviteRoleFields(draft.role);
  const next: PendingInvite = {
    id: `inv-${email.toLowerCase()}`,
    email,
    role: draft.role,
    prefixes: fields.showPrefixes ? parsePrefixes(draft.prefixesText) : [],
    groups: fields.showGroups ? [...draft.groups] : [],
    sentLabel: "just now",
    sentBy,
  };
  return [next, ...list.filter((row) => row.id !== next.id)];
}

/**
 * Revoke removes the invite only when `confirmed` is true. A click that has
 * not passed the confirm sheet leaves the list unchanged.
 */
export function revokeInvite(
  list: readonly PendingInvite[],
  id: string,
  confirmed: boolean,
): PendingInvite[] {
  if (!confirmed) return [...list];
  return list.filter((row) => row.id !== id);
}

export function resendInvite(list: readonly PendingInvite[], id: string): PendingInvite[] {
  return list.map((row) => (row.id === id ? { ...row, sentLabel: "just now" } : row));
}

/** Pull pending invites out of the same telemetry payload TeamPanel reads. */
export function pendingInvitesFromTelemetry(raw: unknown): PendingInvite[] {
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  const list = Array.isArray(rec.invites)
    ? rec.invites
    : Array.isArray(rec.pendingInvites)
      ? rec.pendingInvites
      : [];
  const out: PendingInvite[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    if (!email) continue;
    const roleRaw = typeof row.role === "string" ? row.role.toLowerCase() : "member";
    const role: InviteRole = (INVITE_ROLES as readonly string[]).includes(roleRaw)
      ? (roleRaw as InviteRole)
      : "member";
    const prefixes = Array.isArray(row.prefixes)
      ? row.prefixes.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    const groups = Array.isArray(row.groups)
      ? row.groups.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    out.push({
      id: typeof row.id === "string" && row.id ? row.id : `inv-${email.toLowerCase()}`,
      email,
      role,
      prefixes,
      groups,
      sentLabel: typeof row.sentLabel === "string" ? row.sentLabel : "recently",
      sentBy: typeof row.sentBy === "string" ? row.sentBy : "",
    });
  }
  return out;
}

export interface BotListRow {
  uid: string;
  name: string;
  kind: "local" | "cloud";
  live: boolean;
  status: string;
  detail: string;
  canPause: boolean;
}

export function filterBots(rows: readonly BotListRow[], filter: BotFilter): BotListRow[] {
  if (filter === "local") return rows.filter((row) => row.kind === "local");
  if (filter === "cloud") return rows.filter((row) => row.kind === "cloud");
  if (filter === "live") return rows.filter((row) => row.live);
  return [...rows];
}

export interface ScheduledJob {
  id: string;
  name: string;
  cadence: string;
  alert: JobAlert;
  alertWho: string;
}

export function emptyJobDraft(name = ""): ScheduledJob {
  return { id: "job-draft", name, cadence: "daily 02:00", alert: "dm", alertWho: "" };
}

/** Pause applies only after the confirm sheet. */
export function pauseAllowed(confirmed: boolean): boolean {
  return confirmed;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Add the company's member roster (contacts scoped to the company, or the
 * members route) to the telemetry view. Telemetry only lists people with
 * recorded activity, so a quiet member, or a company whose telemetry route
 * returns nothing, would otherwise not appear on Team at all (QA-022).
 * Telemetry rows win for anyone listed in both.
 */
export function mergeRosterIntoTeamView(view: TeamTelemetryView, roster: readonly unknown[]): TeamTelemetryView {
  const known = new Set(view.members.map((member) => member.id));
  const added: TeamMember[] = [];
  for (const row of roster) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = str(rec.personUid) || str(rec.agentUid) || str(rec.uid) || str(rec.id);
    if (!id || known.has(id)) continue;
    known.add(id);
    const kindRaw = str(rec.kind) || str(rec.entityType) || str(rec.type);
    const kind =
      kindRaw === "agent" || kindRaw === "bot" || rec.isAgent === true || rec.isBot === true
        ? "agent"
        : kindRaw === "human" || kindRaw === "person"
          ? "human"
          : memberKindFromUid(id);
    const email = str(rec.email) || undefined;
    const role = str(rec.role) || str(rec.membershipRole) || undefined;
    added.push({
      id,
      displayName: str(rec.displayName) || str(rec.name) || email || id,
      email,
      kind,
      role,
      topSkills: [],
      activeProjects: [],
    });
  }
  if (added.length === 0) return view;
  const members = [...view.members, ...added];
  return {
    ...view,
    members,
    humans: members.filter((member) => member.kind !== "agent"),
    agents: members.filter((member) => member.kind === "agent"),
    empty: members.length === 0,
  };
}

/**
 * Seat counts from a Team view. A seat is a human member; hosted agents and
 * bots are counted separately. Team and the HQ Workforce card both read this
 * so the two never disagree (QA-046).
 */
export function seatCounts(view: Pick<TeamTelemetryView, "humans" | "agents">): { seats: number; agents: number } {
  return { seats: view.humans.length, agents: view.agents.length };
}

export interface CompanyTeamRead {
  view: TeamTelemetryView;
  /** Pending invites from the telemetry payload; empty when it had none. */
  invites: PendingInvite[];
  /** Plain-language failure. Set only when neither telemetry nor roster came back. */
  error: string | null;
}

/**
 * Read the company's Team: activity telemetry plus the member roster
 * (contacts scoped to the company uid, else the members route by slug).
 * Team and Company settings share this read and the Team cache.
 */
export async function readCompanyTeam(opts: {
  slug: string;
  companyUid?: string | null;
  company: Pick<CompanyApi, "getTeamTelemetry" | "listMembers">;
  messaging?: Pick<MessagingApi, "listContacts"> | null;
  /**
   * BLANK-3: the roster answers in about 0.3 s while the telemetry route can
   * take several seconds (3-4 s for 58 members, more under load). Called with
   * the roster-only view as soon as the roster arrives, so the page can show
   * people without waiting; the returned read still carries the full view.
   */
  onRoster?: (view: TeamTelemetryView) => void;
}): Promise<CompanyTeamRead> {
  const { slug, companyUid, company, messaging, onRoster } = opts;
  const empty: TeamTelemetryView = { members: [], humans: [], agents: [], error: null, empty: true };
  const rosterRead = async (): Promise<unknown[]> => {
    if (messaging && companyUid) {
      const res = await messaging.listContacts({ companyUid });
      if (res.ok && Array.isArray(res.value)) return res.value;
      if (!res.ok) console.warn("[team] company contacts read failed", res.message ?? res.reason);
    }
    const res = await company.listMembers(slug).catch((err: unknown) => {
      console.warn("[team] members read failed", err);
      return null;
    });
    return res && res.ok && Array.isArray(res.value) ? res.value : [];
  };
  let telemetrySettled = false;
  // A rejected telemetry read counts as a failed one, so it never fails the roster.
  const telemetry = Promise.resolve(company.getTeamTelemetry(slug))
    .catch((err: unknown) => {
      console.warn("[team] telemetry read rejected", err);
      return { ok: false as const, reason: "network" as const, message: "telemetry read rejected" };
    })
    .finally(() => {
      telemetrySettled = true;
    });
  const rosterFirst = rosterRead().then((rows) => {
    if (!telemetrySettled && rows.length > 0) onRoster?.(mergeRosterIntoTeamView(empty, rows));
    return rows;
  });
  const [rawRes, roster] = await Promise.all([telemetry, rosterFirst]);
  const labels: Record<string, { email?: string | null; displayName?: string | null }> = {};
  for (const row of roster) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.personUid === "string" ? rec.personUid : "";
    if (!id) continue;
    labels[id] = {
      email: typeof rec.email === "string" ? rec.email : null,
      displayName: typeof rec.displayName === "string" ? rec.displayName : null,
    };
  }
  if (!rawRes.ok && roster.length === 0) {
    console.warn("[team] telemetry read failed", rawRes.message ?? rawRes.reason);
    return { view: empty, invites: [], error: "Could not read the team." };
  }
  if (!rawRes.ok) console.warn("[team] telemetry read failed; showing the roster", rawRes.message ?? rawRes.reason);
  const fromTelemetry = rawRes.ok
    ? normalizeCompanyTeamTelemetry(rawRes.value, { memberLabelsById: labels })
    : empty;
  return {
    view: mergeRosterIntoTeamView(fromTelemetry, roster),
    invites: rawRes.ok ? pendingInvitesFromTelemetry(rawRes.value) : [],
    error: null,
  };
}
