// @vitest-environment happy-dom

/**
 * A local bot pauses when its coding tool's sign-in has expired (`hq bot list`
 * reports `runtimeSignIn`). Its conversation says so above the composer and
 * offers one button that signs in again (forced, because the CLI still claims
 * a saved login) and restarts the bot so it picks up the waiting message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { requestConversation, takePendingConversation } from "../chat/pending-conversation.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";

const BOT_UID = "agt_LOCAL000000000000000000001";

function bot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: BOT_UID,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    pid: 42,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date().toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/HQ/personal/workers/setup",
    ...over,
  };
}

let rows: LocalBotRow[] = [];
let loginStart: ReturnType<typeof vi.fn>;
let start: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: { listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }) },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    sessions: {
      preflight: async () =>
        ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: false, grokLoggedIn: false }),
      loginStart,
      loginStatus: async () => ok({ state: "connected" }),
    },
    bots: {
      list: async () => ok({ bots: rows }),
      create: async () => ok({}),
      start,
      stop,
      remove: async () => ok({}),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  takePendingConversation();
  window.localStorage?.clear?.();
  window.localStorage?.setItem?.(WELCOME_SETUP_RUN_KEY, "1");
  loginStart = vi.fn(async () => ok({ state: "connected" }));
  start = vi.fn(async () => ok({}));
  stop = vi.fn(async () => ok({}));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
});

afterEach(async () => {
  takePendingConversation();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
  vi.unstubAllGlobals();
});

async function openBotDm(): Promise<void> {
  requestConversation({ personUid: BOT_UID, email: "", displayName: "setup" });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: {
        ...createFixtureChatSidebarApi(),
        listContacts: async () => ({
          contacts: [
            {
              personUid: BOT_UID,
              email: "",
              displayName: "setup",
              lastMessageAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      },
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent?.trim()).toBe("setup");
  });
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("DesktopApp local bot sign-in banner", () => {
  it("offers the sign-in, then restarts the paused bot", async () => {
    rows = [bot({ runtimeSignIn: { state: "expired", runtime: "claude", since: "2026-09-15T10:00:00Z" } })];
    await openBotDm();
    const banner = await vi.waitFor(() => {
      const el = host.querySelector('[data-testid="bot-signin-banner"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.textContent).toContain("Claude Code needs you to sign in again before setup can keep working.");
    expect(host.querySelector('[data-testid="bot-signin-start"]')?.textContent?.trim()).toBe("Sign in to Claude Code");

    host.querySelector<HTMLButtonElement>('[data-testid="bot-signin-start"]')!.click();
    await settle(20);
    expect(loginStart).toHaveBeenCalledWith("claude", { force: true });
    expect(stop).toHaveBeenCalledWith("setup");
    expect(start).toHaveBeenCalledWith("setup");
  });

  it("stays out of the way when the bot's sign-in is fine", async () => {
    rows = [bot()];
    await openBotDm();
    await settle();
    expect(host.querySelector('[data-testid="bot-signin-banner"]')).toBeNull();
  });
});
