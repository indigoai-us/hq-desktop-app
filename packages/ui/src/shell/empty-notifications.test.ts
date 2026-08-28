import { describe, expect, it } from "vitest";

import { createEmptyNotificationsApi } from "./mesh-overlay.js";

describe("createEmptyNotificationsApi", () => {
  it("returns an empty feed, never authored theater rows", async () => {
    const api = createEmptyNotificationsApi();
    const feed = (await api.fetchNotifications({
      limit: 50,
      cursor: null,
      unreadOnly: false,
    })) as { notifications: unknown[]; unreadCount: number };
    expect(feed.notifications).toEqual([]);
    expect(feed.unreadCount).toBe(0);
  });
});
