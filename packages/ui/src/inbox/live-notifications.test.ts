import { describe, expect, it, vi } from "vitest";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import {
  classifyNotificationAck,
  composeLiveNotifications,
  createLiveNotificationsApi,
  mapInboxEventToNotification,
  mapShareEventToNotification,
} from "./live-notifications";

describe("live-notifications", () => {
  describe("classifyNotificationAck", () => {
    it("routes synthetic ids to the v1 inboxes and store ids to NOTIF ack", () => {
      expect(classifyNotificationAck("dm:evt-1")).toEqual({
        kind: "inbox",
        eventId: "evt-1",
      });
      expect(classifyNotificationAck("share:sh-9")).toEqual({
        kind: "share",
        eventId: "sh-9",
      });
      expect(classifyNotificationAck("uuid-store")).toEqual({
        kind: "store",
        id: "uuid-store",
      });
    });
  });

  describe("event mappers", () => {
    it("maps a DM inbox event to a dm notification", () => {
      const row = mapInboxEventToNotification({
        eventId: "e1",
        fromPersonUid: "prs_ada",
        fromDisplayName: "Ada Lovelace",
        body: "Demo moved to Thursday.",
        createdAt: "2026-08-12T14:30:00.000Z",
      });
      expect(row).toMatchObject({
        id: "dm:e1",
        type: "dm",
        status: "unread",
        actorName: "Ada Lovelace",
        actorPersonUid: "prs_ada",
        body: "Demo moved to Thursday.",
        sourceEventId: "e1",
      });
    });

    it("maps a share event to a file_share notification", () => {
      const row = mapShareEventToNotification({
        eventId: "s1",
        issuerDisplayName: "Sofia",
        issuerPersonUid: "prs_sofia",
        paths: ["library-ia-v2.md"],
        createdAt: "2026-08-12T15:00:00.000Z",
        acknowledgedAt: "2026-08-12T15:01:00.000Z",
      });
      expect(row).toMatchObject({
        id: "share:s1",
        type: "file_share",
        status: "read",
        actorName: "Sofia",
        context: "library-ia-v2.md",
        sourceEventId: "s1",
      });
    });
  });

  describe("composeLiveNotifications", () => {
    it("preserves every store notification type while filling DM and share history", () => {
      const composed = composeLiveNotifications({
        store: {
          notifications: [
            {
              id: "n-mention",
              type: "mention",
              sourceEventId: "m1",
              status: "unread",
              actionRef: "story-7",
            },
            {
              id: "n-dm",
              type: "dm",
              sourceEventId: "e-store",
              status: "read",
              actorName: "Ada",
            },
            {
              id: "n-invite",
              type: "membership_invite",
              status: "unread",
            },
            {
              id: "n-alias",
              type: "dm_received",
              sourceEventId: "e-alias",
              status: "unread",
              actorName: "Priya",
            },
          ],
          unreadCount: 7,
          nextCursor: "opaque-next-page",
        },
        inbox: {
          events: [
            {
              eventId: "e-store",
              fromDisplayName: "Ada",
              body: "duplicate of store row",
              createdAt: "2026-08-12T10:00:00.000Z",
            },
            {
              eventId: "e-new",
              fromDisplayName: "Bryan",
              fromPersonUid: "prs_bryan",
              body: "older DM not in the store",
              createdAt: "2026-08-11T10:00:00.000Z",
            },
            {
              eventId: "e-alias",
              fromDisplayName: "Priya",
              body: "should lose to store alias",
              createdAt: "2026-08-11T09:00:00.000Z",
            },
          ],
        },
        shares: {
          events: [
            {
              eventId: "s-new",
              issuerDisplayName: "Sofia",
              paths: ["notes.md"],
              createdAt: "2026-08-12T09:00:00.000Z",
            },
          ],
        },
      });

      const ids = composed.notifications.map((row) => row.id);
      expect(ids).toContain("n-dm");
      expect(ids).toContain("n-alias");
      expect(ids).toContain("dm:e-new");
      expect(ids).toContain("share:s-new");
      expect(ids).toContain("n-mention");
      expect(ids).toContain("n-invite");
      expect(ids).not.toContain("dm:e-store");
      expect(ids).not.toContain("dm:e-alias");
      expect(composed.unreadCount).toBe(7);
      expect(composed.nextCursor).toBe("opaque-next-page");
      expect(
        composed.notifications.find((row) => row.id === "n-mention")?.actionRef,
      ).toBe("story-7");
      expect(
        composed.notifications.find((row) => row.id === "dm:e-new")?.status,
      ).toBe("read");
      expect(
        composed.notifications.find((row) => row.id === "share:s-new")?.status,
      ).toBe("read");
    });

    it("fills missing store actorPersonUid from the matching inbox event", () => {
      const composed = composeLiveNotifications({
        store: {
          notifications: [
            {
              id: "n-dm",
              type: "dm",
              sourceEventId: "e-store",
              status: "unread",
              actorName: "Ada",
              targetRef: "/messages",
            },
          ],
        },
        inbox: {
          events: [
            {
              eventId: "e-store",
              fromDisplayName: "Ada",
              fromPersonUid: "prs_ada",
              body: "hello",
              createdAt: "2026-08-12T10:00:00.000Z",
            },
          ],
        },
      });
      const row = composed.notifications.find((item) => item.id === "n-dm");
      expect(row?.actorPersonUid).toBe("prs_ada");
      expect(row?.targetRef).toBe("/messages");
    });

    it("unreadOnly returns only store-unread rows and ignores inbox history", () => {
      const composed = composeLiveNotifications({
        unreadOnly: true,
        store: {
          notifications: [
            { id: "n-read", type: "dm", status: "read" },
            { id: "n-unread", type: "dm", status: "unread", actorName: "Ada" },
          ],
        },
        inbox: {
          events: [
            {
              eventId: "old",
              fromDisplayName: "Bryan",
              body: "already seen in chat",
              createdAt: "2026-08-11T10:00:00.000Z",
            },
          ],
        },
      });
      expect(composed.notifications.map((row) => row.id)).toEqual(["n-unread"]);
      expect(composed.unreadCount).toBe(1);
    });

    it("survives missing sources", () => {
      const composed = composeLiveNotifications({});
      expect(composed.notifications).toEqual([]);
      expect(composed.unreadCount).toBe(0);
    });
  });

  describe("createLiveNotificationsApi", () => {
    function fakeAdapter(opts?: {
      store?: unknown;
      inbox?: unknown;
      shares?: unknown;
      storeError?: ReturnType<typeof failure>;
    }) {
      const acks = {
        store: [] as string[],
        inbox: [] as string[],
        shares: [] as string[],
        readAll: 0,
      };
      const adapter = {
        notifications: {
          fetchNotifications: vi.fn(async () =>
            opts?.storeError
              ? opts.storeError
              : ok(opts?.store ?? { notifications: [] }),
          ),
          ack: vi.fn(async (id: string) => {
            acks.store.push(id);
            return ok(undefined);
          }),
          readAll: vi.fn(async () => {
            acks.readAll += 1;
            return ok(undefined);
          }),
          runAction: vi.fn(async () => ok({})),
          fetchDmInbox: vi.fn(async () => ok(opts?.inbox ?? { events: [] })),
          ackDmInbox: vi.fn(async (ids: string[]) => {
            acks.inbox.push(...ids);
            return ok(undefined);
          }),
          fetchSharedWithMe: vi.fn(async () =>
            ok(opts?.shares ?? { events: [] }),
          ),
          ackSharedWithMe: vi.fn(async (ids: string[]) => {
            acks.shares.push(...ids);
            return ok(undefined);
          }),
        },
      } as unknown as PlatformAdapter;
      return { adapter, acks };
    }

    it("returns the composed feed and acks the matching source", async () => {
      const { adapter, acks } = fakeAdapter({
        store: {
          notifications: [
            {
              id: "n-dm",
              type: "dm",
              sourceEventId: "e-store",
              status: "unread",
              actorName: "Ada",
            },
          ],
        },
        inbox: {
          events: [
            {
              eventId: "e-new",
              fromDisplayName: "Bryan",
              body: "hi",
              createdAt: "2026-08-12T10:00:00.000Z",
            },
          ],
        },
        shares: {
          events: [
            {
              eventId: "s-new",
              issuerDisplayName: "Sofia",
              paths: ["a.md"],
              createdAt: "2026-08-12T09:00:00.000Z",
            },
          ],
        },
      });
      const api = createLiveNotificationsApi(adapter);
      const feed = (await api.fetchNotifications({
        limit: 50,
        cursor: null,
        unreadOnly: false,
      })) as { notifications: { id: string }[]; unreadCount: number };

      expect(feed.notifications.map((n) => n.id).sort()).toEqual(
        ["dm:e-new", "n-dm", "share:s-new"].sort(),
      );

      await api.ackNotification("dm:e-new");
      await api.ackNotification("share:s-new");
      await api.ackNotification("n-dm");

      expect(acks.inbox).toEqual(["e-new", "e-store"]);
      expect(acks.shares).toEqual(["s-new"]);
      expect(acks.store).toEqual(["n-dm"]);
    });

    it("read-all persists store mark even when inbox ack fails", async () => {
      const { adapter, acks } = fakeAdapter({
        store: {
          notifications: [
            {
              id: "n-dm",
              type: "dm",
              sourceEventId: "e-store",
              status: "unread",
              actorName: "Ada",
            },
          ],
        },
      });
      adapter.notifications.ackDmInbox = vi.fn(async () =>
        failure("http-404", "missing"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const api = createLiveNotificationsApi(adapter);
      await api.fetchNotifications({
        limit: 50,
        cursor: null,
        unreadOnly: false,
      });
      await expect(api.readAllNotifications()).resolves.toBeUndefined();
      expect(acks.readAll).toBe(1);
      warn.mockRestore();
    });

    it("treats inbox/share fetch failures as empty instead of failing the feed", async () => {
      const adapter = {
        notifications: {
          fetchNotifications: vi.fn(async () =>
            ok({
              notifications: [
                { id: "n1", type: "dm", status: "unread", actorName: "Ada" },
              ],
            }),
          ),
          ack: vi.fn(),
          readAll: vi.fn(),
          runAction: vi.fn(),
          fetchDmInbox: vi.fn(async () => failure("http-404", "missing")),
          ackDmInbox: vi.fn(),
          fetchSharedWithMe: vi.fn(async () => failure("http-404", "missing")),
          ackSharedWithMe: vi.fn(),
        },
      } as unknown as PlatformAdapter;
      const api = createLiveNotificationsApi(adapter);
      const feed = (await api.fetchNotifications({
        limit: 20,
        cursor: null,
        unreadOnly: false,
      })) as { notifications: { id: string }[] };
      expect(feed.notifications).toEqual([
        expect.objectContaining({ id: "n1", type: "dm" }),
      ]);
    });
  });
});
