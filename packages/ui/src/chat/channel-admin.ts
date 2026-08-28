/**
 * Owner/admin channel helpers extracted from the desktop-alt
 * `chat/channel-provisioning.ts`. The provisioning loop itself is retired
 * (the server directory is the source of truth); only the US-021
 * "All company projects" gating pieces are ported here.
 */

import type { Channel } from "./channels";

export interface WorkspaceLike {
  slug: string;
  kind?: string;
  cloudUid?: string | null;
  role?: string | null;
  membershipStatus?: string | null;
}

export function roleIsAdminOrOwner(role: string | null | undefined): boolean {
  const r = (role ?? "").trim().toLowerCase();
  return r === "admin" || r === "owner";
}

export function adminCompanyUids(
  workspaces: ReadonlyArray<WorkspaceLike> | null | undefined,
): string[] {
  const uids: string[] = [];
  for (const w of workspaces ?? []) {
    if (w.kind === "personal") continue;
    const uid = w.cloudUid?.trim();
    if (!uid) continue;
    const active = (w.membershipStatus ?? "active").toLowerCase() === "active";
    if (active && roleIsAdminOrOwner(w.role) && !uids.includes(uid))
      uids.push(uid);
  }
  return uids;
}

/** Browse-only rows: fetched company project channels the caller is NOT in. */
export function browseOnlyCompanyProjectChannels(
  memberChannels: ReadonlyArray<Channel>,
  fetched: ReadonlyArray<Channel> | null | undefined,
): Channel[] {
  const memberIds = new Set(memberChannels.map((c) => c.channelId));
  return (fetched ?? []).filter(
    (c) => c.scope === "project" && !memberIds.has(c.channelId),
  );
}
