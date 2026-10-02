// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { BOT_CONNECTION_CARDS_STORAGE_KEY } from "../chat/messaging/connection-card-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * A new cloud bot's direct message: two cards under the bot's first message
 * (Slack, Connect your tools), the bot told about what gets connected on a
 * lane the person never sees, and the bot's suggested first jobs as buttons.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

/** The bot's company as the app knows it. A link to the web is built from its slug. */
const ACME = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: COMPANY,
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
} as unknown as Workspace;

const fence =(blocks: unknown[]): string => `\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks })}\n\`\`\``;

type Row = Record<string, unknown>;

/** Newest first, as the server returns a direct-message page. */
function thread(peerUid: string, helloExtra = ""): Row[] {
  return [
    { eventId: "e2", fromPersonUid: peerUid, fromDisplayName: "Nova", body: `Hi Corey, I am Nova.${helloExtra}`, createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
    {
      eventId: "e1",
      fromPersonUid: "prs_me",
      fromDisplayName: "Corey",
      body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }),
      createdAt: "2026-10-02T13:53:50.000Z",
      audience: "agent",
      replyCount: 1,
    },
  ];
}

function connection(over: Row = {}): Row {
  return {
    id: "acct_linear",
    provider: "factory:linear",
    status: "connected",
    createdBy: "prs_me",
    createdAt: "2026-10-02T14:10:00.000Z",
    updatedAt: "2026-10-02T14:10:00.000Z",
    access: { mode: "private", grantCount: 0 },
    installation: { displayName: "Linear" },
    ...over,
  };
}

interface World {
  thread: Row[];
  channel: Row[];
  slackCapability: string | null;
  connections: Row[];
  listFails: boolean;
  /** The companies the app knows. */
  companies: Workspace[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  grantConnectionAccess: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
  openUrl: Mock<(url: string) => void>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    thread: thread(NOVA),
    channel: [],
    slackCapability: null,
    connections: [],
    listFails: false,
    companies: [ACME],
    getStatus: vi.fn(async () =>
      ok({
        setupState: { phase: "ready" },
        agent: {
          companyUid: COMPANY,
          runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" },
          channels: w.slackCapability ? { slack: { appId: "A1" } } : null,
          channelDiagnostics: { slack: { inboundCapability: w.slackCapability ?? "unknown" } },
        },
      }),
    ),
    listConnections: vi.fn(async () =>
      w.listFails
        ? { ok: false as const, reason: "error" as const, code: "http-500", message: "boom" }
        : ok({
            companyUid: COMPANY,
            viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
            factoryEnabled: true,
            connections: w.connections,
            audit: [],
          }),
    ),
    grantConnectionAccess: vi.fn(async () => ok({ connectionId: "acct_linear" })),
    sendDm: vi.fn(async () => ok({ eventId: `sent_${Math.random().toString(36).slice(2)}` })),
    openUrl: vi.fn<(url: string) => void>(),
    ...over,
  };
  return w;
}

function adapter(w: World): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: w.channel, nextCursor: null }),
      fetchDmThread: async () => ok({ messages: w.thread }),
      sendDm: w.sendDm,
    },
    agents: { getStatus: w.getStatus },
    integrations: { listConnections: w.listConnections, grantConnectionAccess: w.grantConnectionAccess },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW = (peerUid: string): ConversationRow =>
  ({ id: `dm:${peerUid}`, kind: "dm", title: "Nova", personUid: peerUid, companyUid: null }) as ConversationRow;

async function mountRow(w: World, row: ConversationRow, waitForText: string): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(w),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: row,
      companies: w.companies,
      onopenurl: w.openUrl,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(waitForText));
  await settle();
}

/** A bot made in the New bot flow on this device, with its direct message open. */
async function mountNewBotDm(w: World): Promise<void> {
  window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
  await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalled());
  await settle();
}

async function unmountShell(): Promise<void> {
  if (component) await unmount(component);
  component = null;
  host.remove();
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const card = (target: "slack" | "tools"): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-testid="connection-card"][data-target="${target}"]`)!;
const primary = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]');
const decline = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]');
const allowButtons = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-testid="connection-card-allow"]')];
const note = (target: "slack" | "tools"): string =>
  card(target).querySelector('[data-testid="connection-card-note"]')?.textContent ?? "";
const chips = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')];
/** Messages the app sent the bot on the lane the person never sees. */
const hiddenNotices = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");

/** The window came back to the front: the cards ask the server again. */
async function refocus(): Promise<void> {
  window.dispatchEvent(new Event("focus"));
  await settle(20);
}

describe("DesktopApp connection cards in a cloud bot's direct message", () => {
  it("shows both cards under the bot's first message", async () => {
    const w = world();
    await mountNewBotDm(w);
    const hello = host.querySelector<HTMLElement>('[data-testid="conversation-message"][data-event-id="e2"]')!;
    const inHello = [...hello.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
    expect(inHello.map((el) => [el.dataset.target, el.dataset.state])).toEqual([
      ["slack", "offered"],
      ["tools", "offered"],
    ]);
    expect(card("slack").textContent).toContain("Talk to Nova in Slack and let it post there.");
    expect(card("tools").textContent).toContain("Add any app through HQ Integrations so Nova can work with it.");
    // The request the app sent the bot stays out of sight.
    expect(threadText()).not.toContain("Automatic message from HQ");
    // The first message is remembered, so the cards outlive the new-bots list.
    const stored = JSON.parse(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "{}");
    expect(stored[NOVA]?.helloEventId).toBe("e2");
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
  });

  it("opens HQ Integrations from Connect a tool and shows the card as connecting", async () => {
    const w = world();
    await mountNewBotDm(w);
    primary("tools")!.click();
    await settle();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    // By the company's slug, never its uid.
    expect(w.openUrl).toHaveBeenCalledWith("https://hq.computer/companies/acme/integrations");
    expect(card("tools").dataset.state).toBe("connecting");
    expect(card("tools").textContent).toContain("Finish in your browser. This card updates when a tool is connected.");
    expect(primary("tools")!.textContent?.trim()).toBe("Open again");
    // The other card is untouched.
    expect(card("slack").dataset.state).toBe("offered");
  });

  it("opens the web's front page, never a page named by the uid, for a company the app does not know", async () => {
    const w = world({ companies: [] });
    await mountNewBotDm(w);
    primary("tools")!.click();
    await settle();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(w.openUrl).toHaveBeenCalledWith("https://hq.computer");
    expect(w.openUrl.mock.calls.flat().join(" ")).not.toContain("cmp_");
    expect(card("tools").dataset.state).toBe("connecting");
  });

  it("offers a newly connected app to the bot, one press shares it and tells the bot once", async () => {
    const w = world();
    await mountNewBotDm(w);
    primary("tools")!.click();
    await settle();
    expect(allowButtons()).toHaveLength(0);

    // The person connected Linear in the browser and came back.
    w.connections = [connection()];
    await refocus();
    await vi.waitFor(() => expect(allowButtons()).toHaveLength(1));
    expect(card("tools").textContent).toContain("Linear");
    expect(allowButtons()[0]!.textContent?.trim()).toBe("Let Nova use it");
    // Nothing is said to the bot about a connection it cannot use yet.
    expect(hiddenNotices(w)).toHaveLength(0);

    let finishGrant: (value: unknown) => void = () => {};
    w.grantConnectionAccess.mockImplementationOnce(() => new Promise((resolve) => (finishGrant = resolve)));
    const allow = allowButtons()[0]!;
    allow.click();
    // A second press while the first is on its way does nothing.
    allow.click();
    await settle();
    expect(allow.disabled).toBe(true);
    finishGrant(ok({ connectionId: "acct_linear" }));
    await settle(20);

    expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1);
    expect(w.grantConnectionAccess).toHaveBeenCalledWith({
      companyUid: COMPANY,
      connectionId: "acct_linear",
      granteeUid: NOVA,
    });
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    const [to, body, extras] = hiddenNotices(w)[0]!;
    expect(to).toBe(NOVA);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `new-bot-conn-${NOVA}-acct_linear` });
    expect(body).toMatch(/^Automatic message from HQ: Corey just connected Linear/);
    expect(body).toContain("acct_linear");
    // The card now says the bot can use it, and the row is gone.
    await vi.waitFor(() => expect(card("tools").dataset.state).toBe("connected"));
    expect(card("tools").textContent).toContain("Nova can use: Linear.");
    expect(allowButtons()).toHaveLength(0);
    // Asking the server again does not tell the bot a second time.
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(1);
    expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1);
    // The notice never shows in the conversation.
    expect(threadText()).not.toContain("Automatic message from HQ");
  });

  it("a teammate's connection is never offered: only the person's own gets an allow button", async () => {
    const w = world();
    w.connections = [
      connection({ id: "acct_gmail_theirs", createdBy: "prs_teammate", installation: { displayName: "Gmail (Hassaan)" } }),
      connection({ id: "acct_anon", createdBy: undefined, installation: { displayName: "Notion (unknown)" } }),
      connection(),
    ];
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(allowButtons()).toHaveLength(1));
    const rows = [...card("tools").querySelectorAll<HTMLElement>('[data-testid="connection-card-row"]')];
    expect(rows.map((row) => row.dataset.connectionId)).toEqual(["acct_linear"]);
    expect(card("tools").textContent).not.toContain("Hassaan");
    expect(card("tools").textContent).not.toContain("Notion");
    expect(card("tools").querySelector('[data-testid="connection-card-more"]')).toBeNull();
  });

  it("says in one sentence why a share failed, and tells the bot nothing", async () => {
    const w = world({ connections: [connection()] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(allowButtons()).toHaveLength(1));

    w.grantConnectionAccess.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "http-403",
      message: "Only the connection owner or a company admin can manage access",
    });
    allowButtons()[0]!.click();
    await vi.waitFor(() =>
      expect(note("tools")).toBe("Only the person who connected Linear or a company admin can share it."),
    );
    expect(hiddenNotices(w)).toHaveLength(0);
    // The row stays, so the person can try again.
    expect(allowButtons()).toHaveLength(1);
    expect(threadText()).toContain("Hi Corey, I am Nova.");

    w.grantConnectionAccess.mockRejectedValueOnce(new Error("offline"));
    await vi.waitFor(() => expect(allowButtons()[0]!.disabled).toBe(false), { timeout: 3000 });
    allowButtons()[0]!.click();
    await vi.waitFor(() => expect(note("tools")).toBe("Could not share Linear. Try again."));
    expect(hiddenNotices(w)).toHaveLength(0);
    expect(allowButtons()).toHaveLength(1);
  });

  it("tells the bot about a new app that is open to everyone, without a share", async () => {
    const w = world();
    await mountNewBotDm(w);
    primary("tools")!.click();
    await settle();
    w.connections = [connection({ id: "acct_notion", provider: "factory:notion", installation: { displayName: "Notion" }, access: { mode: "everyone", grantCount: 0 } })];
    await refocus();
    await vi.waitFor(() => expect(card("tools").dataset.state).toBe("connected"));
    expect(card("tools").textContent).toContain("Nova can use: Notion.");
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    expect(hiddenNotices(w)[0]![2]).toEqual({ audience: "agent", idempotencyKey: `new-bot-conn-${NOVA}-acct_notion` });
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(1);
  });

  it("does not tell the bot about apps that were already connected", async () => {
    const w = world({ connections: [connection({ access: { mode: "everyone", grantCount: 0 } })] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("tools").dataset.state).toBe("connected"));
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(0);
  });

  it("shows Slack as connected when the bot can receive messages there", async () => {
    const w = world({ slackCapability: "ok" });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    expect(card("slack").textContent).toContain("Nova is in Slack.");
    expect(card("slack").querySelectorAll("button")).toHaveLength(0);
    // It was connected before the card was ever pressed: nothing to tell the bot.
    expect(hiddenNotices(w)).toHaveLength(0);
  });

  it("opens the bot's Slack setup from Connect Slack and tells the bot once when it connects", async () => {
    const w = world();
    await mountNewBotDm(w);
    primary("slack")!.click();
    await settle();
    expect(w.openUrl).toHaveBeenCalledWith(`https://hq.computer/companies/cmp_acme/agents?settings=${NOVA}`);
    expect(card("slack").dataset.state).toBe("connecting");

    // Installed, waiting for approval: still not connected.
    w.slackCapability = "pending-install";
    await refocus();
    expect(card("slack").dataset.state).toBe("connecting");
    await vi.waitFor(() => expect(note("slack")).toBe("Waiting for the app to be approved in Slack."));
    expect(hiddenNotices(w)).toHaveLength(0);

    w.slackCapability = "ok";
    await refocus();
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    const [to, body, extras] = hiddenNotices(w)[0]!;
    expect(to).toBe(NOVA);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `new-bot-slack-${NOVA}` });
    expect(body).toMatch(/^Automatic message from HQ: Corey just connected you to Slack\./);
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(1);
  });

  it("keeps Not now across a remount", async () => {
    const w = world();
    await mountNewBotDm(w);
    decline("slack")!.click();
    await settle();
    expect(card("slack").dataset.state).toBe("declined");
    expect(card("slack").querySelectorAll("button")).toHaveLength(0);
    expect(card("tools").dataset.state).toBe("offered");

    await unmountShell();
    const again = world();
    await mountRow(again, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(card("slack").dataset.state).toBe("declined");
    expect(card("slack").textContent).toContain("Not connected. Ask Nova about Slack any time.");
    expect(card("slack").querySelectorAll("button")).toHaveLength(0);
    expect(card("tools").dataset.state).toBe("offered");
  });

  it("offers a declined card again when the bot shows it in a newer message", async () => {
    const w = world();
    await mountNewBotDm(w);
    decline("slack")!.click();
    await settle();
    await unmountShell();

    const later = new Date(Date.now() + 60_000).toISOString();
    const again = world({
      thread: [
        { eventId: "e9", fromPersonUid: NOVA, fromDisplayName: "Nova", body: `I need Slack for that.${fence([{ kind: "connect", targets: ["slack"] }])}`, createdAt: later },
        ...thread(NOVA),
      ],
    });
    await mountRow(again, DM_ROW(NOVA), "I need Slack for that.");
    // The bot's own block replaces the cards under the first message.
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const offer = host.querySelector<HTMLElement>('[data-testid="conversation-message"][data-event-id="e9"]')!;
    expect(offer.querySelector<HTMLElement>('[data-testid="connection-card"]')?.dataset.state).toBe("offered");
    expect(threadText()).not.toContain("hq-block");
  });

  it("keeps the chat working when the server cannot list the apps", async () => {
    const w = world({ listFails: true });
    await mountNewBotDm(w);
    expect(threadText()).toContain("Hi Corey, I am Nova.");
    await vi.waitFor(() =>
      expect(note("tools")).toBe("Could not check your connected apps right now. You can still connect one."),
    );
    // The card stays usable.
    primary("tools")!.click();
    await settle();
    expect(w.openUrl).toHaveBeenCalledWith("https://hq.computer/companies/acme/integrations");
    expect(card("tools").dataset.state).toBe("connecting");
  });

  it("puts no cards under the messages of a bot that was not made here", async () => {
    const w = world();
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await settle(20);
    expect(cards()).toHaveLength(0);
    expect(w.listConnections).not.toHaveBeenCalled();
  });
});

describe("DesktopApp suggested replies from a cloud bot", () => {
  const SUGGESTIONS = fence([{ kind: "suggestions", items: ["Summarize our company files", "List our open projects"] }]);

  it("shows the newest message's suggestions as buttons, and a click sends the text", async () => {
    const w = world({ thread: thread(NOVA, SUGGESTIONS) });
    await mountNewBotDm(w);
    await vi.waitFor(() =>
      expect(chips().map((chip) => chip.textContent?.trim())).toEqual(
        expect.arrayContaining(["Summarize our company files", "List our open projects"]),
      ),
    );
    expect(threadText()).not.toContain("hq-block");
    chips()
      .find((chip) => chip.textContent?.trim() === "List our open projects")!
      .click();
    await vi.waitFor(() => expect(w.sendDm).toHaveBeenCalled());
    const [to, body, extras] = w.sendDm.mock.calls[0]!;
    expect(to).toBe(NOVA);
    expect(body).toBe("List our open projects");
    // Sent as the person, not on the bot-only lane.
    expect((extras as { audience?: string } | undefined)?.audience).toBeUndefined();
  });

  it("keeps the suggestions while the app tells the bot about a connection", async () => {
    const w = world({ thread: thread(NOVA, SUGGESTIONS), connections: [connection()] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(allowButtons()).toHaveLength(1));
    allowButtons()[0]!.click();
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    await settle();
    // The notice is not the person writing: the buttons stay.
    expect(chips().map((chip) => chip.textContent?.trim())).toEqual(
      expect.arrayContaining(["Summarize our company files", "List our open projects"]),
    );
  });
});

describe("DesktopApp outside a cloud bot's direct message", () => {
  const LOADED =
    "I need Slack for that." +
    fence([
      { kind: "connect", targets: ["slack", "tools"] },
      { kind: "suggestions", items: ["Summarize our company files", "List our open projects"] },
    ]);

  it("shows no cards and no suggestion buttons in a conversation with a person", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({
      thread: [
        { eventId: "p2", fromPersonUid: "prs_nova", fromDisplayName: "Nova", body: LOADED, createdAt: "2026-10-02T13:54:20.000Z" },
        { eventId: "p1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Hello there", createdAt: "2026-10-02T13:53:50.000Z" },
      ],
    });
    await mountRow(w, DM_ROW("prs_nova"), "I need Slack for that.");
    await settle(20);
    expect(cards()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
    expect(threadText()).not.toContain("hq-block");
    expect(w.listConnections).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY)).toBeNull();
  });

  it("shows no cards and no suggestion buttons in a channel", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({
      channel: [
        { eventId: "c2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: LOADED, createdAt: "2026-10-02T13:54:20.000Z" },
        { eventId: "c1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Hello there", createdAt: "2026-10-02T13:53:50.000Z" },
      ],
    });
    const row = { id: "ch:chn_team", kind: "channel", title: "team", channelId: "chn_team", channelScope: "channel", companyUid: COMPANY } as ConversationRow;
    await mountRow(w, row, "I need Slack for that.");
    await settle(20);
    expect(cards()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
    expect(threadText()).not.toContain("hq-block");
    expect(w.listConnections).not.toHaveBeenCalled();
  });
});
