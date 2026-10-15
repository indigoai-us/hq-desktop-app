// @vitest-environment happy-dom

/**
 * The setup bot's first message carries a `team` hq-block from hq-cli; the app
 * draws "Who do you work with?" under it. A pick replies to the bot and the
 * card settles into one line. Harness copied from the coding tool offer suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, SETUP_TOOL_OFFER_EVENT, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_CONTINUE_IN_TOOL_PROMPT } from "../chat/setup-bot.js";

const SETUP_UID = "agt_setup_offer";
const offerFor = (tool: "claude" | "codex") =>
  "Hi, I'm Pickles, your setup bot.\n\n" +
  `Looks like you use the ${tool === "claude" ? "Claude" : "Codex"} app. Want to continue setup there?\n\n` +
  "```hq-block\n" +
  `{"v":1,"blocks":[{"kind":"continueInTool","tool":"${tool}"},{"kind":"suggestions","items":["Keep going here"]}]}` +
  "\n```";
const OFFER = offerFor("claude");

function botRow(): LocalBotRow {
  return {
    name: "setup",
    agentUid: SETUP_UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 42,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date().toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    workerId: "setup",
  } as LocalBotRow;
}

const SETUP_DM_ROW = { id: `dm:${SETUP_UID}`, kind: "dm", title: "setup", personUid: SETUP_UID } as ConversationRow;

let sendDm: ReturnType<typeof vi.fn>;
let openClaudeCodeLink: ReturnType<typeof vi.fn>;
let launchCodexWorkspace: ReturnType<typeof vi.fn>;
let launchCliInTerminal: ReturnType<typeof vi.fn>;
let launchClaudeCode: ReturnType<typeof vi.fn>;
let aiTools: Record<string, boolean>;
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let events: unknown[] = [];
const record = (e: Event) => events.push((e as CustomEvent).detail);

function adapter(messages: Array<Record<string, unknown>>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [...messages].reverse() }),
      fetchDmThread: async () => ok({ messages: [...messages].reverse() }),
      sendDm,
      sendChannelMessage: async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }),
      fetchReactions: async () => ok({ reactions: [] }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ok(aiTools),
      openClaudeCodeLink,
      launchClaudeCode,
      launchCodexWorkspace,
      launchCliInTerminal,
    },
    sessions: {
      preflight: async () =>
        ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: false, grokLoggedIn: false }),
    },
    bots: {
      list: async () => ok({ bots: [botRow()] }),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
    },
  } as unknown as PlatformAdapter;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  sendDm = vi.fn(async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }));
  openClaudeCodeLink = vi.fn(async () => ok(undefined));
  launchCodexWorkspace = vi.fn(async () => ok(undefined));
  launchCliInTerminal = vi.fn(async () => ok(undefined));
  launchClaudeCode = vi.fn(async () => ok(undefined));
  aiTools = { claude_cli: true, claude_desktop: true, codex_cli: true, codex_desktop: true, grok_cli: false, any: true };
  events = [];
  window.addEventListener(SETUP_TOOL_OFFER_EVENT, record);
});

afterEach(async () => {
  window.removeEventListener(SETUP_TOOL_OFFER_EVENT, record);
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);

async function openSetupDm(messages: Array<Record<string, unknown>>): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(messages),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      coreFixtures: false,
      initialRow: SETUP_DM_ROW,
    },
  });
  await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
}

const offerMessage = { eventId: "evt_offer", body: OFFER, fromPersonUid: SETUP_UID, fromDisplayName: "setup", createdAt: "2026-10-02T10:00:00.000Z", direction: "in" };

const TEAM_FIRST =
  "Hi, I'm Pickles, your setup bot.\n\n" + "```hq-block\n" + JSON.stringify({ v: 1, blocks: [{ kind: "team" }] }) + "\n```";
const teamMessage = { ...offerMessage, eventId: "evt_team", body: TEAM_FIRST };

describe("the setup bot's team card", () => {
  it("draws the card under the bot's first message when it carries the team block", async () => {
    await openSetupDm([teamMessage]);
    const card = await vi.waitFor(() => {
      const el = q('[data-testid="team-card"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain("Just me for now");
  });

  it("Just me for now replies to the bot and settles into Working solo", async () => {
    await openSetupDm([teamMessage]);
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="team-card-personal"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    expect(JSON.stringify(sendDm.mock.calls[0])).toContain("Just me for now.");
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Working solo"));
  });

  it("a failed reply to the bot shows Retry, and Retry sends the reply again", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    await openSetupDm([teamMessage]);
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="team-card-personal"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    const retry = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="team-card-retry"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(q('[data-testid="team-card-settled"]')).toBeNull();
    retry.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(sendDm.mock.calls[1])).toContain("Just me for now.");
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Working solo"));
  });

  it("draws no card for a first message without the block when no handoff was sent here", async () => {
    await openSetupDm([offerMessage]);
    await settle();
    expect(q('[data-testid="team-card"]')).toBeNull();
  });
});
