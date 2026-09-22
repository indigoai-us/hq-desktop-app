// @vitest-environment happy-dom

/**
 * PL-03 — the two banners the tray popover used to own, now in the desktop
 * window's banner stack:
 *
 *   1. session expired / sign-in required (`sync:auth-error`, which
 *      `start_sync` emits INSTEAD of failing, so nothing else reports it)
 *   2. the native notification action retry, whose record is produced by the
 *      controller window and broadcast here
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { RECOVERY_EVENT, RETRY_EVENT } from "./notification-recovery.js";
import type { SyncEventHost } from "./sync-events.js";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function buildAdapter(): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: (cap: string) => cap === "canSync",
    capabilities: { canSync: true },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    sync: {
      startSync: vi.fn(async () => ok(undefined)),
      getSyncStatus: async () =>
        ok({
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: true,
          source: "journal",
          hqFolderPath: "/tmp/hq",
        }),
    },
  } as unknown as PlatformAdapter;
}

function resetSharedState(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
}

beforeEach(resetSharedState);
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetSharedState();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

type Listener = (event: { payload?: unknown }) => void;

function createSyncEventHost() {
  const listeners = new Map<string, Set<Listener>>();
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  return {
    emitted,
    host: {
      listen: async (event: string, handler: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
      emit: async (event: string, payload?: unknown) => {
        emitted.push({ event, payload });
      },
    },
    deliver(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
  };
}

async function mountApp(options: {
  syncEvents?: SyncEventHost | null;
  onsignin?: () => void | Promise<void>;
} = {}): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: buildAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies: [],
      syncEvents: options.syncEvents ?? null,
      onsignin: options.onsignin,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("session expired banner", () => {
  it("stays hidden while the session is healthy", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    expect(
      host.querySelector('[data-testid="session-expired-banner"]'),
    ).toBeNull();
  });

  it("surfaces the runner's reason when sync reports an auth error", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host, onsignin: vi.fn() });
    bus.deliver("sync:auth-error", { message: "Session expired 3 days ago." });
    await settle();

    const banner = host.querySelector('[data-testid="session-expired-banner"]');
    expect(banner, "auth error raises the banner").toBeTruthy();
    expect(banner?.textContent).toContain("Session expired 3 days ago.");
  });

  it("also raises on auth:reauth-required, which runs without a sync", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host, onsignin: vi.fn() });
    bus.deliver("auth:reauth-required", undefined);
    await settle();
    expect(
      host.querySelector('[data-testid="session-expired-banner"]'),
    ).toBeTruthy();
  });

  it("runs the host's sign-in action", async () => {
    const onsignin = vi.fn(async () => {});
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host, onsignin });
    bus.deliver("sync:auth-error", { message: "Session expired." });
    await settle();

    host
      .querySelector<HTMLButtonElement>('[data-testid="session-expired-signin"]')!
      .click();
    await settle();
    expect(onsignin).toHaveBeenCalledTimes(1);
  });

  it("offers no sign-in control when the host cannot start one", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    bus.deliver("sync:auth-error", { message: "Session expired." });
    await settle();

    expect(
      host.querySelector('[data-testid="session-expired-banner"]'),
      "the state is still reported",
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="session-expired-signin"]'),
      "but a dead button is not offered",
    ).toBeNull();
  });

  it("clears once a sync run completes", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host, onsignin: vi.fn() });
    bus.deliver("sync:auth-error", { message: "Session expired." });
    await settle();
    bus.deliver("sync:complete", { company: "acme" });
    await settle();
    expect(
      host.querySelector('[data-testid="session-expired-banner"]'),
    ).toBeNull();
  });

  it("can be dismissed for the session", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host, onsignin: vi.fn() });
    bus.deliver("sync:auth-error", { message: "Session expired." });
    await settle();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="session-expired-dismiss"]',
      )!
      .click();
    await settle();
    expect(
      host.querySelector('[data-testid="session-expired-banner"]'),
    ).toBeNull();
  });
});

describe("notification action recovery banner", () => {
  const recovery = {
    kind: "dm",
    action: "open",
    data: { conversationId: "dm_1" },
    message: "Couldn’t finish the message action. Retry it here.",
  };

  it("renders the record the controller window broadcasts", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    bus.deliver(RECOVERY_EVENT, { recovery, retrying: false });
    await settle();

    const banner = host.querySelector(
      '[data-testid="notification-action-recovery"]',
    );
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("Retry it here.");
  });

  it("asks the controller to re-run the action on Retry", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    bus.deliver(RECOVERY_EVENT, { recovery, retrying: false });
    await settle();

    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="notification-action-recovery"] button',
      )!
      .click();
    await settle();

    expect(bus.emitted.map((e) => e.event)).toContain(RETRY_EVENT);
  });

  it("clears when the controller reports the action finished", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    bus.deliver(RECOVERY_EVENT, { recovery, retrying: false });
    await settle();
    bus.deliver(RECOVERY_EVENT, { recovery: null, retrying: false });
    await settle();

    expect(
      host.querySelector('[data-testid="notification-action-recovery"]'),
    ).toBeNull();
  });

  it("ignores a malformed broadcast rather than showing a dead Retry", async () => {
    const bus = createSyncEventHost();
    await mountApp({ syncEvents: bus.host });
    bus.deliver(RECOVERY_EVENT, { recovery: { kind: "dm" }, retrying: false });
    await settle();
    expect(
      host.querySelector('[data-testid="notification-action-recovery"]'),
    ).toBeNull();
  });
});
