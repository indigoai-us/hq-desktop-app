// @vitest-environment happy-dom

/**
 * A local bot pauses when its coding tool's sign-in has expired (`hq bot list`
 * reports `runtimeSignIn`). The themed signed-out repair card is the one
 * place to sign in again: the bot's own card in the conversation, or, when
 * the conversation has none, the same card above the composer. The old gray
 * "needs you to sign in again" banner is gone. A sign-in finished on any
 * other screen turns the card to "You're all set" in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { requestConversation, takePendingConversation } from "../chat/pending-conversation.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { announceRuntimeSignedIn } from "../chat/messaging/runtime-repair.svelte.js";

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
let dm: unknown[] = [];
let probeOk = false;
let probe: ReturnType<typeof vi.fn>;
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
      fetchDmThread: async () => ok({ messages: dm, nextCursor: null }),
      fetchReactions: async () => ok({ reactions: [] }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
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
      probe,
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  takePendingConversation();
  window.localStorage?.clear?.();
  window.localStorage?.setItem?.(WELCOME_SETUP_RUN_KEY, "1");
  dm = [];
  probeOk = false;
  probe = vi.fn(async () => ok(probeOk ? { ok: true } : { ok: false, class: "signed-out" }));
  loginStart = vi.fn(async () => {
    probeOk = true;
    return ok({ state: "connected" });
  });
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
  vi.restoreAllMocks();
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
      initialRow: { id: `dm:${BOT_UID}`, kind: "dm", title: "setup", personUid: BOT_UID, companyUid: null } as ConversationRow,
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

const PAUSED = { state: "expired" as const, runtime: "claude" as const, since: "2026-09-15T10:00:00Z" };

/** The bot's own signed-out reply in its DM, as hq-cli posts it. */
function repairReply() {
  return {
    eventId: "evt_repair",
    fromPersonUid: BOT_UID,
    fromDisplayName: "setup",
    body: "Claude Code is signed out on this Mac. Sign in, then send your message again.",
    createdAt: "2026-09-15T10:00:05.000Z",
    direction: "in",
    richContent: {
      v: 1,
      blocks: [{ v: 1, kind: "runtime-repair", class: "signed-out", runtime: "claude", action: "signIn", botName: "setup" }],
    },
  };
}

const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="runtime-repair-card"]')];

function noGrayBanner(): void {
  expect(host.querySelector('[data-testid="bot-signin-banner"]')).toBeNull();
  expect(host.textContent).not.toContain("needs you to sign in again");
  expect(host.textContent).not.toContain("Sign in to Claude Code");
}

describe("DesktopApp local bot sign-in", () => {
  it("draws the signed-out repair card, never the gray banner, when the conversation has no card", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-testid="bot-sign-in-card"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    noGrayBanner();
    expect(cards()).toHaveLength(1);
    expect(card.dataset.phase).toBe("offered");
    expect(card.textContent).toContain("Claude Code is signed out");

    // Its Sign in signs in (forced: the CLI still claims a saved login),
    // checks, restarts the paused bot, and turns the same card fixed.
    card.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-primary"]')!.click();
    await vi.waitFor(() => expect(card.dataset.phase).toBe("fixed"));
    expect(loginStart).toHaveBeenCalledWith("claude", { force: true });
    expect(stop).toHaveBeenCalledWith("setup");
    expect(start).toHaveBeenCalledWith("setup");
    expect(card.textContent).toContain("You’re all set");
    expect(card.textContent).toContain("Send me anything.");
    noGrayBanner();
  });

  it("turns the card above the composer fixed when a sign-in finishes on another screen", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-testid="bot-sign-in-card"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await settle(20);
    expect(card.dataset.phase).toBe("offered");
    probeOk = true;
    announceRuntimeSignedIn("claude");
    await vi.waitFor(() => expect(card.dataset.phase).toBe("fixed"));
    expect(card.textContent).toContain("You’re all set");
    expect(loginStart).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith("setup"));
    expect(cards()).toHaveLength(1);
    noGrayBanner();
  });

  it("shows only the bot's own card when the conversation has one", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    dm = [repairReply()];
    await openBotDm();
    await vi.waitFor(() => expect(host.querySelector('[data-event-id="evt_repair"] [data-testid="runtime-repair-card"]')).not.toBeNull());
    await settle(20);
    expect(cards()).toHaveLength(1);
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
    expect(cards()[0]!.closest("[data-event-id]")?.getAttribute("data-event-id")).toBe("evt_repair");
    noGrayBanner();
  });

  it("turns the card fixed in place when a sign-in finishes on another screen", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    dm = [repairReply()];
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-event-id="evt_repair"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await settle(20);
    expect(card.dataset.phase).toBe("offered");

    // Settings, New Bot or the coding tools screen signed Claude Code in.
    probeOk = true;
    announceRuntimeSignedIn("claude");
    await vi.waitFor(() => expect(card.dataset.phase).toBe("fixed"));
    expect(cards()[0]).toBe(card);
    expect(card.textContent).toContain("You’re all set");
    expect(loginStart).not.toHaveBeenCalled();
    // The paused bot is restarted so it picks up the waiting message.
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith("setup"));
    // No second card asks again while the bot's own status catches up.
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
  });

  it("keeps the card signed out when the check after another sign-in still fails", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    dm = [repairReply()];
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-event-id="evt_repair"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const before = probe.mock.calls.length;
    announceRuntimeSignedIn("claude");
    await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThan(before));
    await settle(20);
    expect(card.dataset.phase).toBe("offered");
    expect(card.textContent).toContain("Claude Code is signed out");
    expect(start).not.toHaveBeenCalled();
  });

  it("checks again when the window comes back, so a sign-in outside the app turns the card fixed", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    dm = [repairReply()];
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-event-id="evt_repair"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    await settle(20);
    expect(card.dataset.phase).toBe("offered");

    // The person ran the tool's own login in a terminal, then came back.
    probeOk = true;
    const later = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(card.dataset.phase).toBe("fixed"));
    expect(card.textContent).toContain("You’re all set");
    expect(loginStart).not.toHaveBeenCalled();
  });

  it("stays out of the way when the bot's sign-in is fine", async () => {
    rows = [bot()];
    await openBotDm();
    await settle();
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
    expect(cards()).toHaveLength(0);
    noGrayBanner();
  });
});
