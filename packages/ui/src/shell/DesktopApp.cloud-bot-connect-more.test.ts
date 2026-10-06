// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { BOT_CONNECTION_CARDS_STORAGE_KEY, CONNECT_MORE_REQUEST } from "../chat/messaging/connection-card-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * "Connect more tools" in a cloud bot's direct message. The app adds no
 * suggested reply of its own: the chips under a bot message are only the
 * bot's own suggestions, shown when it has something to suggest (owner, live
 * walkthrough 2026-10-03: a "Connect more tools" chip under every message was
 * noise). The person can still ask, by typing it or by pressing the bot's own
 * suggestion with those words: the message goes as the person's own, and
 * that one message is all the bot gets (B-9: a second, hidden request beside
 * it was answered as well, so the bot wrote twice). The app draws the
 * connection cards again under the bot's answer.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
/** The bot's company as the app knows it. A link to the web is built from its slug, never its uid. */
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
const INTEGRATIONS_URL = `https://hq.computer/companies/${ACME.slug}/integrations`;
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

const fence = (blocks: unknown[]): string => `\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks })}\n\`\`\``;
const SUGGESTIONS = fence([{ kind: "suggestions", items: ["Summarize our company files", "List our open projects"] }]);

type Row = Record<string, unknown>;

/** A connection of the person's own the bot cannot use yet: the app offers it as a card. */
const LINEAR: Row = {
  id: "acct_linear",
  provider: "factory:linear",
  status: "connected",
  createdBy: "prs_me",
  createdAt: "2026-10-02T14:10:00.000Z",
  access: { mode: "private", grantCount: 0 },
  installation: { displayName: "Linear", domain: "linear.app" },
};

const HELLO_REQUEST: Row = {
  eventId: "e1",
  fromPersonUid: "prs_me",
  fromDisplayName: "Corey",
  body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }),
  createdAt: "2026-10-02T13:53:50.000Z",
  audience: "agent",
  replyCount: 1,
};
const HELLO: Row = {
  eventId: "e2",
  fromPersonUid: NOVA,
  fromDisplayName: "Nova",
  body: "Hi Corey, I am Nova.",
  createdAt: "2026-10-02T13:54:20.000Z",
  rootEventId: "e1",
};
const mine = (eventId: string, body: string, minute: number): Row => ({
  eventId,
  fromPersonUid: "prs_me",
  fromDisplayName: "Corey",
  body,
  createdAt: `2026-10-02T14:${String(minute).padStart(2, "0")}:00.000Z`,
});
const novas = (eventId: string, body: string, minute: number, from = NOVA): Row => ({
  eventId,
  fromPersonUid: from,
  fromDisplayName: "Nova",
  body,
  createdAt: `2026-10-02T14:${String(minute).padStart(2, "0")}:30.000Z`,
});

/** A page of the direct message, newest first as the server returns it. */
const page = (...oldestFirst: Row[]): Row[] => [...oldestFirst].reverse();

/** The bot said hello, the person asked something, the bot answered. */
const answered = (answerExtra = ""): Row[] =>
  page(HELLO_REQUEST, HELLO, mine("e3", "What do you know about us?", 1), novas("e4", `Quite a lot already.${answerExtra}`, 1));
/** After that the person asked for the cards and the bot answered again. */
const askedAgain = (answerBody = "Here are your connections."): Row[] =>
  page(
    HELLO_REQUEST,
    HELLO,
    mine("e3", "What do you know about us?", 1),
    novas("e4", "Quite a lot already.", 1),
    mine("e5", CONNECT_MORE_REQUEST, 5),
    novas("e6", answerBody, 5),
  );

interface World {
  thread: Row[];
  channel: Row[];
  slackCapability: string | null;
  connections: Row[];
  bots: LocalBotRow[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  catalogSearch: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
  openUrl: Mock<(url: string) => void>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    thread: answered(),
    channel: [],
    slackCapability: null,
    connections: [],
    bots: [],
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
      ok({
        companyUid: COMPANY,
        viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
        factoryEnabled: true,
        connections: w.connections,
        audit: [],
      }),
    ),
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
    integrations: { listConnections: w.listConnections, grantConnectionAccess: vi.fn(async () => ok({})), catalogSearch: w.catalogSearch },
    ...(w.bots.length > 0 ? { bots: { list: async () => ok({ bots: w.bots }) } } : {}),
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
      companies: [ACME],
      onopenurl: w.openUrl,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(waitForText));
  await settle(20);
}

/** A bot made in the New bot flow on this device: the cards sit under its first message. */
async function mountNewBotDm(w: World, waitForText: string): Promise<void> {
  window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
  await mountRow(w, DM_ROW(NOVA), waitForText);
  await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalled());
  await settle(20);
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const message = (eventId: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)!;
const cardsIn = (el: ParentNode): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const cardIn = (el: ParentNode, target: "slack" | "tools" | "integration"): HTMLElement =>
  el.querySelector<HTMLElement>(`[data-testid="connection-card"][data-target="${target}"]`)!;
const chipButtons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')];
const chips = (): string[] => chipButtons().map((chip) => chip.textContent?.trim() ?? "");
const chip = (label: string): HTMLButtonElement => chipButtons().find((el) => el.textContent?.trim() === label)!;
const hidden = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");
const visibleSends = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience !== "agent");

/** The device's record of the bot's cards, as the app stores it. */
function rememberCards(record: Record<string, unknown>): void {
  window.localStorage.setItem(BOT_CONNECTION_CARDS_STORAGE_KEY, JSON.stringify({ [NOVA]: { helloEventId: "e2", ...record } }));
}

async function typeAndSend(text: string): Promise<void> {
  const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
  expect(composer, "live composer renders for the bot DM").toBeTruthy();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(20);
}

describe("DesktopApp Connect more in a cloud bot's direct message", () => {
  it("adds no chip while a card is still waiting for an answer", async () => {
    const w = world();
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(cardsIn(message("e2"))).toHaveLength(1));
    expect(cardIn(message("e2"), "slack").dataset.state).toBe("offered");
    await settle(20);
    expect(chips()).toEqual([]);
    expect(cardsIn(message("e4"))).toHaveLength(0);
  });

  it("adds no chip once nothing is left to decide: the bot suggested nothing, so nothing is drawn", async () => {
    // The bot is in Slack and the person has no apps of their own.
    // Updated 2026-10-05: Slack is the first card every time (owner), shown connected once the bot is in Slack; it used to be left out then.
    // The one card is Slack, connected: nothing is left to decide.
    const w = world({ slackCapability: "ok" });
    await mountNewBotDm(w, "Quite a lot already.");
    await settle(40);
    expect(cardsIn(host).map((el) => [el.dataset.target, el.dataset.state])).toEqual([["slack", "connected"]]);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(host.querySelector('[data-testid="suggested-reply-other"]')).toBeNull();
    expect(threadText()).not.toContain("Connect more tools");
  });

  it("adds no chip once every card is connected or declined", async () => {
    rememberCards({ slack: { state: "declined", since: Date.parse("2026-10-02T14:00:00.000Z") } });
    const w = world();
    await mountRow(w, DM_ROW(NOVA), "Quite a lot already.");
    await vi.waitFor(() => expect(cardIn(message("e2"), "slack").dataset.state).toBe("declined"));
    await settle(40);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("adds no chip after the person pressed a card", async () => {
    rememberCards({ granted: { acct_linear: { name: "Linear", at: Date.parse("2026-10-02T14:00:00.000Z") } } });
    const w = world({ connections: [LINEAR] });
    await mountRow(w, DM_ROW(NOVA), "Quite a lot already.");
    await vi.waitFor(() => expect(cardsIn(message("e2"))).toHaveLength(1));
    await settle(40);
    expect(chips()).toEqual([]);
  });

  it("draws only the bot's own suggestions, with Something else since there are two", async () => {
    const w = world({ slackCapability: "ok", thread: answered(SUGGESTIONS) });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(chips()).toEqual(["Summarize our company files", "List our open projects"]));
    await settle(20);
    expect(chips()).not.toContain("Connect more tools");
    expect(message("e4").querySelectorAll('[data-testid="suggested-reply"]')).toHaveLength(2);
    expect(message("e4").querySelector('[data-testid="suggested-reply-other"]')?.textContent?.trim()).toBe("Something else");
    expect(threadText()).not.toContain("hq-block");
  });

  it("is not offered while the newest bot message carries the cards the app put there", async () => {
    const w = world({ thread: page(HELLO_REQUEST, HELLO) });
    await mountNewBotDm(w, "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(cardsIn(message("e2"))).toHaveLength(1));
    await settle(20);
    expect(chips()).toEqual([]);
  });

  it("draws no suggestions at all on a message that carries the bot's own connect block: the cards are the decision", async () => {
    const w = world({
      slackCapability: "ok",
      thread: answered(fence([{ kind: "connect", targets: ["slack"] }, { kind: "suggestions", items: ["List our open projects"] }])),
    });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(cardsIn(message("e4"))).toHaveLength(1));
    await settle(20);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("goes away once the person has written", async () => {
    const w = world({ thread: page(HELLO_REQUEST, HELLO, mine("e3", "What do you know about us?", 1)) });
    await mountNewBotDm(w, "What do you know about us?");
    expect(chips()).toEqual([]);
  });

  it("the bot's own 'Connect more tools' suggestion sends exactly one message, the person's own, and no hidden request", async () => {
    // The bot is in Slack; the person's Linear is the other card, already connected.
    // Updated 2026-10-05: Slack is the first card every time (owner), shown connected once the bot is in Slack; it used to be left out then.
    const own = fence([{ kind: "suggestions", items: ["Connect more tools", "List our open projects"] }]);
    const w = world({ slackCapability: "ok", connections: [LINEAR], thread: answered(own) });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(cardsIn(message("e2"))).toHaveLength(2));
    await vi.waitFor(() => expect(chips()).toEqual(["Connect more tools", "List our open projects"]));
    const button = chip("Connect more tools");
    button.click();
    button.click();
    await vi.waitFor(() => expect(w.sendDm).toHaveBeenCalled());
    await settle(40);
    // One message the bot acts on: what the person said, on the ordinary lane.
    expect(w.sendDm).toHaveBeenCalledTimes(1);
    expect(visibleSends(w)).toHaveLength(1);
    const [to, body, extras] = visibleSends(w)[0]!;
    expect(to).toBe(NOVA);
    expect(body).toBe("Connect more tools");
    expect((extras as { audience?: string } | undefined)?.audience).toBeUndefined();
    expect(hidden(w)).toHaveLength(0);
    // The words stay in the conversation as the person's own message.
    expect(threadText()).toContain("Connect more tools");
    expect(threadText()).not.toContain("Automatic message from HQ");
    // The row is put away, and nothing extra is drawn until the bot answers
    // (the hello's two cards, Slack and Linear, are all there is).
    expect(chips()).toEqual([]);
    expect(cardsIn(host)).toHaveLength(2);
  });

  it("a typed 'Connect more tools' is one message too, and the bot shows as working on it", async () => {
    const w = world({ slackCapability: "ok", connections: [LINEAR], thread: answered() });
    await mountNewBotDm(w, "Quite a lot already.");
    await typeAndSend("connect more tools.");
    await settle(40);
    expect(w.sendDm).toHaveBeenCalledTimes(1);
    expect(w.sendDm.mock.calls[0]![1]).toBe("connect more tools.");
    expect(hidden(w)).toHaveLength(0);
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).not.toBeNull();
  });

  it("draws the app-chosen cards under a bot answer that carries no block: Slack, then the person's own apps", async () => {
    const w = world({ thread: askedAgain(), connections: [LINEAR] });
    await mountNewBotDm(w, "Here are your connections.");
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(2));
    expect(cardsIn(message("e6")).map((el) => [el.dataset.target, el.dataset.domain ?? null, el.dataset.state])).toEqual([
      ["slack", null, "offered"],
      ["integration", "linear.app", "connected"],
    ]);
    expect(cardIn(message("e6"), "integration").textContent).toContain("Let Nova use it?");
    // No catalog lookup for an app that is connected.
    expect(w.catalogSearch).not.toHaveBeenCalled();
    expect(cardsIn(message("e2"))).toHaveLength(2);
    expect(cardsIn(message("e4"))).toHaveLength(0);
    // The person's own request is an ordinary message in the conversation.
    expect(message("e5").textContent).toContain("Connect more tools");
    // The app adds no chip of its own.
    expect(chips()).toEqual([]);
    // Nothing about which message carries them is stored.
    expect(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "").not.toContain("e6");
  });

  it("adds no chip under a later bot message, once the cards it brought are answered", async () => {
    // The person said Not now after the second set of cards was drawn.
    rememberCards({ slack: { state: "declined", since: Date.parse("2026-10-02T14:06:00.000Z") } });
    const w = world({
      thread: page(
        HELLO_REQUEST,
        HELLO,
        mine("e5", "connect more tools.", 5),
        novas("e6", "Here are your connections.", 5),
        mine("e7", "Thanks. What next?", 7),
        novas("e8", "Tell me what to look at.", 7),
      ),
    });
    await mountRow(w, DM_ROW(NOVA), "Tell me what to look at.");
    // A request typed by hand, in lower case with a full stop, counts too.
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(1));
    expect(cardsIn(message("e8"))).toHaveLength(0);
    await vi.waitFor(() => expect(cardIn(message("e6"), "slack").dataset.state).toBe("declined"));
    await settle(40);
    expect(chips()).toEqual([]);
    expect(message("e8").querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("gives no second set to an answer that already has a connect block", async () => {
    const w = world({ thread: askedAgain(`Here you go.${fence([{ kind: "connect", targets: ["tools"] }])}`) });
    await mountNewBotDm(w, "Here you go.");
    // Updated 2026-10-05: Slack is the first card every time (owner), shown connected once the bot is in Slack; it used to be left out then.
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(2));
    await settle(20);
    expect(cardsIn(message("e6")).map((el) => el.dataset.target)).toEqual(["slack", "tools"]);
    expect(message("e6").querySelectorAll('[data-testid="rich-connect"]')).toHaveLength(1);
  });

  it("shows the newer cards as offered again after a Not now on the first ones", async () => {
    const declinedAt = Date.parse("2026-10-02T14:02:00.000Z");
    window.localStorage.setItem(
      BOT_CONNECTION_CARDS_STORAGE_KEY,
      JSON.stringify({
        [NOVA]: {
          helloEventId: "e2",
          slack: { state: "declined", since: declinedAt },
          tools: { state: "declined", since: declinedAt },
        },
      }),
    );
    const w = world({ thread: askedAgain() });
    await mountRow(w, DM_ROW(NOVA), "Here are your connections.");
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(1));
    expect(cardsIn(message("e2")).map((el) => el.dataset.state)).toEqual(["declined"]);
    expect(cardsIn(message("e6")).map((el) => el.dataset.state)).toEqual(["offered"]);
    expect(
      cardIn(message("e6"), "slack").querySelector('[data-testid="connection-card-primary"]')?.textContent?.trim(),
    ).toBe("Connect Slack");
  });

  it("works for a cloud bot this device has no record of", async () => {
    const w = world({ thread: page(mine("e5", CONNECT_MORE_REQUEST, 5), novas("e6", "Here are your connections.", 5)) });
    await mountRow(w, DM_ROW(NOVA), "Here are your connections.");
    expect(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY)).toBeNull();
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(1));
    // The cards are live: what is connected was asked, and a press works.
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledWith(COMPANY));
    await settle(20);
    cardIn(message("e6"), "slack").querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]')!.click();
    await settle(20);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="card-modal"]')).not.toBeNull());
    expect(w.openUrl).not.toHaveBeenCalledWith(INTEGRATIONS_URL);
  });

  it("adds no chip and no card for a cloud bot this device has no record of, and reads its connections once so a later card is ready", async () => {
    // Rewritten 2026-10-04: this used to assert that no connections are read
    // while no card shows. They are now read when a cloud bot's conversation
    // opens, so a message that brings cards draws them in its own frame
    // instead of seconds later. Nothing is drawn from the read by itself.
    const w = world({ thread: page(mine("e3", "Hello", 1), novas("e4", "Hello Corey.", 1)) });
    await mountRow(w, DM_ROW(NOVA), "Hello Corey.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalled());
    await settle(40);
    expect(cardsIn(host)).toHaveLength(0);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
    // The status poll's answer is the one the cards use: one status read, not two.
    expect(w.getStatus).toHaveBeenCalledTimes(1);
    // Nothing is looked up in the catalog until a message names an app.
    expect(w.catalogSearch).not.toHaveBeenCalled();
  });
});

describe("DesktopApp Connect more outside a cloud bot's direct message", () => {
  const asked = (peer: string): Row[] =>
    page(novas("b1", "Hello Corey.", 1, peer), mine("p1", CONNECT_MORE_REQUEST, 5), novas("b2", "Here are your connections.", 5, peer));

  function expectNothing(w: World): void {
    expect(cardsIn(host)).toHaveLength(0);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(w.listConnections).not.toHaveBeenCalled();
  }

  it("does nothing in a conversation with a person", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({ thread: asked("prs_nova") });
    await mountRow(w, DM_ROW("prs_nova"), "Here are your connections.");
    expectNothing(w);
  });

  it("does nothing in a conversation with a local bot", async () => {
    const scout: LocalBotRow = {
      name: "scout",
      agentUid: NOVA,
      ownerUid: "prs_me",
      runtime: "claude",
      state: "running",
      pid: 1,
      processAlive: true,
      online: true,
      lastHeartbeatAt: null,
      daemonInstalled: true,
      daemonLoaded: true,
      dir: "/tmp/scout",
    };
    const w = world({ thread: asked(NOVA), bots: [scout] });
    await mountRow(w, DM_ROW(NOVA), "Here are your connections.");
    await settle(40);
    expectNothing(w);
  });

  it("does nothing for a bot that was not made here and whose status this person cannot read (B-9)", async () => {
    // A teammate's local bot, or a bot from outside the company: an agt_ uid
    // that is not on this Mac. The status route does not know it (404), or
    // will not show it to this person (403).
    const ownBlocks = fence([
      { kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] },
      { kind: "suggestions", items: ["Connect more tools", "List our open projects"] },
    ]);
    for (const code of ["http-404", "http-403"]) {
      window.localStorage.clear();
      const w = world({
        connections: [LINEAR],
        thread: page(novas("b1", "Hello Corey.", 1), mine("p1", CONNECT_MORE_REQUEST, 5), novas("b2", `Here are your connections.${ownBlocks}`, 5)),
        getStatus: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code, message: "no" })),
      });
      await mountRow(w, { ...DM_ROW(NOVA), companyUid: COMPANY } as ConversationRow, "Here are your connections.");
      await vi.waitFor(() => expect(w.getStatus).toHaveBeenCalled());
      await settle(40);
      // No cards (the app's or the bot's own block), no chips, and the
      // company's connections are never read for it.
      expectNothing(w);
      // The status is asked once, not on a timer.
      expect(w.getStatus).toHaveBeenCalledTimes(1);

      // What the person types goes as their own message and nothing else.
      await typeAndSend(CONNECT_MORE_REQUEST);
      await settle(40);
      expect(w.sendDm).toHaveBeenCalledTimes(1);
      expect(hidden(w)).toHaveLength(0);
      expect(w.listConnections).not.toHaveBeenCalled();
      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });

  it("treats a bot whose status the server lets this person read as a cloud bot, with no record on this device", async () => {
    const w = world({ thread: asked(NOVA) });
    await mountRow(w, DM_ROW(NOVA), "Here are your connections.");
    await vi.waitFor(() => expect(cardsIn(message("b2")).length).toBeGreaterThan(0));
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
  });

  it("does nothing in a channel", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({ channel: asked(NOVA) });
    const row = { id: "ch:chn_team", kind: "channel", title: "team", channelId: "chn_team", channelScope: "channel", companyUid: COMPANY } as ConversationRow;
    await mountRow(w, row, "Here are your connections.");
    expectNothing(w);
  });
});
