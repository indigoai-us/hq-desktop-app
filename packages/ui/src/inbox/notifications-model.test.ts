import { describe, expect, it } from "vitest";
import {
  actionButtonsFor,
  actorInitials,
  buildNotificationsView,
  classifyNotificationsError,
  emptyFeedState,
  filterNotifications,
  formatBadgeCount,
  formatNotificationsHeader,
  formatVerbLine,
  groupNotificationsByDay,
  mapNotificationRow,
  mapServerType,
  notificationDestination,
  parseNotificationsResponse,
  unreadCountFromNotificationsFeed,
  personUidFromTargetRef,
  reduceAck,
  reduceActionUsed,
  reduceFeedLoaded,
  reduceReadAll,
  type NotificationItem,
  type NotificationsFeedState,
  verbForKind,
} from "./notifications-model";

const NOW = Date.parse("2026-08-12T15:00:00.000Z");

function wire(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "n1",
    type: "dm",
    status: "unread",
    createdAt: "2026-08-12T14:30:00.000Z",
    actorName: "Ada Lovelace",
    body: "Hello there",
    ...partial,
  };
}

function item(
  partial: Partial<NotificationItem> & { id: string },
): NotificationItem {
  return {
    serverType: "dm",
    displayKind: "dm_received",
    typeIcon: "dm",
    actorName: "Ada",
    actorInitials: "A",
    verbText: "Ada sent a message",
    contextLine: "hi",
    status: "unread",
    createdAt: "2026-08-12T14:30:00.000Z",
    createdAtMs: Date.parse("2026-08-12T14:30:00.000Z"),
    timestampLabel: "2:30 PM",
    actionKind: null,
    actionRef: null,
    actionButtons: [],
    targetRef: null,
    actorPersonUid: null,
    sourceEventId: null,
    actionUsed: false,
    ...partial,
  };
}

describe("notifications-model (US-012)", () => {
  describe("mapServerType", () => {
    it("maps catalog types into the UI taxonomy", () => {
      expect(mapServerType("mention")).toBe("mention");
      expect(mapServerType("agent_finished_story")).toBe(
        "agent_finished_story",
      );
      expect(mapServerType("agent_channel_action_needed")).toBe(
        "agent_review_request",
      );
      expect(mapServerType("agent_review_request")).toBe(
        "agent_review_request",
      );
      expect(mapServerType("file_share")).toBe("file_shared");
      expect(mapServerType("dm")).toBe("dm_received");
      expect(mapServerType("security_alert")).toBe("infra_flag");
    });

    it("falls back to generic for unknown types", () => {
      expect(mapServerType("membership_invite")).toBe("generic");
      expect(mapServerType("connection_request")).toBe("generic");
      expect(mapServerType("totally_new_thing")).toBe("generic");
      expect(mapServerType("")).toBe("generic");
      expect(mapServerType(null)).toBe("generic");
    });
  });

  describe("mapNotificationRow", () => {
    it("keeps actorPersonUid and sourceEventId for DM click-through", () => {
      const row = mapNotificationRow(
        wire({
          actorPersonUid: "prs_ada",
          sourceEventId: "evt-1",
          targetRef: "/messages/prs_ada",
        }),
      );
      expect(row?.actorPersonUid).toBe("prs_ada");
      expect(row?.sourceEventId).toBe("evt-1");
      expect(row?.displayKind).toBe("dm_received");
    });
  });

  describe("notificationDestination", () => {
    it("opens a DM from actorPersonUid", () => {
      const dest = notificationDestination(
        item({
          id: "n-dm",
          actorPersonUid: "prs_ada",
          targetRef: "/messages",
        }),
      );
      expect(dest).toEqual({
        kind: "dm",
        personUid: "prs_ada",
        title: "Ada",
      });
    });

    it("parses /messages/prs_* when actorPersonUid is missing", () => {
      expect(personUidFromTargetRef("/messages/prs_ada")).toBe("prs_ada");
      const dest = notificationDestination(
        item({
          id: "n-dm",
          actorPersonUid: null,
          targetRef: "/messages/prs_ada",
        }),
      );
      expect(dest).toEqual({
        kind: "dm",
        personUid: "prs_ada",
        title: "Ada",
      });
    });

    it("opens the sharer DM instead of Skills library", () => {
      const dest = notificationDestination(
        item({
          id: "n-share",
          displayKind: "file_shared",
          serverType: "file_share",
          typeIcon: "file",
          actorPersonUid: "prs_sofia",
          targetRef: "/files",
        }),
      );
      expect(dest).toEqual({
        kind: "dm",
        personUid: "prs_sofia",
        title: "Ada",
      });
    });

    it("falls back to files when a share has no person", () => {
      const dest = notificationDestination(
        item({
          id: "n-share",
          displayKind: "file_shared",
          serverType: "file_share",
          typeIcon: "file",
          actorPersonUid: null,
          targetRef: "/files",
        }),
      );
      expect(dest).toEqual({ kind: "files" });
    });
  });

  describe("verb + actor", () => {
    it("builds initials and verb lines", () => {
      expect(actorInitials("Ada Lovelace")).toBe("AL");
      expect(actorInitials("Beyoncé")).toBe("BE");
      expect(actorInitials("")).toBe("?");
      expect(verbForKind("mention", "mention")).toBe("mentioned you");
      expect(verbForKind("file_shared", "file_share")).toBe("shared a file");
      expect(formatVerbLine("Ada", "mentioned you")).toBe("Ada mentioned you");
    });
  });

  describe("actionButtonsFor", () => {
    it("renders Accept/Decline for connection_accept", () => {
      const buttons = actionButtonsFor(
        "connection_accept",
        "connection_request",
      );
      expect(buttons.map((b) => b.label)).toEqual(["Accept", "Decline"]);
      expect(buttons[0]?.actionKind).toBe("connection_accept");
      expect(buttons[1]?.actionKind).toBe("connection_decline");
    });

    it("renders Approve for agent_owner_approve", () => {
      expect(
        actionButtonsFor("agent_owner_approve").map((b) => b.label),
      ).toEqual(["Approve"]);
    });

    it("returns empty when no actionKind", () => {
      expect(actionButtonsFor(null)).toEqual([]);
      expect(actionButtonsFor("")).toEqual([]);
    });
  });

  describe("parseNotificationsResponse", () => {
    it("maps rows and keeps server unreadCount", () => {
      const parsed = parseNotificationsResponse(
        {
          notifications: [
            wire({ id: "a", type: "dm", status: "unread" }),
            wire({
              id: "b",
              type: "file_share",
              status: "read",
              actorName: "Bob",
            }),
            wire({ id: "", type: "dm" }), // dropped
            null, // dropped
          ],
          unreadCount: 7,
          nextCursor: "cur-1",
        },
        NOW,
      );
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0]?.displayKind).toBe("dm_received");
      expect(parsed.items[1]?.displayKind).toBe("file_shared");
      expect(parsed.unreadCount).toBe(7);
      expect(parsed.nextCursor).toBe("cur-1");
    });

    it("degrades null / malformed to empty", () => {
      expect(parseNotificationsResponse(null)).toEqual({
        items: [],
        unreadCount: 0,
        nextCursor: null,
      });
      expect(parseNotificationsResponse("nope")).toEqual({
        items: [],
        unreadCount: 0,
        nextCursor: null,
      });
      expect(parseNotificationsResponse({}).items).toEqual([]);
    });

    it("maps actionKind into buttons", () => {
      const row = mapNotificationRow(
        wire({
          type: "connection_request",
          actionKind: "connection_accept",
          actionRef: "req_1",
          title: "Connection request",
        }),
        NOW,
      );
      expect(row?.actionButtons).toHaveLength(2);
      expect(row?.actionRef).toBe("req_1");
    });
  });

  describe("filter + day groups", () => {
    it("filters unread only", () => {
      const items = [
        item({ id: "1", status: "unread" }),
        item({ id: "2", status: "read" }),
      ];
      expect(filterNotifications(items, "unread")).toHaveLength(1);
      expect(filterNotifications(items, "all")).toHaveLength(2);
    });

    it("groups by Today / Yesterday / date", () => {
      const today = item({
        id: "t",
        createdAt: "2026-08-12T10:00:00.000Z",
        createdAtMs: Date.parse("2026-08-12T10:00:00.000Z"),
      });
      const yest = item({
        id: "y",
        createdAt: "2026-08-11T10:00:00.000Z",
        createdAtMs: Date.parse("2026-08-11T10:00:00.000Z"),
      });
      const older = item({
        id: "o",
        createdAt: "2026-08-01T10:00:00.000Z",
        createdAtMs: Date.parse("2026-08-01T10:00:00.000Z"),
      });
      const groups = groupNotificationsByDay([today, yest, older], NOW);
      expect(groups.map((g) => g.label)).toEqual([
        "Today",
        "Yesterday",
        expect.stringMatching(/Aug/),
      ]);
      expect(groups[0]?.items[0]?.id).toBe("t");
    });
  });

  describe("badge + header", () => {
    it("hides badge at 0 and caps at 99+", () => {
      expect(formatBadgeCount(0)).toBeNull();
      expect(formatBadgeCount(-1)).toBeNull();
      expect(formatBadgeCount(3)).toBe("3");
      expect(formatBadgeCount(99)).toBe("99");
      expect(formatBadgeCount(100)).toBe("99+");
      expect(formatBadgeCount(1000)).toBe("99+");
    });

    it("formats header with unread count", () => {
      expect(formatNotificationsHeader(0)).toBe("Notifications · 0 unread");
      expect(formatNotificationsHeader(3)).toBe("Notifications · 3 unread");
    });
  });

  describe("optimistic reducers", () => {
    function stateWithThreeUnread(): NotificationsFeedState {
      const base = emptyFeedState("all");
      return reduceFeedLoaded(base, {
        items: [
          item({ id: "1", status: "unread" }),
          item({ id: "2", status: "unread" }),
          item({ id: "3", status: "unread" }),
        ],
        unreadCount: 3,
        nextCursor: null,
      });
    }

    it("ack marks one row and decrements unreadCount", () => {
      const next = reduceAck(stateWithThreeUnread(), "2");
      expect(next.unreadCount).toBe(2);
      expect(next.items.find((i) => i.id === "2")?.status).toBe("read");
      expect(next.items.find((i) => i.id === "1")?.status).toBe("unread");
    });

    it("ack is idempotent for already-read rows", () => {
      const once = reduceAck(stateWithThreeUnread(), "1");
      const twice = reduceAck(once, "1");
      expect(twice.unreadCount).toBe(2);
    });

    it("unreadCountFromNotificationsFeed prefers the payload unreadCount", () => {
      expect(
        unreadCountFromNotificationsFeed({
          notifications: [wire({ status: "read" })],
          unreadCount: 4,
        }),
      ).toBe(4);
      expect(
        unreadCountFromNotificationsFeed({
          notifications: [wire({ status: "unread" })],
        }),
      ).toBe(1);
    });

    it("read-all zeros unreadCount and flips every row (PRD e2e)", () => {
      const next = reduceReadAll(stateWithThreeUnread());
      expect(next.unreadCount).toBe(0);
      expect(next.items.every((i) => i.status === "read")).toBe(true);
      const view = buildNotificationsView(next, NOW);
      expect(view.badgeText).toBeNull();
      expect(view.headerTitle).toBe("Notifications");
      expect(view.headerUnread).toBe("All caught up");
    });

    it("actionUsed disables actions and acks the row", () => {
      const next = reduceActionUsed(stateWithThreeUnread(), "1");
      expect(next.items.find((i) => i.id === "1")?.actionUsed).toBe(true);
      expect(next.items.find((i) => i.id === "1")?.status).toBe("read");
      expect(next.unreadCount).toBe(2);
    });
  });

  describe("classifyNotificationsError", () => {
    it("treats 404 / not found as unsupported empty state", () => {
      expect(classifyNotificationsError("Request failed (status 404)")).toBe(
        "unsupported",
      );
      expect(classifyNotificationsError(new Error("Unknown route"))).toBe(
        "unsupported",
      );
      expect(classifyNotificationsError("Not signed in: expired")).toBe("auth");
      expect(classifyNotificationsError("Network error")).toBe("generic");
    });
  });
});
