// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { BOT_CONNECTION_CARDS_STORAGE_KEY, SLACK_ADMIN_LINE } from "../chat/messaging/connection-card-model.js";
import { BOT_HELLO_ASKED_STORAGE_KEY } from "../chat/cloud-bot-hello-asked.js";
import { brandMarkFor } from "../chat/messaging/app-brand-marks.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * A new cloud bot's direct message: the cards the app chooses under the
 * bot's first message when the bot's hello carries no connect block (Slack,
 * then the person's own connected apps the bot cannot use yet), the bot told
 * about what gets shared on a lane the person never sees, and the bot's
 * suggested first jobs as buttons. The cards for apps a bot names itself are
 * in DesktopApp.cloud-bot-integration-cards.test.ts.
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
    installation: { displayName: "Linear", domain: "linear.app" },
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
  catalogSearch: ReturnType<typeof vi.fn>;
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
    catalogSearch: vi.fn(async () => ok({ ok: true, companyUid: COMPANY, entries: [] })),
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
    integrations: {
      listConnections: w.listConnections,
      grantConnectionAccess: w.grantConnectionAccess,
      catalogSearch: w.catalogSearch,
    },
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

async function mountRow(w: World, row: ConversationRow, waitForText: string, wakes = createChatWakeBus()): Promise<void> {
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
      wakes,
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
  await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
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
const appCard = (domain: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="connection-card"][data-domain="${domain}"]`);
const primary = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]');
const appPrimary = (domain: string) => appCard(domain)?.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]') ?? null;
const decline = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]');
const appNote = (domain: string): string =>
  appCard(domain)?.querySelector('[data-testid="connection-card-note"]')?.textContent ?? "";
const note = (target: "slack" | "tools"): string =>
  card(target).querySelector('[data-testid="connection-card-note"]')?.textContent ?? "";
const chips = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')];
const browseLink = (): HTMLAnchorElement | null => host.querySelector<HTMLAnchorElement>('[data-testid="rich-connect-browse"]');
/** Messages the app sent the bot on the lane the person never sees. */
const hiddenNotices = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");

/** The window came back to the front: the cards ask the server again. */
async function refocus(): Promise<void> {
  window.dispatchEvent(new Event("focus"));
  await settle(20);
}

describe("DesktopApp connection cards in a cloud bot's direct message", () => {
  it("shows the Slack card under the bot's first message when nothing is connected", async () => {
    const w = world();
    await mountNewBotDm(w);
    const hello = host.querySelector<HTMLElement>('[data-testid="conversation-message"][data-event-id="e2"]')!;
    const inHello = [...hello.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
    expect(inHello.map((el) => [el.dataset.target, el.dataset.state])).toEqual([["slack", "offered"]]);
    expect(card("slack").textContent).toContain("Talk to Nova in Slack and let it post there.");
    // No generic tools card any more, and no browse link under Slack alone.
    expect(host.querySelector('[data-target="tools"]')).toBeNull();
    expect(browseLink()).toBeNull();
    // The request the app sent the bot stays out of sight.
    expect(threadText()).not.toContain("Automatic message from HQ");
    // The first message is remembered, so the cards outlive the new-bots list.
    const stored = JSON.parse(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "{}");
    expect(stored[NOVA]?.helloEventId).toBe("e2");
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
    // Nothing to look up: the app chose only apps that are connected.
    expect(w.catalogSearch).not.toHaveBeenCalled();
  });

  it("shows the person's own connected app as its own card, one press shares it and tells the bot once", async () => {
    const w = world({ connections: [connection()] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(appCard("linear.app")).not.toBeNull());
    const linear = appCard("linear.app")!;
    expect(linear.dataset.kind).toBe("integration");
    expect(linear.dataset.state).toBe("connected");
    expect(linear.textContent).toContain("Linear");
    expect(linear.textContent).toContain("Let Nova use it?");
    expect(appPrimary("linear.app")!.textContent?.trim()).toBe("Let Nova use it");
    // The logo box is drawn from the domain: Linear's bundled mark, no favicon request, no letters.
    expect(linear.querySelector('[data-testid="connection-card-logo-mark"] path')?.getAttribute("d")).toBe(brandMarkFor("linear.app")?.path);
    expect(linear.querySelector('[data-testid="connection-card-logo-img"]')).toBeNull();
    expect(linear.querySelector('[data-testid="connection-card-logo"]')?.textContent?.trim()).toBe("");
    // Nothing is said to the bot about a connection it cannot use yet.
    expect(hiddenNotices(w)).toHaveLength(0);

    let finishGrant: (value: unknown) => void = () => {};
    w.grantConnectionAccess.mockImplementationOnce(() => new Promise((resolve) => (finishGrant = resolve)));
    const allow = appPrimary("linear.app")!;
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
    // The card now says the bot can use it, and the button is gone.
    await vi.waitFor(() => expect(appCard("linear.app")!.textContent).toContain("Nova can use it."));
    expect(appPrimary("linear.app")).toBeNull();
    // Asking the server again does not tell the bot a second time.
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(1);
    expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1);
    // The notice never shows in the conversation.
    expect(threadText()).not.toContain("Automatic message from HQ");
  });

  it("a teammate's connection is never offered: only the person's own gets a card", async () => {
    const w = world();
    w.connections = [
      connection({ id: "acct_gmail_theirs", provider: "gmail", createdBy: "prs_teammate", installation: { displayName: "Gmail (Hassaan)", domain: "gmail.com" } }),
      connection({ id: "acct_anon", provider: "factory:notion", createdBy: undefined, installation: { displayName: "Notion (unknown)", domain: "notion.so" } }),
      connection(),
    ];
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(appCard("linear.app")).not.toBeNull());
    expect(cards().map((el) => el.dataset.domain ?? el.dataset.target)).toEqual(["slack", "linear.app"]);
    expect(threadText()).not.toContain("Hassaan");
    expect(threadText()).not.toContain("Notion");
  });

  it("says in one sentence why a share failed, and tells the bot nothing", async () => {
    const w = world({ connections: [connection()] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());

    w.grantConnectionAccess.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "http-403",
      message: "Only the connection owner or a company admin can manage access",
    });
    appPrimary("linear.app")!.click();
    await vi.waitFor(() =>
      expect(appNote("linear.app")).toBe("Only the person who connected Linear or a company admin can share it."),
    );
    expect(hiddenNotices(w)).toHaveLength(0);
    // The button stays, so the person can try again.
    expect(appPrimary("linear.app")).not.toBeNull();
    expect(threadText()).toContain("Hi Corey, I am Nova.");

    w.grantConnectionAccess.mockRejectedValueOnce(new Error("offline"));
    await vi.waitFor(() => expect(appPrimary("linear.app")!.disabled).toBe(false), { timeout: 3000 });
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(appNote("linear.app")).toBe("Could not share Linear. Try again."));
    expect(hiddenNotices(w)).toHaveLength(0);
    expect(appPrimary("linear.app")).not.toBeNull();
  });

  it("offers no card for an app that is already open to everyone, and tells the bot nothing", async () => {
    const w = world({ connections: [connection({ access: { mode: "everyone", grantCount: 0 } })] });
    await mountNewBotDm(w);
    await settle(20);
    expect(cards().map((el) => el.dataset.target)).toEqual(["slack"]);
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(0);
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
  });

  it("offers a browse-all link under a row with an app card, by the company's slug and never its uid", async () => {
    const w = world({ connections: [connection()] });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(browseLink()).not.toBeNull());
    expect(browseLink()!.textContent?.trim()).toBe("Browse all in HQ Integrations");
    browseLink()!.click();
    await settle();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(w.openUrl).toHaveBeenCalledWith("https://hq.computer/companies/acme/integrations");
    await unmountShell();

    const unknownCompany = world({ connections: [connection()], companies: [] });
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    await mountRow(unknownCompany, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(browseLink()).not.toBeNull());
    browseLink()!.click();
    await settle();
    expect(unknownCompany.openUrl).toHaveBeenCalledWith("https://hq.computer");
    expect(unknownCompany.openUrl.mock.calls.flat().join(" ")).not.toContain("cmp_");
  });

  it("shows Slack as connected when the bot can receive messages there", async () => {
    const w = world({ slackCapability: "ok", connections: [connection()] });
    await mountNewBotDm(w);
    // With the bot in Slack, the Slack card is not offered: the person's app is.
    await vi.waitFor(() => expect(appCard("linear.app")).not.toBeNull());
    expect(host.querySelector('[data-target="slack"]')).toBeNull();
    expect(hiddenNotices(w)).toHaveLength(0);
    await unmountShell();

    const slackOnly = world({ slackCapability: "ok" });
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    await mountRow(slackOnly, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(slackOnly.listConnections).toHaveBeenCalled());
    await settle(20);
    // Nothing to offer: no cards at all, and no empty row.
    expect(cards()).toHaveLength(0);
    expect(host.querySelector('[data-testid="rich-connect"]')).toBeNull();
  });

  // Connecting Slack happens in the card's modal, never on a page in the
  // browser. The flow itself is in DesktopApp.cloud-bot-slack-connect.test.ts.
  it("says to ask a company admin, with no Connect button, when the person may not read the bot's status", async () => {
    // I16: the server answers a member 403 (or 404) for the bot's status.
    for (const code of ["http-403", "http-404"]) {
      window.localStorage.clear();
      const w = world({
        getStatus: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code, message: "no" })),
      });
      window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
      await mountRow(w, { ...DM_ROW(NOVA), companyUid: COMPANY } as ConversationRow, "Hi Corey, I am Nova.");
      await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(card("slack").textContent).toContain(SLACK_ADMIN_LINE("Nova")));
      expect(SLACK_ADMIN_LINE("Nova")).toBe("Ask a company admin to connect Nova to Slack.");
      expect(primary("slack")).toBeNull();
      expect(decline("slack")).toBeNull();
      // A refusal is not a failed check: the card does not also say it could not check.
      expect(note("slack")).toBe("");
      expect(card("slack").textContent).not.toContain("Could not check Slack");
      await unmountShell();
    }
  });

  it("still offers Connect Slack, with the could-not-check note, when the status read fails for another reason", async () => {
    const w = world({
      getStatus: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-500", message: "boom" })),
    });
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    await mountRow(w, { ...DM_ROW(NOVA), companyUid: COMPANY } as ConversationRow, "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(note("slack")).toBe("Could not check Slack right now. You can still connect it."));
    expect(card("slack").textContent).not.toContain(SLACK_ADMIN_LINE("Nova"));
    expect(primary("slack")).not.toBeNull();
  });

  it("opens no page from Connect Slack: the card opens its modal, and opening it starts nothing", async () => {
    const w = world();
    await mountNewBotDm(w);
    expect(primary("slack")!.textContent?.trim()).toBe("Connect Slack");
    expect(primary("slack")!.getAttribute("aria-haspopup")).toBe("dialog");
    primary("slack")!.click();
    await settle();
    expect(w.openUrl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="card-modal"]')).not.toBeNull());
    expect(card("slack").dataset.state).toBe("offered");
    expect(hiddenNotices(w)).toHaveLength(0);
  });

  it("shows a Slack setup the server has as not finished, and tells the bot nothing when it was not started here", async () => {
    const w = world({ slackCapability: "socket-mode-degraded" });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    expect(card("slack").textContent).toContain("Setup is not finished. Connecting.");
    expect(primary("slack")!.textContent?.trim()).toBe("Continue");
    expect(decline("slack")!.textContent?.trim()).toBe("Not now");
    expect(note("slack")).toBe("");

    // The card keeps asking while the setup is not finished, and sees it end.
    w.slackCapability = "ok";
    await refocus();
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    // Nobody pressed anything here: the notice says "{person} just connected you".
    expect(hiddenNotices(w)).toHaveLength(0);
    expect(w.openUrl).not.toHaveBeenCalled();
  });

  it("keeps Not now across a remount", async () => {
    const w = world();
    await mountNewBotDm(w);
    decline("slack")!.click();
    await settle();
    expect(card("slack").dataset.state).toBe("declined");
    expect(card("slack").querySelectorAll("button")).toHaveLength(0);

    await unmountShell();
    const again = world();
    await mountRow(again, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(card("slack").dataset.state).toBe("declined");
    expect(card("slack").textContent).toContain("Not connected. Ask Nova about Slack any time.");
    expect(card("slack").querySelectorAll("button")).toHaveLength(0);
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
    await settle(20);
    // The Slack card stays usable; no app card can be offered without the list.
    expect(cards().map((el) => el.dataset.target)).toEqual(["slack"]);
    primary("slack")!.click();
    await settle();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="card-modal"]')).not.toBeNull());
  });

  it("puts no cards under the messages of a bot that was not made here", async () => {
    const w = world();
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await settle(20);
    expect(cards()).toHaveLength(0);
    expect(w.listConnections).not.toHaveBeenCalled();
  });
});

/**
 * B-8: a page the server filtered for people leaves the app's hello request
 * out, so the bot's first message could not be found on it. A person who
 * typed before the hello arrived never got the cards under it. The time the
 * request was sent is kept on this device and names the message instead.
 */
describe("DesktopApp connection cards: the hello found by when it was asked for (B-8)", () => {
  const ASKED = Date.parse("2026-10-02T13:53:50.000Z");
  const TYPED: Row = { eventId: "e1b", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Are you there?", createdAt: "2026-10-02T13:54:05.000Z" };
  const HELLO: Row = { eventId: "e2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: "2026-10-02T13:54:20.000Z" };
  const storedHello = (): string | undefined =>
    JSON.parse(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "{}")[NOVA]?.helloEventId;
  const cardsUnder = (eventId: string): HTMLElement[] => [
    ...(host
      .querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)
      ?.querySelectorAll<HTMLElement>('[data-testid="connection-card"]') ?? []),
  ];
  function seedAsked(atMs: number | null): void {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    if (atMs !== null) seedAskedBy("prs_me", atMs);
  }
  /** What the app keeps per account: when that account asked the bot for its first message. */
  function seedAskedBy(account: string, atMs: number): void {
    window.localStorage.setItem(
      BOT_HELLO_ASKED_STORAGE_KEY,
      JSON.stringify({ v: 2, accounts: { [account]: { asked: { [NOVA]: atMs }, made: [] } } }),
    );
  }
  const storedAsked = (account: string): Record<string, number> =>
    JSON.parse(window.localStorage.getItem(BOT_HELLO_ASKED_STORAGE_KEY) ?? "{}").accounts?.[account]?.asked ?? {};

  it("puts the cards under the bot's first message on a page with no request row", async () => {
    seedAsked(ASKED);
    // Newest first, as a page filtered for people: the request is not on it.
    const w = world({ thread: [HELLO, TYPED] });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(storedHello()).toBe("e2"));
    await vi.waitFor(() => expect(cardsUnder("e2").map((el) => el.dataset.target)).toEqual(["slack"]));
    // Once the message is known, the time is no longer kept.
    await vi.waitFor(() => expect(storedAsked("prs_me")).toEqual({}));
  });

  it("finds it when the hello arrives after the person typed", async () => {
    seedAsked(ASKED);
    const w = world({ thread: [TYPED] });
    const wakes = createChatWakeBus();
    await mountRow(w, DM_ROW(NOVA), "Are you there?", wakes);
    await settle(20);
    expect(storedHello()).toBeUndefined();
    expect(cards()).toHaveLength(0);

    w.thread = [HELLO, TYPED];
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "e2", createdAt: String(HELLO.createdAt), direction: "in" });
    await vi.waitFor(() => expect(threadText()).toContain("Hi Corey, I am Nova."));
    await vi.waitFor(() => expect(storedHello()).toBe("e2"));
    await vi.waitFor(() => expect(cardsUnder("e2").map((el) => el.dataset.target)).toEqual(["slack"]));
  });

  it("names no message without the time: the page alone cannot say which row is the hello", async () => {
    seedAsked(null);
    const w = world({ thread: [HELLO, TYPED] });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await settle(40);
    expect(storedHello()).toBeUndefined();
    expect(cards()).toHaveLength(0);
  });

  it("names no message on a full page of a long conversation: its first bot row is not the hello", async () => {
    seedAsked(ASKED);
    // Fifty rows, newest first, none of them the request: the conversation goes back further.
    const page: Row[] = Array.from({ length: 50 }, (_, i) => ({
      eventId: `m${i}`,
      fromPersonUid: i % 2 === 0 ? NOVA : "prs_me",
      fromDisplayName: i % 2 === 0 ? "Nova" : "Corey",
      body: i === 0 ? "Newest from Nova." : `Row ${i}`,
      createdAt: new Date(Date.parse("2026-10-03T10:00:00.000Z") - i * 60_000).toISOString(),
    }));
    const w = world({ thread: page });
    await mountRow(w, DM_ROW(NOVA), "Newest from Nova.");
    await settle(40);
    expect(storedHello()).toBeUndefined();
    expect(cards()).toHaveLength(0);
    expect(storedAsked("prs_me")).toEqual({ [NOVA]: ASKED });
  });

  it("does not use a time another account on this Mac kept, or one in the old shape with no account", async () => {
    for (const seed of [
      () => seedAskedBy("prs_someone_else", ASKED),
      () => window.localStorage.setItem(BOT_HELLO_ASKED_STORAGE_KEY, JSON.stringify({ [NOVA]: ASKED })),
    ]) {
      window.localStorage.clear();
      window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
      seed();
      const w = world({ thread: [HELLO, TYPED] });
      await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
      await settle(40);
      expect(storedHello()).toBeUndefined();
      expect(cards()).toHaveLength(0);
      await unmountShell();
    }
  });
});

/**
 * B-12: a notice to the bot that failed to send was sent again every time
 * the cards were worked out (every 5 s while a card waits, and on every
 * focus), including one the server refuses for good.
 */
describe("DesktopApp: a notice to the bot that fails to send (B-12)", () => {
  /** A Slack card that is waiting keeps the cards rechecking on every focus. */
  function seedWaitingSlackCard(): void {
    window.localStorage.setItem(
      BOT_CONNECTION_CARDS_STORAGE_KEY,
      JSON.stringify({ [NOVA]: { helloEventId: "e2", slack: { state: "connecting", since: Date.now() } } }),
    );
  }
  /** Hidden sends answer with `hiddenAnswer()`; the person's own messages go through. */
  function worldWithHiddenSends(hiddenAnswer: () => unknown): World {
    const w = world({ connections: [connection()] });
    w.sendDm = vi.fn(async (_to: string, _body: string, extras?: { audience?: string }) =>
      extras?.audience === "agent" ? hiddenAnswer() : ok({ eventId: "sent_1" }),
    );
    return w;
  }
  async function allowLinear(w: World): Promise<void> {
    seedWaitingSlackCard();
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    await settle(20);
  }
  const announced = (): string[] =>
    JSON.parse(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "{}")[NOVA]?.announced ?? [];

  it("is not sent again after the server refuses it", async () => {
    const w = worldWithHiddenSends(() => ({ ok: false, reason: "error", code: "http-403", message: "no" }));
    await allowLinear(w);
    const lists = w.listConnections.mock.calls.length;
    for (let i = 0; i < 6; i += 1) await refocus();
    // The cards did recheck on every focus; the refused notice did not go again.
    expect(w.listConnections.mock.calls.length).toBeGreaterThan(lists);
    expect(hiddenNotices(w)).toHaveLength(1);
    expect(announced()).toEqual([]);
  });

  it("is retried further apart each time, then goes through and is not sent again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let serverUp = false;
      const w = worldWithHiddenSends(() =>
        serverUp ? ok({ eventId: "sent_hidden" }) : { ok: false, reason: "error", code: "http-503", message: "busy" },
      );
      await allowLinear(w);
      // Rechecks right away do not send it again.
      for (let i = 0; i < 4; i += 1) await refocus();
      expect(hiddenNotices(w)).toHaveLength(1);

      // 30 s later the next recheck sends it once.
      vi.setSystemTime(Date.now() + 31_000);
      for (let i = 0; i < 3; i += 1) await refocus();
      expect(hiddenNotices(w)).toHaveLength(2);

      // The wait doubled: 31 s is not enough now, 61 s is.
      vi.setSystemTime(Date.now() + 31_000);
      await refocus();
      expect(hiddenNotices(w)).toHaveLength(2);
      serverUp = true;
      vi.setSystemTime(Date.now() + 30_000);
      await refocus();
      await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(3));
      await vi.waitFor(() => expect(announced()).toEqual(["acct_linear"]));

      // Told once: later rechecks send nothing.
      vi.setSystemTime(Date.now() + 300_000);
      for (let i = 0; i < 3; i += 1) await refocus();
      expect(hiddenNotices(w)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after four failed sends in a session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const w = worldWithHiddenSends(() => ({ ok: false, reason: "error", code: "http-500", message: "boom" }));
      await allowLinear(w);
      for (const wait of [31_000, 61_000, 121_000]) {
        vi.setSystemTime(Date.now() + wait);
        await refocus();
        await refocus();
      }
      expect(hiddenNotices(w)).toHaveLength(4);
      vi.setSystemTime(Date.now() + 250_000);
      for (let i = 0; i < 4; i += 1) await refocus();
      expect(hiddenNotices(w)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DesktopApp connection cards: whose messages draw them (I13)", () => {
  it("draws no cards under the person's own message that carries a connect block", async () => {
    // The person pasted the bot's block back (an example, a quote). It is
    // their text: no live Connect buttons under their own name.
    const pasted = `Like this?${fence([{ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }])}`;
    const w = world({
      connections: [connection()],
      thread: [
        { eventId: "e3", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: pasted, createdAt: "2026-10-02T13:55:00.000Z" },
        ...thread(NOVA),
      ],
    });
    await mountNewBotDm(w);
    const mine = host.querySelector<HTMLElement>('[data-testid="conversation-message"][data-event-id="e3"]')!;
    expect(mine).not.toBeNull();
    expect(mine.querySelectorAll('[data-testid="connection-card"]')).toHaveLength(0);
    // The bot's own hello still has its cards.
    const hello = host.querySelector<HTMLElement>('[data-testid="conversation-message"][data-event-id="e2"]')!;
    expect(hello.querySelectorAll('[data-testid="connection-card"]').length).toBeGreaterThan(0);
  });

  it("the shell names the bot whose messages may draw cards", () => {
    // The conversation falls back to the suggestions bot when the host names
    // none. The shell names the open cloud bot itself, so the rule does not
    // depend on that fallback.
    const source = readFileSync(join(import.meta.dirname, "DesktopApp.svelte"), "utf8");
    const start = source.indexOf("const cloudBotConnections = $derived.by(");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("cardsFor: (message) =>", start));
    expect(block).toContain("botUid: input.uid,");
  });
});

describe("DesktopApp suggested replies from a cloud bot", () => {
  const SUGGESTIONS = fence([{ kind: "suggestions", items: ["Summarize our company files", "List our open projects"] }]);
  /** The hello (with the app's cards under it), the person's question, and the bot's answer with its suggestions. */
  const answered = (): Row[] => [
    { eventId: "e4", fromPersonUid: NOVA, fromDisplayName: "Nova", body: `Quite a lot already.${SUGGESTIONS}`, createdAt: "2026-10-02T14:01:30.000Z" },
    { eventId: "e3", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "What do you know about us?", createdAt: "2026-10-02T14:01:00.000Z" },
    ...thread(NOVA),
  ];
  const messageEl = (eventId: string): HTMLElement =>
    host.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)!;

  it("shows the newest message's suggestions as buttons inside that message, and a click sends the text", async () => {
    // The bot is in Slack and the person has no apps: no cards, so nothing to decide first.
    const w = world({ thread: thread(NOVA, SUGGESTIONS), slackCapability: "ok" });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() =>
      expect(chips().map((chip) => chip.textContent?.trim())).toEqual(["Summarize our company files", "List our open projects"]),
    );
    expect(threadText()).not.toContain("hq-block");
    // Part of the message, in the thread. Only the bot's own: the app adds none.
    expect(messageEl("e2").querySelectorAll('[data-testid="suggested-reply"]')).toHaveLength(2);
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

  it("shows no suggestions on the message that carries the cards: the cards are the decision", async () => {
    const w = world({ thread: thread(NOVA, SUGGESTIONS) });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack")).not.toBeNull());
    await settle(20);
    expect(chips()).toHaveLength(0);
    expect(threadText()).not.toContain("hq-block");
  });

  it("keeps the suggestions while the app tells the bot about a connection", async () => {
    const w = world({ thread: answered(), connections: [connection()] });
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    await mountRow(w, DM_ROW(NOVA), "Quite a lot already.");
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    await vi.waitFor(() => expect(messageEl("e4").querySelectorAll('[data-testid="suggested-reply"]')).toHaveLength(2));
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    await settle();
    // The notice is not the person writing: the buttons stay under the bot's newest message.
    expect(chips().map((chip) => chip.textContent?.trim())).toEqual(["Summarize our company files", "List our open projects"]);
    expect(messageEl("e4").querySelectorAll('[data-testid="suggested-reply"]')).toHaveLength(2);
  });
});

describe("DesktopApp outside a cloud bot's direct message", () => {
  const LOADED =
    "I need Slack for that." +
    fence([
      { kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] },
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
    expect(w.catalogSearch).not.toHaveBeenCalled();
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
    expect(w.catalogSearch).not.toHaveBeenCalled();
  });
});
