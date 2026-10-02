// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { NotificationsApi } from "../chat/chat-api.js";
import NotificationsPopover from "./NotificationsPopover.svelte";
import { publishNotificationsCache } from "./notifications-cache.svelte.js";
import { dismissToast, toastItems } from "../shell/toast-stack.svelte.js";
import type { NotificationItem } from "./notifications-model.js";

const request: NotificationItem = {
  id: "req-1",
  serverType: "access_request",
  displayKind: "generic",
  typeIcon: "generic",
  actorName: "Hassaan",
  actorInitials: "HS",
  verbText: "Hassaan requested access",
  contextLine: "projects/hq (read)",
  status: "unread",
  createdAt: "2026-08-23T15:00:00.000Z",
  createdAtMs: Date.parse("2026-08-23T15:00:00.000Z"),
  timestampLabel: "3:00 PM",
  actionKind: null,
  actionRef: "projects/hq",
  actionButtons: [],
  targetRef: null,
  actorPersonUid: "prs_h",
  sourceEventId: null,
  actionUsed: false,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  for (const toast of [...toastItems()]) dismissToast(toast.id);
});

describe("NotificationsPopover", () => {
  it("approves a cached access request without fetching and shows a success toast", async () => {
    publishNotificationsCache({ items: [request], ready: true, loading: false });
    let fetches = 0;
    const action: { actionKind: string | null } = { actionKind: null };
    const api: NotificationsApi = {
      fetchNotifications: async () => {
        fetches += 1;
        return { notifications: [], unreadCount: 0, nextCursor: null };
      },
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async (args) => {
        action.actionKind = args.actionKind;
        return {};
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, { target: host, props: { api } });
    await tick();
    expect(fetches).toBe(0);
    expect(host.querySelector("[data-testid='notification-row']")).toBeTruthy();
    host.querySelector<HTMLButtonElement>("[data-testid='notifications-tab-requests']")?.click();
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notification-approve']")?.click();
    await tick();
    expect(host.querySelector("[data-testid='notification-row']")).toBeNull();
    expect(toastItems().some((toast) => toast.title === "Access granted" && toast.tone === "ok")).toBe(true);
    expect(action.actionKind).toBe("grant_read");
    expect(fetches).toBe(0);
  });
});
