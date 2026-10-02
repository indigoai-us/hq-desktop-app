/**
 * Company Team and Bots pages (console-rail US-027).
 *
 * Pure data. The views paint from the last roster the shell already holds
 * and refresh in the background. Nothing here runs before shell-ready.
 *
 * Team invites and the Guest role sheet live here so Revoke can remove a
 * pending invite only after confirmation. Pause on Bots is the same gate.
 */

import type { TeamTelemetryView } from "./team-telemetry.js";

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
