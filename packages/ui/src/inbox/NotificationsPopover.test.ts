// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { NotificationsApi } from "../chat/chat-api.js";
import NotificationsPopover from "./NotificationsPopover.svelte";
import { clearHiddenNotifications, publishNotificationsCache } from "./notifications-cache.svelte.js";
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
  clearHiddenNotifications();
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

  const invite: NotificationItem = {
    ...request,
    id: "company-invite:acme",
    serverType: "company_invite",
    verbText: "Invite to join Acme",
    contextLine: "Pending company invite",
    actionRef: "acme",
    targetRef: "co_acme",
  };

  function mountPopover(
    api: NotificationsApi,
    extra: Record<string, unknown> = {},
  ): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, { target: host, props: { api, ...extra } });
  }

  it("accepts a pending company invite from the Requests tab", async () => {
    publishNotificationsCache({ items: [], ready: true, loading: false });
    const accepted: string[] = [];
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    mountPopover(api, {
      pendingWorkspaces: [
        {
          slug: "acme",
          displayName: "Acme",
          kind: "company",
          membershipStatus: "pending",
          cloudUid: "co_acme",
        },
      ],
      onacceptcompany: async (item: NotificationItem) => {
        accepted.push(`${item.actionRef}:${item.targetRef}`);
        return { ok: true as const };
      },
    });
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notifications-tab-requests']")?.click();
    await tick();
    expect(host.textContent).toContain("Invite to join Acme");
    host.querySelector<HTMLButtonElement>("[data-testid='notification-accept-invite']")?.click();
    await tick();
    expect(accepted).toEqual(["acme:co_acme"]);
    expect(host.querySelector("[data-testid='notification-row']")).toBeNull();
  });

  it("declines a company invite by acking the request", async () => {
    publishNotificationsCache({ items: [invite], ready: true, loading: false });
    const acked: string[] = [];
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async (id) => {
        acked.push(id);
      },
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    mountPopover(api);
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notifications-tab-requests']")?.click();
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notification-decline-invite']")?.click();
    await tick();
    expect(acked).toEqual(["company-invite:acme"]);
    expect(host.querySelector("[data-testid='notification-row']")).toBeNull();
  });

  it("shows the plan-limit sentence and upgrade link when accept is refused", async () => {
    publishNotificationsCache({ items: [invite], ready: true, loading: false });
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    mountPopover(api, {
      onacceptcompany: async () => ({
        ok: false as const,
        message: "Your plan limit is reached. Members: 5 of 5 used.",
        upgradeUrl: "https://hq.computer/companies/acme/billing?upgrade=1",
      }),
    });
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notifications-tab-requests']")?.click();
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notification-accept-invite']")?.click();
    await tick();
    await tick();
    const note = host.querySelector("[data-testid='notification-invite-error']");
    expect(note?.textContent).toContain("Your plan limit is reached. Members: 5 of 5 used.");
    expect(note?.textContent).not.toContain("PLAN_LIMIT_EXCEEDED");
    const link = host.querySelector<HTMLAnchorElement>("[data-testid='notification-invite-upgrade']");
    expect(link?.href).toBe("https://hq.computer/companies/acme/billing?upgrade=1");
    expect(host.querySelector("[data-testid='notification-accept-invite']")).toBeTruthy();
  });

  it("asks the host to close on Escape (QA-021)", async () => {
    publishNotificationsCache({ items: [], ready: true, loading: false });
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    let closed = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, { target: host, props: { api, onclose: () => { closed += 1; } } });
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closed).toBe(1);
  });
  it("lists rows newest first (feedback_f36dfa85)", async () => {
    const older = { ...request, id: "older", serverType: "dm", verbText: "older", createdAt: "2026-10-01T09:00:00.000Z", createdAtMs: Date.parse("2026-10-01T09:00:00.000Z") };
    const newer = { ...request, id: "newer", serverType: "dm", verbText: "newer", createdAt: "2026-10-14T09:00:00.000Z", createdAtMs: Date.parse("2026-10-14T09:00:00.000Z") };
    publishNotificationsCache({ items: [older, newer], ready: true, loading: false });
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, { target: host, props: { api } });
    await tick();
    const verbs = [...host.querySelectorAll("[data-testid='notification-row'] .verb")].map((el) => el.textContent);
    expect(verbs).toEqual(["newer", "older"]);
  });

  it("marks every row read from the popover and tells the host to refetch (feedback_f36dfa85)", async () => {
    publishNotificationsCache({ items: [request], ready: true, loading: false });
    let readAll = 0;
    let refreshed = 0;
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {
        readAll += 1;
      },
      runNotificationAction: async () => ({}),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, {
      target: host,
      props: { api, onmarkedallread: () => { refreshed += 1; } },
    });
    await tick();
    expect(host.querySelector(".ni.unread")).toBeTruthy();
    const button = host.querySelector<HTMLButtonElement>("[data-testid='notifications-popover-mark-all-read']");
    expect(button?.disabled).toBe(false);
    button?.click();
    await tick();
    await tick();
    expect(readAll).toBe(1);
    expect(refreshed).toBe(1);
    expect(host.querySelector(".ni.unread")).toBeNull();
  });

  it("keeps Mark all read available when no row is unread, since it also clears the Dock count", async () => {
    publishNotificationsCache({ items: [{ ...request, status: "read" }], ready: true, loading: false });
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, { target: host, props: { api } });
    await tick();
    expect(
      host.querySelector<HTMLButtonElement>("[data-testid='notifications-popover-mark-all-read']")?.disabled,
    ).toBe(false);
  });

  it("restores unread rows and shows an error when Mark all read fails", async () => {
    publishNotificationsCache({ items: [request], ready: true, loading: false });
    let refreshed = 0;
    const api: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
      ackNotification: async () => {},
      readAllNotifications: async () => {
        throw new Error("offline");
      },
      runNotificationAction: async () => ({}),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NotificationsPopover, {
      target: host,
      props: { api, onmarkedallread: () => { refreshed += 1; } },
    });
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid='notifications-popover-mark-all-read']")?.click();
    await tick();
    await tick();
    expect(refreshed).toBe(0);
    expect(host.querySelector(".ni.unread")).toBeTruthy();
    expect(toastItems().some((toast) => toast.title === "Couldn't mark notifications read" && toast.tone === "err")).toBe(true);
  });
});
