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

export function withoutItem(
  items: readonly NotificationItem[],
  id: string,
): NotificationItem[] {
  return items.filter((item) => item.id !== id);
}
