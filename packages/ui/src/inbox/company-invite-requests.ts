/**
 * Pending company invites as notification requests.
 *
 * The bell is the only Accept surface. Claim goes through the same
 * company.claimPendingInvite adapter the old Overview page used. A plan-limit
 * refusal stays a readable sentence plus an approved upgrade link.
 */

import {
  approvedPlanUpgradeUrl,
  isPlanLimitCode,
  type AdapterResult,
  type Json,
} from "@hq/platform";
import { pendingInviteWorkspaces, type Workspace } from "../chat/workspaces.js";
import { pinCompany } from "../shell/more-companies.js";
import { actorInitials, type NotificationItem } from "./notifications-model.js";

export const COMPANY_INVITE_SERVER_TYPE = "company_invite";

export function isCompanyInviteRequest(
  item: Pick<NotificationItem, "serverType">,
): boolean {
  const type = item.serverType.trim().toLowerCase();
  return type === "membership_invite" || type === COMPANY_INVITE_SERVER_TYPE;
}

export function companyInviteSlug(
  item: Pick<NotificationItem, "actionRef">,
): string {
  return (item.actionRef ?? "").trim();
}

function asWorkspace(row: unknown): Workspace | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Partial<Workspace>;
  if (rec.kind !== "company" || typeof rec.slug !== "string") return null;
  if (typeof rec.membershipStatus !== "string") return null;
  return {
    slug: rec.slug,
    displayName: typeof rec.displayName === "string" ? rec.displayName : rec.slug,
    kind: "company",
    state: rec.state === "synced" || rec.state === "cloud-only" || rec.state === "local-only" || rec.state === "broken" || rec.state === "personal"
      ? rec.state
      : "cloud-only",
    cloudUid: typeof rec.cloudUid === "string" ? rec.cloudUid : null,
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: rec.membershipStatus,
    role: null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: typeof rec.invitedBy === "string" ? rec.invitedBy : null,
    invitedAt: typeof rec.invitedAt === "string" ? rec.invitedAt : null,
  };
}

/** One request row per pending company the workspace list already loaded. */
export function companyInvitesFromWorkspaces(
  rows: readonly unknown[],
): NotificationItem[] {
  const workspaces = rows
    .map(asWorkspace)
    .filter((row): row is Workspace => row !== null);
  return pendingInviteWorkspaces(workspaces).map((workspace) => {
    const name = workspace.displayName || workspace.slug;
    return {
      id: `company-invite:${workspace.slug}`,
      serverType: COMPANY_INVITE_SERVER_TYPE,
      displayKind: "generic",
      typeIcon: "generic",
      actorName: name,
      actorInitials: actorInitials(name),
      verbText: `Invite to join ${name}`,
      contextLine: workspace.invitedBy
        ? `from ${workspace.invitedBy}`
        : "Pending company invite",
      status: "unread",
      createdAt: workspace.invitedAt ?? "",
      createdAtMs: workspace.invitedAt ? Date.parse(workspace.invitedAt) || 0 : 0,
      timestampLabel: "",
      actionKind: "accept-invite",
      actionRef: workspace.slug,
      actionButtons: [],
      targetRef: workspace.cloudUid,
      actorPersonUid: null,
      sourceEventId: null,
      actionUsed: false,
    };
  });
}

/**
 * Append workspace invites the inbox does not already carry for that slug.
 * A membership_invite row wins so Decline can ack the server id.
 */
export function mergeCompanyInvites(
  items: readonly NotificationItem[],
  invites: readonly NotificationItem[],
): NotificationItem[] {
  const slugs = new Set(
    items
      .filter(isCompanyInviteRequest)
      .map((item) => companyInviteSlug(item))
      .filter(Boolean),
  );
  const extra = invites.filter((item) => {
    const slug = companyInviteSlug(item);
    return Boolean(slug) && !slugs.has(slug);
  });
  return extra.length === 0 ? [...items] : [...items, ...extra];
}

export type InviteClaimOutcome =
  | { ok: true; companyUid: string; pinnedIds: string[] | null }
  | { ok: false; message: string; upgradeUrl: string | null };

/**
 * Join result for the popover. Pins only when the rail has room.
 * A full rail leaves the pin list unchanged. Plan-limit text never includes
 * the machine code.
 */
export function inviteClaimOutcome(
  claim: AdapterResult<Json>,
  companyUid: string,
  pinnedIds: readonly string[],
): InviteClaimOutcome {
  if (!claim.ok) {
    const upgradeUrl = approvedPlanUpgradeUrl(claim.upgradeUrl);
    // AUDIT-3c: the server's own text is logged, never shown.
    console.warn("[company-invite] join failed", claim.code, claim.message);
    const message =
      claim.code && isPlanLimitCode(claim.code)
        ? "Your plan limit is reached."
        : "Couldn't join the company. Try again.";
    return { ok: false, message, upgradeUrl };
  }
  const uid = companyUid.trim();
  if (!uid) return { ok: true, companyUid: "", pinnedIds: null };
  const pin = pinCompany(pinnedIds, uid);
  return {
    ok: true,
    companyUid: uid,
    pinnedIds: pin.status === "pinned" ? pin.ids : null,
  };
}
