import { describe, expect, it } from "vitest";
import { isCompanyInviteRequest } from "./company-invite-requests.js";
import type { NotificationItem } from "./notifications-model.js";
import {
  actionKindForGrant,
  grantLevelFor,
  isAccessRequest,
  isRequestRow,
  itemsForTab,
  withoutItem,
} from "./notifications-panel.js";

function item(partial: Partial<NotificationItem> & Pick<NotificationItem, "id" | "serverType">): NotificationItem {
  return {
    displayKind: "generic",
    typeIcon: "generic",
    actorName: "Hassaan",
    actorInitials: "HS",
    verbText: "requested access",
    contextLine: "projects/hq (read)",
    status: "unread",
    createdAt: "",
    createdAtMs: 0,
    timestampLabel: "",
    actionKind: null,
    actionRef: "path",
    actionButtons: [],
    targetRef: null,
    actorPersonUid: null,
    sourceEventId: null,
    actionUsed: false,
    ...partial,
  };
}

describe("notifications panel", () => {
  const request = item({ id: "r", serverType: "access_request", contextLine: "vault (write)" });
  const mention = item({
    id: "m",
    serverType: "mention",
    displayKind: "mention",
    contextLine: "#hq",
  });

  it("keeps requests on the Requests tab and mentions on Mentions", () => {
    const all = [request, mention];
    expect(itemsForTab(all, "requests").map((row) => row.id)).toEqual(["r"]);
    expect(itemsForTab(all, "mentions").map((row) => row.id)).toEqual(["m"]);
    expect(isAccessRequest(mention)).toBe(false);
  });

  it("puts a company invite on Requests and leaves it off access grants", () => {
    const invite = item({ id: "inv", serverType: "membership_invite", actionRef: "acme" });
    expect(isCompanyInviteRequest(invite)).toBe(true);
    expect(itemsForTab([invite, mention], "requests").map((row) => row.id)).toEqual(["inv"]);
    expect(isAccessRequest(invite)).toBe(false);
    expect(isRequestRow(invite)).toBe(true);
  });

  it("grants write only when the request says write, otherwise read", () => {
    expect(grantLevelFor(request)).toBe("write");
    expect(actionKindForGrant("write")).toBe("grant_write");
    expect(grantLevelFor(item({ id: "a", serverType: "access_request", contextLine: "admin" }))).toBe("read");
    expect(actionKindForGrant("read")).toBe("grant_read");
  });

  it("drops an approved request from the list", () => {
    expect(withoutItem([request, mention], "r").map((row) => row.id)).toEqual(["m"]);
  });
});
