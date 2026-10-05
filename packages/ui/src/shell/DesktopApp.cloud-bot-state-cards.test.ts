// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus, type ChatWakeBus } from "../chat/chat-api.js";
import { buildAgentToolConnectedNotice } from "../chat/agent-channel.js";
import { clearRichContentMemo } from "../chat/messaging/richMessageContent.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * Cards the bot generated (bot-generated connection cards, PR 6).
 *
 * A runtime with `show_connection_cards` state sends each card's state with
 * the message, in `richContent`. The app draws those cards from that state
 * and what it knows about the person looking, with no read of the company's
 * list. It reads the live state only when the person presses a card, or when
 * a connection-changed notice for the bot arrives. A card with no state (an
 * old message, an old runtime) is drawn as before, from the list.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const workspace = (role: string): Workspace =>
  ({
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: COMPANY,
    bucketName: null,
    hasLocalFolder: true,
    localPath: null,
    membershipStatus: "active",
    role,
    lastSyncedAt: null,
    brokenReason: null,
  }) as unknown as Workspace;

type Row = Record<string, unknown>;

const AS_OF = "2026-10-02T14:00:20.000Z";

const mine = (eventId: string, body: string, second: number): Row => ({
  eventId,
  fromPersonUid: "prs_me",
  fromDisplayName: "Corey",
  body,
  createdAt: `2026-10-02T14:00:${String(second).padStart(2, "0")}.000Z`,
});
/** A bot message whose cards travel in `richContent`, the body readable on its own. */
const novaCards = (eventId: string, items: unknown[], second: number, body = "Here is what we can connect."): Row => ({
  eventId,
  fromPersonUid: NOVA,
  fromDisplayName: "Nova",
  body,
  richContent: { v: 1, blocks: [{ kind: "connect", items }] },
  createdAt: `2026-10-02T14:00:${String(second).padStart(2, "0")}.000Z`,
});
const page = (...oldestFirst: Row[]): Row[] => [...oldestFirst].reverse();

const SLACK_ABSENT = { app: "slack", slack: { installed: "absent" }, asOf: AS_OF };
const SLACK_IN = { app: "slack", slack: { installed: "installed", workspaceName: "Acme" }, asOf: AS_OF };
/** Linear, connected by the person looking, not shared with the bot yet. */
const LINEAR_MINE = {
  domain: "linear.app",
  why: "Track your issues",
  state: { connected: true, usableByBot: false, connectionId: "acct_linear", createdByPersonUid: "prs_me", accessMode: "private" },
  asOf: AS_OF,
};
const LINEAR_USABLE = { ...LINEAR_MINE, state: { ...LINEAR_MINE.state, usableByBot: true } };
const LINEAR_TEAMMATE = { ...LINEAR_MINE, state: { ...LINEAR_MINE.state, createdByPersonUid: "prs_teammate" } };
const NOTION_OFF = { domain: "notion.so", why: "Read your docs", state: { connected: false, usableByBot: false }, asOf: AS_OF };

/** The live list: Linear as the person's own private connection. */
const LINEAR_ROW: Row = {
  id: "acct_linear",
  provider: "factory:linear",
  status: "connected",
  createdBy: "prs_me",
  createdAt: "2026-10-02T13:00:00.000Z",
  access: { mode: "private", grantCount: 0 },
  installation: { displayName: "Linear", domain: "linear.app" },
};
const list = (rows: Row[] = [LINEAR_ROW]) => ({
  companyUid: COMPANY,
  viewer: { personUid: "prs_me", role: "owner", canManageIntegrations: true },
  factoryEnabled: true,
  connections: rows,
  audit: [],
});
const STATUS = {
  setupState: { phase: "ready" },
  agent: { companyUid: COMPANY, runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" }, channels: null, channelDiagnostics: { slack: { inboundCapability: "unknown" } } },
};
const NOTION_MATCH: Row = { name: "Notion", domain: "notion.so", mcpReady: true, authClass: "oauth", source: "integrations.sh" };

interface World {
  thread: Row[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  catalogSearch: ReturnType<typeof vi.fn>;
  grantConnectionAccess: ReturnType<typeof vi.fn>;
  startOAuth: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
}

function world(thread: Row[], over: Partial<World> = {}): World {
  return {
    thread,
    getStatus: vi.fn(async () => ok(STATUS)),
    listConnections: vi.fn(async () => ok(list())),
    catalogSearch: vi.fn(async (_company: string, query: string) =>
      ok({ ok: true, companyUid: COMPANY, entries: query === "notion.so" ? [NOTION_MATCH] : [] }),
    ),
    grantConnectionAccess: vi.fn(async () => ok({})),
    startOAuth: vi.fn(async () => ok({ authorizationUrl: "https://auth.example.org/start" })),
    sendDm: vi.fn(async () => ok({ eventId: "sent_1" })),
    ...over,
  };
}

function adapter(w: World): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: w.thread }),
      sendDm: w.sendDm,
    },
    agents: { getStatus: w.getStatus },
    integrations: {
      listConnections: w.listConnections,
      grantConnectionAccess: w.grantConnectionAccess,
      catalogSearch: w.catalogSearch,
      startOAuth: w.startOAuth,
    },
    settings: { getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }) },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  clearRichContentMemo();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
  clearRichContentMemo();
});

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW = { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: COMPANY } as ConversationRow;

async function mountDm(w: World, options: { role?: string; wakes?: ChatWakeBus; opened?: string } = {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(w),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: DM_ROW,
      companies: [workspace(options.role ?? "owner")],
      wakes: options.wakes ?? createChatWakeBus(),
      coreFixtures: false,
      onopenurl: () => {},
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(options.opened ?? "Hello"));
  await settle();
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const ids = (): string[] => cards().map((card) => card.dataset.domain ?? card.dataset.target ?? "");
const card = (id: string): HTMLElement | null => cards().find((c) => (c.dataset.domain ?? c.dataset.target) === id) ?? null;
const line = (id: string): string => card(id)?.querySelector('[data-testid="connection-card-line"]')?.textContent?.trim() ?? "";
const primary = (id: string): HTMLButtonElement | null =>
  card(id)?.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]') ?? null;

const HELLO = mine("p1", "Hello", 1);

describe("DesktopApp: cards drawn from the bot's state", () => {
  it("draws every card from the state the bot sent, Slack first, with no read of the list", async () => {
    const w = world(page(HELLO, novaCards("b1", [LINEAR_MINE, NOTION_OFF, SLACK_ABSENT], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    expect(line("slack")).toBe("Talk to Nova in Slack and let it post there.");
    expect(line("linear.app")).toBe("Let Nova use it?");
    expect(primary("linear.app")?.textContent?.trim()).toBe("Let Nova use it");
    expect(line("notion.so")).toBe("Connect Notion so Nova can use it.");
    // The body is shown as the bot wrote it.
    expect(threadText()).toContain("Here is what we can connect.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    expect(w.listConnections).not.toHaveBeenCalled();
    expect(w.catalogSearch).not.toHaveBeenCalled();
  });

  it("says what each state means for the person looking", async () => {
    const w = world(page(HELLO, novaCards("b1", [SLACK_IN, LINEAR_USABLE, NOTION_OFF], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    expect(line("slack")).toBe("Nova is in Slack.");
    expect(line("linear.app")).toBe("Nova can use it.");
    expect(primary("linear.app")).toBeNull();
    expect(w.listConnections).not.toHaveBeenCalled();
  });

  it("a teammate's connection asks for a share, and a member is sent to an admin to connect", async () => {
    const w = world(page(HELLO, novaCards("b1", [SLACK_ABSENT, LINEAR_TEAMMATE, NOTION_OFF], 20)));
    await mountDm(w, { role: "member" });
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    expect(line("linear.app")).toBe("A teammate connected this. Ask them to share it with Nova.");
    expect(primary("linear.app")).toBeNull();
    expect(line("notion.so")).toBe("Ask a company admin to connect Notion.");
    expect(primary("notion.so")).toBeNull();
    expect(w.listConnections).not.toHaveBeenCalled();
  });

  it("keeps Slack first and three cards when the bot sent more, Slack last", async () => {
    const figma = { domain: "figma.com", state: { connected: false, usableByBot: false }, asOf: AS_OF };
    const w = world(page(HELLO, novaCards("b1", [LINEAR_MINE, NOTION_OFF, SLACK_ABSENT, figma], 20)));
    await mountDm(w);
    // The parser keeps the first three items; the row puts the bot's Slack first.
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    expect(cards()).toHaveLength(3);
  });

  it("a press reads the live list first, then shares the connection it found", async () => {
    const w = world(page(HELLO, novaCards("b1", [SLACK_ABSENT, LINEAR_MINE, NOTION_OFF], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(primary("linear.app")).not.toBeNull());
    expect(w.listConnections).not.toHaveBeenCalled();
    primary("linear.app")!.click();
    await vi.waitFor(() => expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1));
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(w.listConnections.mock.invocationCallOrder[0]!).toBeLessThan(w.grantConnectionAccess.mock.invocationCallOrder[0]!);
    expect(w.grantConnectionAccess).toHaveBeenCalledWith({ companyUid: COMPANY, connectionId: "acct_linear", granteeUid: NOVA });
    await vi.waitFor(() => expect(line("linear.app")).toBe("Nova can use it."));
  });

  it("a press whose live read shows the state moved on does not act, and the card shows the live state", async () => {
    // Since the bot wrote, the person opened Linear to everyone.
    const open = { ...LINEAR_ROW, access: { mode: "everyone" } };
    const w = world(page(HELLO, novaCards("b1", [SLACK_ABSENT, LINEAR_MINE, NOTION_OFF], 20)), {
      listConnections: vi.fn(async () => ok(list([open]))),
    });
    await mountDm(w);
    await vi.waitFor(() => expect(primary("linear.app")).not.toBeNull());
    primary("linear.app")!.click();
    await vi.waitFor(() => expect(line("linear.app")).toBe("Nova can use it."));
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
  });

  it("Connect on a state card reads the list and the catalog, then starts the connection", async () => {
    const w = world(page(HELLO, novaCards("b1", [SLACK_ABSENT, LINEAR_MINE, NOTION_OFF], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(primary("notion.so")).not.toBeNull());
    primary("notion.so")!.click();
    await vi.waitFor(() => expect(w.startOAuth).toHaveBeenCalledTimes(1));
    expect(w.listConnections).toHaveBeenCalled();
    expect(w.catalogSearch).toHaveBeenCalledWith(COMPANY, "notion.so", 20);
    expect(w.startOAuth.mock.calls[0]![0]).toMatchObject({ companyUid: COMPANY, domain: "notion.so" });
  });

  it("a mixed row: the items with state draw from it, the one without from the list", async () => {
    // The bot says it can use Linear; the list alone would say it is private and not shared.
    const legacyNotion = { domain: "notion.so", why: "Read your docs" };
    const w = world(page(HELLO, novaCards("b1", [SLACK_IN, LINEAR_USABLE, legacyNotion], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    // The item with no state needs the list (and the catalog): it is read.
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(line("linear.app")).toBe("Nova can use it.");
    // The status says no Slack; the bot's state says it is in Slack.
    expect(line("slack")).toBe("Nova is in Slack.");
    expect(line("notion.so")).toBe("Connect Notion so Nova can use it.");
  });

  it("an old message with no state keeps today's path: the list is read and the card drawn from it", async () => {
    const fence = `Here is what we can connect.\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks: [{ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }] })}\n\`\`\``;
    const old: Row = { eventId: "b1", fromPersonUid: NOVA, fromDisplayName: "Nova", body: fence, createdAt: "2026-10-02T14:00:20.000Z" };
    const w = world(page(HELLO, old));
    await mountDm(w);
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app"]));
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(line("linear.app")).toBe("Let Nova use it?");
    expect(threadText()).not.toContain("hq-block");
  });

  it("a connection-changed notice newer than the bot's state reads the live state once", async () => {
    const notice = mine("n1", buildAgentToolConnectedNotice({ personName: "Corey", name: "Linear", connectionId: "acct_linear" }), 40);
    const open = { ...LINEAR_ROW, access: { mode: "everyone" } };
    const w = world(page(HELLO, novaCards("b1", [SLACK_ABSENT, LINEAR_MINE, NOTION_OFF], 20), notice), {
      listConnections: vi.fn(async () => ok(list([open]))),
    });
    await mountDm(w);
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(line("linear.app")).toBe("Nova can use it."));
    await settle();
    expect(w.listConnections).toHaveBeenCalledTimes(1);
  });

  it("a notice older than the bot's state reads nothing", async () => {
    const notice = mine("n1", buildAgentToolConnectedNotice({ personName: "Corey", name: "Linear", connectionId: "acct_linear" }), 10);
    const w = world(page(HELLO, notice, novaCards("b1", [SLACK_ABSENT, LINEAR_MINE, NOTION_OFF], 20)));
    await mountDm(w);
    await vi.waitFor(() => expect(ids()).toEqual(["slack", "linear.app", "notion.so"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    expect(w.listConnections).not.toHaveBeenCalled();
  });
});
