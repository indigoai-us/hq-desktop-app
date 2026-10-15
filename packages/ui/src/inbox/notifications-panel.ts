/**
 * Titlebar notifications popover (console-rail US-011).
 *
 * The list is the inbox the shell already cached. Opening the popover does
 * not fetch. Access grants are read or write only.
 */

import { isCompanyInviteRequest } from "./company-invite-requests.js";
import type { NotificationItem } from "./notifications-model.js";

export type NotificationPanelTab = "all" | "mentions" | "requests";

export type GrantLevel = "read" | "write";

/**
 * Scroll budget for the popover list. Rows are text and a 22 px mark.
 */
export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export function isMention(item: NotificationItem): boolean {
  return item.displayKind === "mention";
}

/** Access and share requests that can be granted or denied from the panel. */
export function isAccessRequest(item: NotificationItem): boolean {
  const type = item.serverType.toLowerCase();
  return (
    type.includes("access_request") ||
    type.includes("share_request") ||
    type.includes("vault_request") ||
    type === "grant_request"
  );
}

/** Access grants and pending company invites. Both live on the Requests tab. */
export function isRequestRow(item: NotificationItem): boolean {
  return isAccessRequest(item) || isCompanyInviteRequest(item);
}

/**
 * Read or write only. Anything else, including admin, is read.
 */
export function grantLevelFor(item: NotificationItem): GrantLevel {
  const blob = `${item.contextLine} ${item.verbText} ${item.serverType}`;
  return /\bwrite\b/i.test(blob) ? "write" : "read";
}

export function actionKindForGrant(level: GrantLevel): "grant_read" | "grant_write" {
  return level === "write" ? "grant_write" : "grant_read";
}

export function itemsForTab(
  items: readonly NotificationItem[],
  tab: NotificationPanelTab,
): NotificationItem[] {
  if (tab === "mentions") return items.filter(isMention);
  if (tab === "requests") return items.filter(isRequestRow);
  return [...items];
}

/**
 * Newest first, the order a reader expects from a notifications list
 * (feedback_f36dfa85). The cached feed is a merge of the NOTIF store, the DM
 * inbox, shares and local rows, each in its own source order, so the panel
 * cannot rely on the order it is handed. Rows with no timestamp (a pending
 * company invite with no `invitedAt`) are current state rather than history, so
 * they stay at the top. Ties keep their incoming order.
 */
export function newestFirst(
  items: readonly NotificationItem[],
): NotificationItem[] {
  const key = (item: NotificationItem): number =>
    Number.isFinite(item.createdAtMs) && item.createdAtMs > 0
      ? item.createdAtMs
      : Number.POSITIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index, at: key(item) }))
    .sort((a, b) =>
      a.at === b.at ? a.index - b.index : a.at > b.at ? -1 : 1,
    )
    .map((entry) => entry.item);
}

export function withoutItem(
  items: readonly NotificationItem[],
  id: string,
): NotificationItem[] {
  return items.filter((item) => item.id !== id);
}
