/**
 * New-file activity in the desktop notifications feed.
 *
 * Before this source existed, "a teammate added a file to your company folder"
 * was visible only in the menu-bar popover's own feed. Retiring that popover
 * would have made the event silent everywhere on Windows (widget off by
 * default) and for widget-off macOS users: no feed row, no OS banner —
 * `native_notify.rs` has no file kind — and no window to find it in.
 *
 * The contract these tests pin down:
 *
 *   1. New-file events reach the feed.
 *   2. They never light the bell. They have no server ack, so the only unread
 *      state available would be a client watermark competing with the server's
 *      read model. Findable, not announced.
 *   3. The source is optional end to end. An adapter without it, or a server
 *      too old to answer, still renders DMs and shares.
 */
import { describe, expect, it, vi } from "vitest";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import {
  classifyNotificationAck,
  composeLiveNotifications,
  createLiveNotificationsApi,
  mapFileHistoryToNotification,
  type ComposedNotificationsFeed,
} from "./live-notifications";
import { mapServerType, verbForKind } from "./notifications-model";

const FILE_EVENT = {
  eventId: "f-1",
  path: "brand/logo-v3.svg",
  addedBy: "Sofia",
  companySlug: "indigo",
  createdAt: "2026-09-16T10:00:00.000Z",
};

function adapterWith(opts?: {
  files?: unknown;
  omitFileHistory?: boolean;
  fileError?: ReturnType<typeof failure>;
}) {
  const calls = { files: 0 };
  const notifications: Record<string, unknown> = {
    fetchNotifications: vi.fn(async () => ok({ notifications: [] })),
    ack: vi.fn(async () => ok(undefined)),
    readAll: vi.fn(async () => ok(undefined)),
    runAction: vi.fn(async () => ok({})),
    fetchDmInbox: vi.fn(async () => ok({ events: [] })),
    ackDmInbox: vi.fn(async () => ok(undefined)),
    fetchSharedWithMe: vi.fn(async () => ok({ events: [] })),
    ackSharedWithMe: vi.fn(async () => ok(undefined)),
  };
  if (!opts?.omitFileHistory) {
    notifications.fetchFileHistory = vi.fn(async () => {
      calls.files += 1;
      return opts?.fileError ?? ok(opts?.files ?? { files: [] });
    });
  }
  return {
    adapter: { notifications } as unknown as PlatformAdapter,
    calls,
  };
}

describe("new-file history in the notifications feed", () => {
  describe("mapFileHistoryToNotification", () => {
    it("maps a file event to a read row carrying company and path", () => {
      const row = mapFileHistoryToNotification(FILE_EVENT);
      expect(row).toMatchObject({
        id: "file:f-1",
        type: "new_file",
        status: "read",
        actorName: "Sofia",
        createdAt: "2026-09-16T10:00:00.000Z",
        targetRef: "/files",
        sourceEventId: "f-1",
      });
      expect(row?.context).toBe("indigo · brand/logo-v3.svg");
    });

    it("falls back to the bare path when the server omits the company", () => {
      const row = mapFileHistoryToNotification({
        eventId: "f-2",
        path: "notes.md",
        createdAt: "2026-09-16T10:00:00.000Z",
      });
      expect(row?.context).toBe("notes.md");
      expect(row?.actorName).toBe("Someone");
    });

    it("drops rows with no event id or no path rather than rendering a blank", () => {
      expect(mapFileHistoryToNotification({ path: "a.md" })).toBeNull();
      expect(mapFileHistoryToNotification({ eventId: "f-3" })).toBeNull();
    });
  });

  describe("composeLiveNotifications", () => {
    it("includes file rows without adding to the unread count", () => {
      const feed = composeLiveNotifications({
        store: { notifications: [], unreadCount: 0 },
        files: { files: [FILE_EVENT] },
      });
      expect(feed.notifications).toHaveLength(1);
      expect(feed.notifications[0]!.id).toBe("file:f-1");
      expect(feed.unreadCount).toBe(0);
    });

    it("keeps file rows out of the unread filter", () => {
      const feed = composeLiveNotifications({
        store: {
          notifications: [
            { id: "n-dm", type: "dm", status: "unread", actorName: "Ada" },
          ],
          unreadCount: 1,
        },
        files: { files: [FILE_EVENT] },
        unreadOnly: true,
      });
      expect(feed.notifications.map((n) => n.id)).toEqual(["n-dm"]);
      expect(feed.unreadCount).toBe(1);
    });

    it("lets a NOTIF store row win on the same event, so a future server-side new_file type upgrades these to real unread for free", () => {
      const feed = composeLiveNotifications({
        store: {
          notifications: [
            {
              id: "n-file",
              type: "new_file",
              sourceEventId: "f-1",
              status: "unread",
              actorName: "Sofia",
            },
          ],
          unreadCount: 1,
        },
        files: { files: [FILE_EVENT] },
      });
      expect(feed.notifications).toHaveLength(1);
      expect(feed.notifications[0]!.id).toBe("n-file");
      expect(feed.notifications[0]!.status).toBe("unread");
      expect(feed.unreadCount).toBe(1);
    });

    it("accepts the events envelope as well as files, for hosts that normalise the three sources", () => {
      const feed = composeLiveNotifications({ files: { events: [FILE_EVENT] } });
      expect(feed.notifications.map((n) => n.id)).toEqual(["file:f-1"]);
    });

    it("composes unchanged when no file source is supplied", () => {
      const feed = composeLiveNotifications({
        store: {
          notifications: [{ id: "n-dm", type: "dm", status: "unread" }],
          unreadCount: 1,
        },
      });
      expect(feed.notifications).toHaveLength(1);
      expect(feed.unreadCount).toBe(1);
    });
  });

  describe("display model", () => {
    it("reads a new file as added, not shared", () => {
      expect(mapServerType("new_file")).toBe("new_file");
      expect(mapServerType("file_added")).toBe("new_file");
      expect(verbForKind("new_file", "new_file")).toBe("added a file");
      // The deliberate-share wording must not regress.
      expect(mapServerType("file_share")).toBe("file_shared");
      expect(verbForKind("file_shared", "file_share")).toBe("shared a file");
    });
  });

  describe("acknowledgement", () => {
    it("routes a file id to a no-op target rather than an inbox ack", () => {
      expect(classifyNotificationAck("file:f-1")).toEqual({
        kind: "file",
        eventId: "f-1",
      });
    });

    it("acking a file row calls no endpoint", async () => {
      const { adapter } = adapterWith({ files: { files: [FILE_EVENT] } });
      const api = createLiveNotificationsApi(adapter);
      await api.fetchNotifications({ limit: 50, cursor: null, unreadOnly: false });
      await api.ackNotification("file:f-1");
      expect(adapter.notifications.ack).not.toHaveBeenCalled();
      expect(adapter.notifications.ackDmInbox).not.toHaveBeenCalled();
      expect(adapter.notifications.ackSharedWithMe).not.toHaveBeenCalled();
    });
  });

  describe("createLiveNotificationsApi", () => {
    it("fetches file history and folds it into the feed", async () => {
      const { adapter, calls } = adapterWith({ files: { files: [FILE_EVENT] } });
      const api = createLiveNotificationsApi(adapter);
      // NotificationsApi.fetchNotifications is declared as Promise<unknown>;
      // the live implementation returns a ComposedNotificationsFeed.
      const feed = (await api.fetchNotifications({
        limit: 50,
        cursor: null,
        unreadOnly: false,
      })) as ComposedNotificationsFeed;
      expect(calls.files).toBe(1);
      expect(feed.notifications.map((n) => n.id)).toContain("file:f-1");
      expect(feed.unreadCount).toBe(0);
    });

    it("still returns a feed when the adapter has no file-history method", async () => {
      const { adapter } = adapterWith({ omitFileHistory: true });
      const api = createLiveNotificationsApi(adapter);
      await expect(api.fetchNotifications({ limit: 50, cursor: null, unreadOnly: false })).resolves.toMatchObject(
        { notifications: [], unreadCount: 0 },
      );
    });

    it("still returns a feed when file history fails, including on a 401 that would abort the other sources", async () => {
      for (const err of [
        failure("network", "offline"),
        failure("401", "unauthorized"),
      ]) {
        const { adapter } = adapterWith({ fileError: err });
        const api = createLiveNotificationsApi(adapter);
        await expect(
          api.fetchNotifications({ limit: 50, cursor: null, unreadOnly: false }),
        ).resolves.toMatchObject({ notifications: [] });
      }
    });
  });
});
