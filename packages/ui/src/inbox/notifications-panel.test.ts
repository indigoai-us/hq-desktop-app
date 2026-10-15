import { describe, expect, it } from "vitest";
import { isCompanyInviteRequest } from "./company-invite-requests.js";
import type { NotificationItem } from "./notifications-model.js";
import {
  actionKindForGrant,
  grantLevelFor,
  isAccessRequest,
  isRequestRow,
  itemsForTab,
  newestFirst,
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

  it("lists newest first whatever order the merged feed arrives in (feedback_f36dfa85)", () => {
    const at = (iso: string) => ({ createdAt: iso, createdAtMs: Date.parse(iso) });
    const oldest = item({ id: "old", serverType: "dm", ...at("2026-10-01T09:00:00.000Z") });
    const middle = item({ id: "mid", serverType: "dm", ...at("2026-10-07T09:00:00.000Z") });
    const newest = item({ id: "new", serverType: "dm", ...at("2026-10-14T09:00:00.000Z") });
    // DM inbox history arrives oldest-first after the store rows.
    expect(newestFirst([oldest, middle, newest]).map((row) => row.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(itemsForTab(newestFirst([middle, oldest, newest]), "all")[0]?.id).toBe("new");
  });

  it("keeps undated rows on top and ties in their incoming order", () => {
    const dated = item({
      id: "dated",
      serverType: "dm",
      createdAt: "2026-10-14T09:00:00.000Z",
      createdAtMs: Date.parse("2026-10-14T09:00:00.000Z"),
    });
    const inviteA = item({ id: "inv-a", serverType: "membership_invite" });
    const inviteB = item({ id: "inv-b", serverType: "membership_invite" });
    expect(newestFirst([dated, inviteA, inviteB]).map((row) => row.id)).toEqual([
      "inv-a",
      "inv-b",
      "dated",
    ]);
  });

  it("drops an approved request from the list", () => {
    expect(withoutItem([request, mention], "r").map((row) => row.id)).toEqual(["m"]);
  });
});
