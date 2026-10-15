// @vitest-environment happy-dom

/**
 * A local bot's DM offers one fix for its coding tool, never two. A cold VM
 * had Claude Code installed but signed out: the DM drew the signed-out repair
 * card and, under it, "Quill needs Claude Code on this Mac to answer" with an
 * Install Claude button, because that strip read "not signed in" as "not
 * installed". Installed but signed out shows the repair card only; missing
 * shows the install strip only; installed and signed in shows neither.
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

const BOT_UID = "agt_LOCAL000000000000000000001";

function bot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    displayName: "Quill",
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
  } as LocalBotRow;
}

let rows: LocalBotRow[] = [];
let dm: unknown[] = [];
let claudeInstalled = true;
let claudeSignedIn = false;

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
    // Still null in the guide, as on the VM: "Checking whether Claude Code is on this Mac…".
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    sessions: {
      preflight: async () =>
        ok({
          claudeAvailable: claudeInstalled,
          claudeLoggedIn: claudeInstalled && claudeSignedIn,
          claudeStatus: { state: !claudeInstalled ? "notInstalled" : claudeSignedIn ? "signedIn" : "signedOut" },
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: async () => ok({ state: "waiting" }),
    },
    bots: {
      list: async () => ok({ bots: rows }),
      create: async () => ok({}),
      start: vi.fn(async () => ok({})),
      stop: vi.fn(async () => ok({})),
      remove: async () => ok({}),
      probe: vi.fn(async () => ok({ ok: false, class: "signed-out" })),
    },
  } as unknown as PlatformAdapter;
}

function installGuide() {
  return {
    oninstall: vi.fn(async () => ({ ok: true })),
    onsignin: vi.fn(() => new Promise<{ ok: boolean }>(() => undefined)),
    onrefresh: vi.fn(async () => undefined),
    downloadUrlFor: () => "https://claude.com/download",
    onopen: vi.fn(() => undefined),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  takePendingConversation();
  window.localStorage?.clear?.();
  window.localStorage?.setItem?.(WELCOME_SETUP_RUN_KEY, "1");
  rows = [bot()];
  dm = [];
  claudeInstalled = true;
  claudeSignedIn = false;
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
  setJitterRandomForTests();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function openBotDm(): Promise<void> {
  requestConversation({ personUid: BOT_UID, email: "", displayName: "Quill" });
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
              displayName: "Quill",
              lastMessageAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      },
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      initialRow: { id: `dm:${BOT_UID}`, kind: "dm", title: "Quill", personUid: BOT_UID, companyUid: null } as ConversationRow,
      coreFixtures: false,
      setupInstallGuide: installGuide(),
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Quill");
  });
  // Let the tools check and the conversation load before reading the DM.
  await settle(30);
}

/** The bot's own signed-out reply, as hq-cli posted it on the VM. */
function repairReply() {
  return {
    eventId: "evt_repair",
    fromPersonUid: BOT_UID,
    fromDisplayName: "Quill",
    body: "Claude Code is signed out on this Mac. Sign in, then send your message again.",
    createdAt: "2026-10-15T10:00:05.000Z",
    direction: "in",
    richContent: {
      v: 1,
      blocks: [{ v: 1, kind: "runtime-repair", class: "signed-out", runtime: "claude", action: "signIn", botName: "setup" }],
    },
  };
}

const repairCards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="runtime-repair-card"]')];
const strip = () => host.querySelector('[data-testid="bot-needs-coding-tool"]');

function noInstallStrip(): void {
  expect(strip()).toBeNull();
  expect(host.querySelector('[data-testid="bot-needs-coding-tool-guide"]')).toBeNull();
  expect(host.textContent).not.toContain("needs Claude Code on this");
  expect(host.textContent).not.toContain("Install Claude");
  expect(host.textContent).not.toContain("Checking whether Claude Code");
}

describe("a local bot's DM offers one fix for its coding tool", () => {
  it("installed but signed out, with the bot's own repair card: that card only, no install strip", async () => {
    // The VM: the bot list has not reported the expired sign-in yet.
    dm = [repairReply()];
    await openBotDm();
    await vi.waitFor(() => expect(repairCards()).toHaveLength(1));
    expect(repairCards()[0]!.textContent).toContain("Claude Code is signed out");
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
    noInstallStrip();
  });

  it("installed but signed out, with no card in the conversation: the sign-in card only", async () => {
    await openBotDm();
    const card = await vi.waitFor(() => {
      const el = host.querySelector<HTMLElement>('[data-testid="bot-sign-in-card"] [data-testid="runtime-repair-card"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(repairCards()).toHaveLength(1);
    expect(card.textContent).toContain("Claude Code is signed out");
    noInstallStrip();
  });

  it("installed with an expired sign-in: the repair card only", async () => {
    rows = [bot({ runtimeSignIn: { state: "expired", runtime: "claude", since: "2026-10-15T10:00:00Z" } })];
    dm = [repairReply()];
    await openBotDm();
    await vi.waitFor(() => expect(repairCards()).toHaveLength(1));
    noInstallStrip();
  });

  it("not installed: the install strip only, no repair card", async () => {
    claudeInstalled = false;
    await openBotDm();
    await vi.waitFor(() => expect(strip()).not.toBeNull());
    // The test host has no OS, so the noun is "computer" here and "Mac" on a Mac.
    expect(strip()!.textContent).toContain(
      "Quill needs Claude Code on this computer to answer. Install it and sign in here, and Quill picks up from there.",
    );
    expect(host.querySelector('[data-testid="bot-needs-coding-tool-guide"]')).not.toBeNull();
    expect(repairCards()).toHaveLength(0);
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
  });

  it("installed and signed in: neither", async () => {
    claudeSignedIn = true;
    await openBotDm();
    await settle(30);
    expect(repairCards()).toHaveLength(0);
    expect(host.querySelector('[data-testid="bot-sign-in-card"]')).toBeNull();
    noInstallStrip();
  });
});
