// @vitest-environment happy-dom

/**
 * The setup bot's first message can offer to continue setup in a coding tool
 * the person already uses a lot ("I see you use Claude Code a lot. Want to
 * continue setup there?", with a `continueInTool` hq-block from hq-cli). The
 * app draws a two-button card under it:
 *   - "Continue in Claude Code" opens the HQ folder in Claude Code through the
 *     same launch cascade as the title-bar Launch menu, with a plain-language
 *     setup request pre-filled;
 *   - "Keep going here" sends the reply the bot waits for.
 * Telemetry: shown, continued and kept-here, with the tool and flags only.
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
const OFFER =
  "I see you use Claude Code a lot. Want to continue setup there?\n\n" +
  "```hq-block\n" +
  '{"v":1,"blocks":[{"kind":"continueInTool","tool":"claude"},{"kind":"suggestions","items":["Keep going here"]}]}' +
  "\n```";

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
      detectAiTools: async () =>
        ok({ claude_cli: true, claude_desktop: true, codex_cli: false, codex_desktop: false, grok_cli: false, any: true }),
      openClaudeCodeLink,
      launchClaudeCode: async () => ok(undefined),
      launchCodexWorkspace: async () => ok(undefined),
      launchCliInTerminal: async () => ok(undefined),
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

describe("the setup bot's coding tool offer", () => {
  it("shows the card under the offer, without a duplicate Keep going here reply chip, and records it shown once", async () => {
    await openSetupDm([offerMessage]);
    const card = await vi.waitFor(() => {
      const el = q('[data-testid="setup-tool-offer"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain("Continue in Claude Code");
    expect(card.textContent).toContain("Keep going here");
    expect(q('[data-testid="suggested-replies"]')).toBeNull();
    await settle();
    expect(events).toEqual([{ action: "shown", tool: "claude" }]);
  });

  it("Continue in Claude Code opens the HQ folder in Claude Code with the plain-language setup request", async () => {
    await openSetupDm([offerMessage]);
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="setup-tool-offer-continue"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await vi.waitFor(() => expect(openClaudeCodeLink).toHaveBeenCalledOnce());
    const url = new URL(String(openClaudeCodeLink.mock.calls[0]![0]));
    expect(url.searchParams.get("q")).toBe(SETUP_CONTINUE_IN_TOOL_PROMPT);
    expect(url.searchParams.get("folder")).toBe("/tmp/HQ");
    expect(sendDm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toContainEqual({ action: "continued", tool: "claude", launched: true }));
  });

  it("Keep going here sends the reply the bot waits for", async () => {
    await openSetupDm([offerMessage]);
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="setup-tool-offer-keep"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalled());
    expect(JSON.stringify(sendDm.mock.calls[0])).toContain("Keep going here");
    expect(openClaudeCodeLink).not.toHaveBeenCalled();
    expect(events).toContainEqual({ action: "keptHere", tool: "claude" });
  });

  it("shows nothing once the person has answered, or when the bot made no offer", async () => {
    await openSetupDm([
      offerMessage,
      { eventId: "evt_me", body: "Keep going here", fromPersonUid: "prs_me", fromDisplayName: "Corey", createdAt: "2026-10-02T10:01:00.000Z", direction: "out" },
    ]);
    await settle(20);
    expect(q('[data-testid="setup-tool-offer"]')).toBeNull();
    if (component) await unmount(component);
    component = null;
    host.remove();

    await openSetupDm([{ ...offerMessage, body: "Your tools are all here. Do you want me to explain HQ to you?" }]);
    await settle(20);
    expect(q('[data-testid="setup-tool-offer"]')).toBeNull();
    expect(events).toEqual([]);
  });
});
