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
import { createChatWakeBus, type ChatWakeBus } from "../chat/chat-api.js";
import type { Workspace } from "../chat/workspaces.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
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

const loading = () => new Promise<never>(() => {});

function adapter(messages: Array<Record<string, unknown>>, claim?: (slug: string) => Promise<unknown>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    company: claim
      ? {
          claimPendingInvite: claim,
          // The company page this test opens stays loading; it is not under test.
          getSummary: loading,
          getBoard: loading,
          getActivity: loading,
          getDeployments: loading,
          getSecrets: loading,
        }
      : undefined,
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
  // Opening a channel row stashes it at module level for the next host; a test
  // that switches rows must not hand that channel to the next test's mount.
  takePendingChannelOpen();
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

interface OpenOptions {
  wakes?: ChatWakeBus;
  companies?: Workspace[];
  claim?: (slug: string) => Promise<unknown>;
}

async function openSetupDm(messages: Array<Record<string, unknown>>, options: OpenOptions = {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(messages, options.claim),
      wakes: options.wakes ?? null,
      companies: options.companies ?? null,
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

/** The settled line, as a badge on one message. */
const settledOn = (eventId: string) => q(`[data-event-id="${eventId}"] [data-testid="rich-badge"]`);

function pendingInvite(slug: string, displayName: string): Workspace {
  return {
    slug,
    displayName,
    kind: "company",
    state: "cloud-only",
    cloudUid: `cmp_${slug}`,
    role: "member",
    membershipStatus: "pending",
  } as Workspace;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

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
    await vi.waitFor(() => expect(settledOn("evt_team")?.textContent).toContain("Working solo"));
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
    expect(settledOn("evt_team")).toBeNull();
    retry.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(sendDm.mock.calls[1])).toContain("Just me for now.");
    await vi.waitFor(() => expect(settledOn("evt_team")?.textContent).toContain("Working solo"));
  });

  it("a join that resolves after the person opened another conversation still replies to the setup bot, with a key", async () => {
    const claim = deferred<unknown>();
    const claimInvite = vi.fn(() => claim.promise);
    await openSetupDm([teamMessage], { companies: [pendingInvite("acme", "Acme Robotics")], claim: claimInvite });
    const join = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="team-card-join"]');
      expect(el).toBeTruthy();
      return el!;
    });
    join.click();
    await vi.waitFor(() => expect(claimInvite).toHaveBeenCalledWith("acme"));
    // The person opens another conversation while the join is on the network.
    const other = await vi.waitFor(() => {
      const el = [...host.querySelectorAll<HTMLElement>("[data-conversation-id]")].find(
        (row) => row.getAttribute("data-conversation-id") !== SETUP_DM_ROW.id,
      );
      expect(el).toBeTruthy();
      return el!;
    });
    other.click();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).not.toContain("setup"));
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')).toBeNull());
    claim.resolve(ok({ companyUid: "cmp_acme" }));
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    const [to, text, extras] = sendDm.mock.calls[0]!;
    expect(to).toBe(SETUP_UID);
    expect(text).toBe("I joined Acme Robotics.");
    expect(extras).toEqual({ idempotencyKey: `first-run-team:${SETUP_UID}:invite:acme` });
  });

  it("the settled line stays on the card's message when the bot writes again", async () => {
    const wakes = createChatWakeBus();
    const messages: Array<Record<string, unknown>> = [teamMessage];
    await openSetupDm(messages, { wakes });
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="team-card-personal"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await vi.waitFor(() => expect(settledOn("evt_team")?.textContent).toContain("Working solo"));
    const later = new Date(Date.now() + 60_000).toISOString();
    messages.push({ ...offerMessage, eventId: "evt_later", body: "Nice. Let's set up your tools.", createdAt: later });
    wakes.emit("dm:new-message", { fromPersonUid: SETUP_UID, eventId: "evt_later", createdAt: later, direction: "in" });
    const laterEl = await vi.waitFor(() => {
      const el = q('[data-event-id="evt_later"]');
      expect(el).toBeTruthy();
      return el!;
    });
    await settle();
    const badges = [...host.querySelectorAll('[data-testid="rich-badge"], [data-testid="team-card-settled"]')].filter((el) =>
      el.textContent?.includes("Working solo"),
    );
    expect(badges).toHaveLength(1);
    expect(q('[data-event-id="evt_team"]')!.contains(badges[0]!)).toBe(true);
    // Not drawn after the later message.
    expect(laterEl.compareDocumentPosition(badges[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(0);
  });

  it("draws no card for a first message without the block when no handoff was sent here", async () => {
    await openSetupDm([offerMessage]);
    await settle();
    expect(q('[data-testid="team-card"]')).toBeNull();
  });
});
