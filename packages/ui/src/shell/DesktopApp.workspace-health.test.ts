// @vitest-environment happy-dom

/**
 * PL-02 — the shell reads `cloudReachable` / `manifestError` from the same
 * `list_syncable_workspaces` envelope the retired menubar popover used, and
 * hands them to the title bar so the Core pill and popover can report sync
 * trouble.
 *
 * Regression: the first cut called `adapter.sync.listSyncableWorkspaces()`
 * unconditionally under `canSync`. `canSync` is a capability flag, not a
 * promise that the host implements that method — hosts (and the shell's own
 * test doubles) that omit it threw an unhandled TypeError out of the mount
 * effect. A missing method must mean "no notices", never a crash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

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
  vi.restoreAllMocks();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function buildAdapter(
  listSyncableWorkspaces?: () => Promise<unknown>,
): PlatformAdapter {
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
      startSync: async () => ok(undefined),
      getSyncStatus: async () =>
        ok({
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: true,
          source: "journal",
          hqFolderPath: "/tmp/hq",
        }),
      ...(listSyncableWorkspaces ? { listSyncableWorkspaces } : {}),
    },
  } as unknown as PlatformAdapter;
}

async function mountApp(adapter: PlatformAdapter): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies: [],
      coreFixtures: false,
    },
  });
  await settle();
}

function coreDotTone(): string | null {
  return (
    host
      .querySelector('[data-testid="titlebar-core-dot"]')
      ?.getAttribute("data-tone") ?? null
  );
}

describe("DesktopApp workspace health read", () => {
  it("does not throw when the host has no workspaces listing", async () => {
    const onError = vi.fn();
    window.addEventListener("unhandledrejection", onError);
    await mountApp(buildAdapter());
    window.removeEventListener("unhandledrejection", onError);
    expect(onError).not.toHaveBeenCalled();
    // No envelope read means no trouble claimed.
    expect(coreDotTone()).toBe("ok");
  });

  it("lights the Core pill when the envelope reports the cloud unreachable", async () => {
    await mountApp(
      buildAdapter(async () =>
        ok({
          workspaces: [],
          cloudReachable: false,
          error: "network down",
          manifestError: null,
          hqFolderPath: "/tmp/hq",
        }),
      ),
    );
    await settle();
    expect(coreDotTone()).toBe("warn");
  });

  it("lights the Core pill when the companies manifest could not be read", async () => {
    await mountApp(
      buildAdapter(async () =>
        ok({
          workspaces: [],
          cloudReachable: true,
          error: null,
          manifestError: "line 4: bad indent",
          hqFolderPath: "/tmp/hq",
        }),
      ),
    );
    await settle();
    expect(coreDotTone()).toBe("warn");
  });

  it("stays healthy when the envelope reports nothing wrong", async () => {
    await mountApp(
      buildAdapter(async () =>
        ok({
          workspaces: [],
          cloudReachable: true,
          error: null,
          manifestError: null,
          hqFolderPath: "/tmp/hq",
        }),
      ),
    );
    await settle();
    expect(coreDotTone()).toBe("ok");
  });
});
