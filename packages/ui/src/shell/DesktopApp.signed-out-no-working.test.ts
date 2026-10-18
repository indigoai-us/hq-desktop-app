// @vitest-environment happy-dom

/**
 * A local bot whose coding tool is signed out here cannot reply. The DM keeps
 * the existing "Claude Code is signed out" card and shows no "is thinking" or
 * "is still working" line for a message sent meanwhile. Once the tool signs
 * in, a sent message shows the working line as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, setJitterRandomForTests, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { requestConversation, takePendingConversation } from "../chat/pending-conversation.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { announceRuntimeSignedIn } from "../chat/messaging/runtime-repair.svelte.js";

const BOT_UID = "agt_LOCAL000000000000000000001";
const PAUSED = { state: "expired" as const, runtime: "claude" as const, since: "2026-09-15T10:00:00Z" };

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
let sent = 0;
/** The tool's own check: signed out until the test signs it in. */
let probeOk = false;

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
      fetchReactions: async () => ok({ reactions: [] }),
      sendDm: async () => {
        sent += 1;
        return ok({ eventId: `evt_self_${sent}`, createdAt: new Date().toISOString() });
      },
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    sessions: {
      preflight: async () =>
        ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: false, grokLoggedIn: false }),
      loginStart: async () => ok({ state: "connected" }),
      loginStatus: async () => ok({ state: "connected" }),
    },
    bots: {
      list: async () => ok({ bots: rows }),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      probe: async () => ok(probeOk ? { ok: true } : { ok: false, class: "signed-out" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  takePendingConversation();
  window.localStorage?.clear?.();
  window.localStorage?.setItem?.(WELCOME_SETUP_RUN_KEY, "1");
  sent = 0;
  probeOk = false;
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
  vi.useRealTimers();
  setJitterRandomForTests();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

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

async function send(text: string): Promise<void> {
  const before = sent;
  const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
  expect(composer, "composer renders for the bot's DM").toBeTruthy();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(sent).toBe(before + 1));
  await settle(10);
}

const thinkingRow = () => host.querySelector<HTMLElement>('[data-testid="agent-thinking-row"]');
const signInCard = () =>
  host.querySelector<HTMLElement>('[data-testid="bot-sign-in-card"] [data-testid="runtime-repair-card"]');

describe("DesktopApp signed-out bot shows no working line", () => {
  it("shows no working line for a sent message while the bot's tool is signed out, and keeps the signed-out card", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    await openBotDm();
    await vi.waitFor(() => expect(signInCard()).not.toBeNull());

    await send("hello");

    expect(thinkingRow()).toBeNull();
    expect(host.textContent).not.toContain("is thinking");
    expect(host.textContent).not.toContain("is still working");
    const card = signInCard();
    expect(card).not.toBeNull();
    expect(card!.dataset.phase).toBe("offered");
    expect(card!.textContent).toContain("Claude Code is signed out");
  });

  it("shows the working line for a sent message when the bot's tool is signed in", async () => {
    rows = [bot()];
    probeOk = true;
    await openBotDm();
    await settle(20);
    expect(signInCard()).toBeNull();

    await send("hello");

    await vi.waitFor(() => expect(thinkingRow()?.textContent).toContain("is thinking"));
  });

  it("shows the working line again once the tool signs in", async () => {
    rows = [bot({ runtimeSignIn: PAUSED })];
    await openBotDm();
    await vi.waitFor(() => expect(signInCard()).not.toBeNull());
    await send("hello");
    expect(thinkingRow()).toBeNull();

    // Settings, New Bot or the coding tools screen signed Claude Code in.
    probeOk = true;
    announceRuntimeSignedIn("claude");
    await settle(20);

    await send("are you there");
    await vi.waitFor(() => expect(thinkingRow()?.textContent).toContain("is thinking"));
  });

  it("hides a row from any other start while signed out, and shows it again once the tool signs in", async () => {
    // The bot's in-flight marker starts a row without a send.
    rows = [bot({ runtimeSignIn: PAUSED, busy: true })];
    await openBotDm();
    await vi.waitFor(() => expect(signInCard()).not.toBeNull());
    await settle(20);
    expect(thinkingRow()).toBeNull();

    probeOk = true;
    announceRuntimeSignedIn("claude");
    await vi.waitFor(() => expect(thinkingRow()?.textContent).toContain("is thinking"));
  });
});
