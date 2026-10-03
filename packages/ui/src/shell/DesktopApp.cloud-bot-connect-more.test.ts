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
 * "Connect more": the app adds one button to the suggested replies under a
 * cloud bot's newest message. Pressing it sends "Connect more tools" as the
 * person's own message, and the app draws the two connection cards again
 * under the bot's answer, so nobody scrolls up to the first message.
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

describe("DesktopApp Connect more in a cloud bot's direct message", () => {
  it("offers the button after a bot answer that has no suggestions of its own", async () => {
    const w = world();
    await mountNewBotDm(w, "Quite a lot already.");
    // Nothing is connected yet.
    await vi.waitFor(() => expect(chips()).toEqual(["Connect Slack or tools"]));
    // The cards themselves stay where they were, under the first message.
    expect(cardsIn(message("e2"))).toHaveLength(1);
    expect(cardsIn(message("e4"))).toHaveLength(0);
  });

  it("says Connect more once Slack or a tool is connected", async () => {
    const w = world({ slackCapability: "ok" });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(chips()).toEqual(["Connect more"]));
  });

  it("comes last, after the bot's own suggestions", async () => {
    const w = world({ thread: answered(SUGGESTIONS) });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() =>
      expect(chips()).toEqual(["Summarize our company files", "List our open projects", "Connect Slack or tools"]),
    );
    expect(threadText()).not.toContain("hq-block");
  });

  it("is not offered while the newest bot message carries the cards the app put there", async () => {
    const w = world({ thread: page(HELLO_REQUEST, HELLO) });
    await mountNewBotDm(w, "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(cardsIn(message("e2"))).toHaveLength(1));
    await settle(20);
    expect(chips()).toEqual([]);
  });

  it("is not offered while the newest bot message carries the bot's own connect block", async () => {
    const w = world({
      thread: answered(fence([{ kind: "connect", targets: ["slack"] }, { kind: "suggestions", items: ["List our open projects"] }])),
    });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(cardsIn(message("e4"))).toHaveLength(1));
    await settle(20);
    // The bot's own suggestion stays; the app adds nothing.
    expect(chips()).toEqual(["List our open projects"]);
  });

  it("goes away once the person has written", async () => {
    const w = world({ thread: page(HELLO_REQUEST, HELLO, mine("e3", "What do you know about us?", 1)) });
    await mountNewBotDm(w, "What do you know about us?");
    expect(chips()).toEqual([]);
  });

  it("sends exactly one visible message with the request, and exactly one hidden request with the company's apps", async () => {
    const w = world({ connections: [LINEAR] });
    await mountNewBotDm(w, "Quite a lot already.");
    await vi.waitFor(() => expect(chips()).toEqual(["Connect Slack or tools"]));
    const button = chip("Connect Slack or tools");
    button.click();
    button.click();
    await vi.waitFor(() => expect(w.sendDm).toHaveBeenCalled());
    await settle(20);
    expect(visibleSends(w)).toHaveLength(1);
    const [to, body] = visibleSends(w)[0]!;
    expect(to).toBe(NOVA);
    expect(body).toBe("Connect more tools");
    // The bot also gets one request the person never sees, with the apps and
    // the picking rules, keyed to the person's message.
    await vi.waitFor(() => expect(hidden(w)).toHaveLength(1));
    const [hiddenTo, hiddenBody, extras] = hidden(w)[0]!;
    expect(hiddenTo).toBe(NOVA);
    expect(hiddenBody).toMatch(/^Automatic message from HQ: Corey just asked to connect more apps/);
    expect(hiddenBody).toContain("- Linear (linear.app): connected, not shared with you");
    expect(hiddenBody).toContain("Pick up to four apps");
    const key = (extras as { audience?: string; idempotencyKey?: string }).idempotencyKey ?? "";
    expect((extras as { audience?: string }).audience).toBe("agent");
    expect(key).toMatch(new RegExp(`^new-bot-connect-more-${NOVA}-sent_`));
    expect(threadText()).not.toContain("Automatic message from HQ");
    // The row is put away, and nothing extra is drawn until the bot answers.
    expect(chips()).toEqual([]);
    expect(cardsIn(host)).toHaveLength(2);
    // A typed request gets the same hidden request, once per message.
    await settle(20);
    expect(hidden(w)).toHaveLength(1);
  });

  it("draws the app-chosen cards under a bot answer that carries no block: Slack, then the person's own apps", async () => {
    const w = world({ thread: askedAgain(), connections: [LINEAR] });
    await mountNewBotDm(w, "Here are your connections.");
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(2));
    expect(cardsIn(message("e6")).map((el) => [el.dataset.target, el.dataset.domain ?? null, el.dataset.state])).toEqual([
      ["slack", null, "offered"],
      ["integration", "linear.app", "connected"],
    ]);
    expect(cardIn(message("e6"), "integration").textContent).toContain("Connected. Let Nova use it?");
    // No catalog lookup for an app that is connected.
    expect(w.catalogSearch).not.toHaveBeenCalled();
    expect(cardsIn(message("e2"))).toHaveLength(2);
    expect(cardsIn(message("e4"))).toHaveLength(0);
    // The person's own request is an ordinary message in the conversation.
    expect(message("e5").textContent).toContain("Connect more tools");
    // The cards are right there, so the button is not offered again.
    expect(chips()).toEqual([]);
    // Nothing about which message carries them is stored.
    expect(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "").not.toContain("e6");
  });

  it("offers the button again under a later bot message", async () => {
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
    await mountNewBotDm(w, "Tell me what to look at.");
    // A request typed by hand, in lower case with a full stop, counts too.
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(1));
    expect(cardsIn(message("e8"))).toHaveLength(0);
    await vi.waitFor(() => expect(chips()).toEqual(["Connect Slack or tools"]));
  });

  it("gives no second set to an answer that already has a connect block", async () => {
    const w = world({ thread: askedAgain(`Here you go.${fence([{ kind: "connect", targets: ["tools"] }])}`) });
    await mountNewBotDm(w, "Here you go.");
    await vi.waitFor(() => expect(cardsIn(message("e6"))).toHaveLength(1));
    await settle(20);
    expect(cardsIn(message("e6")).map((el) => el.dataset.target)).toEqual(["tools"]);
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

  it("offers the button for a cloud bot this device has no record of, without asking what is connected", async () => {
    const w = world({ thread: page(mine("e3", "Hello", 1), novas("e4", "Hello Corey.", 1)) });
    await mountRow(w, DM_ROW(NOVA), "Hello Corey.");
    // Nothing is known about its connections, so the button does not claim that nothing is connected.
    await vi.waitFor(() => expect(chips()).toEqual(["Connect more"]));
    expect(cardsIn(host)).toHaveLength(0);
    // No cards on screen: the company's connections are not read just to word a button.
    expect(w.listConnections).not.toHaveBeenCalled();
    chip("Connect more").click();
    await vi.waitFor(() => expect(visibleSends(w)).toHaveLength(1));
    expect(visibleSends(w)[0]![1]).toBe("Connect more tools");
    expect(hidden(w)).toHaveLength(0);
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

  it("does nothing in a channel", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({ channel: asked(NOVA) });
    const row = { id: "ch:chn_team", kind: "channel", title: "team", channelId: "chn_team", channelScope: "channel", companyUid: COMPANY } as ConversationRow;
    await mountRow(w, row, "Here are your connections.");
    expectNothing(w);
  });
});
