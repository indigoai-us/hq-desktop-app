// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { MESSAGE_PERSON_EVENT } from "../chat/pending-conversation.js";
import { CARD_MODAL_BACKDROP_GUARD_MS } from "../chat/messaging/card-modal.js";
import {
  BOT_CONNECTION_CARDS_STORAGE_KEY,
  CONNECTING_TIMEOUT_MS,
} from "../chat/messaging/connection-card-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * Connecting a cloud bot to Slack from its Slack card: the card's button
 * opens the Connect Slack modal, the modal walks the person through it
 * against the server, the card follows the server, and the bot is told once.
 *
 * Nothing here opens the console's Slack page, and the pasted token is never
 * anywhere but the field and the one request that carries it.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";
/** An obviously fake app-level token. Never a real one. */
const TOKEN = "xapp-test-0000";
const INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0TEST";
const APP = "https://api.slack.com/apps/A0TEST";

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

type Row = Record<string, unknown>;

/** What the server has for the bot's Slack at each point of the usual path. */
const PENDING_INSTALL = { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP };
const INSTALLED = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP };
const TOKEN_STORED = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" };
/** The path with no token. */
const EVENTS_PENDING_INSTALL = { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "events" };
const EVENTS_INSTALLED = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "events" };

/** Newest first, as the server returns a direct-message page. */
function thread(peerUid: string): Row[] {
  return [
    { eventId: "e2", fromPersonUid: peerUid, fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
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

interface World {
  /** The bot's Slack row on the server, or null. */
  slack: Record<string, unknown> | null;
  /** What the bot can receive in Slack. */
  capability: string;
  companies: Workspace[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  attachSlack: ReturnType<typeof vi.fn>;
  submitSlackAppToken: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
  openUrl: Mock<(url: string) => void>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    slack: null,
    capability: "unknown",
    companies: [ACME],
    getStatus: vi.fn(async () =>
      ok({
        setupState: { phase: "ready" },
        agent: {
          companyUid: COMPANY,
          runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" },
          channels: w.slack ? { slack: w.slack } : null,
          channelDiagnostics: { slack: { inboundCapability: w.capability } },
        },
      }),
    ),
    listConnections: vi.fn(async () =>
      ok({
        companyUid: COMPANY,
        viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
        factoryEnabled: true,
        connections: [],
        audit: [],
      }),
    ),
    // The server sets the bot up and answers with what it made.
    attachSlack: vi.fn(async () => {
      w.slack = { ...PENDING_INSTALL };
      w.capability = "pending-install";
      return ok({ config: w.slack, followUpUrl: INSTALL });
    }),
    // The server checks the token, stores it and stops asking for it.
    submitSlackAppToken: vi.fn(async () => {
      w.slack = { ...TOKEN_STORED };
      w.capability = "socket-mode-degraded";
      return ok({ ok: true });
    }),
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
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: thread(NOVA) }),
      sendDm: w.sendDm,
    },
    agents: { getStatus: w.getStatus, attachSlack: w.attachSlack, submitSlackAppToken: w.submitSlackAppToken },
    integrations: { listConnections: w.listConnections, grantConnectionAccess: vi.fn() },
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
let clock = 0;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Time under the test's control: the dialog ignores a press on its backdrop
  // just after it opens, and the card's wait is measured against the clock.
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW: ConversationRow = { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: null } as ConversationRow;

/** A bot made in the New bot flow on this device, with its direct message open. */
async function mountNewBotDm(w: World, wait: "connections" | "status" = "connections"): Promise<void> {
  window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
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
      companies: w.companies,
      onopenurl: w.openUrl,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(cards()).toHaveLength(1));
  await vi.waitFor(() => expect(wait === "status" ? w.getStatus : w.listConnections).toHaveBeenCalled());
  await settle();
}

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const card = (target: "slack" | "tools"): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-testid="connection-card"][data-target="${target}"]`)!;
const primary = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]')!;
const decline = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]');
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="card-modal"]');
const inModal = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  dialog()?.querySelector<T>(`[data-testid="${id}"]`) ?? null;
const stage = (): string | undefined => inModal("slack-connect")?.dataset.stage;
const steps = (): string[] =>
  [...(dialog()?.querySelectorAll<HTMLElement>('[data-testid="card-modal-step"]') ?? [])].map(
    (el) => `${el.dataset.state}:${el.querySelector(".card-modal-step-text")!.textContent!.replace(/^Step \d+(, done)?: /, "").trim()}`,
  );
const tokenField = (): HTMLInputElement | null =>
  inModal("slack-connect-token")?.querySelector<HTMLInputElement>("input") ?? null;
/** Messages the app sent the bot on the lane the person never sees. */
const hiddenNotices = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");

/** The window came back to the front: the shell asks the server again. */
async function refocus(): Promise<void> {
  window.dispatchEvent(new Event("focus"));
  await settle(20);
}

async function openModal(): Promise<void> {
  // Past the card's own hold on a button it has just handled.
  await vi.waitFor(
    async () => {
      primary("slack").click();
      await settle();
      expect(dialog()).not.toBeNull();
    },
    { timeout: 3000 },
  );
  clock += CARD_MODAL_BACKDROP_GUARD_MS + 1;
}

async function closeModal(): Promise<void> {
  inModal<HTMLButtonElement>("card-modal-close")!.click();
  await settle();
  await vi.waitFor(() => expect(dialog()).toBeNull());
}

function paste(value: string): void {
  const input = tokenField()!;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function expectTokenNowhere(w: World): void {
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i += 1) {
      const name = store.key(i)!;
      expect(name).not.toContain(TOKEN);
      expect(store.getItem(name) ?? "").not.toContain(TOKEN);
    }
  }
  expect(window.location.href).not.toContain(TOKEN);
  expect(document.body.innerHTML).not.toContain(TOKEN);
  for (const input of document.querySelectorAll("input, textarea")) {
    expect((input as HTMLInputElement).value).not.toContain(TOKEN);
  }
  expect(JSON.stringify(w.openUrl.mock.calls)).not.toContain(TOKEN);
  expect(JSON.stringify(w.sendDm.mock.calls)).not.toContain(TOKEN);
  expect(JSON.stringify(w.getStatus.mock.calls)).not.toContain(TOKEN);
  expect(JSON.stringify(w.attachSlack.mock.calls)).not.toContain(TOKEN);
}

const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
function chord(target: EventTarget, key: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, code, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("DesktopApp: the Slack card opens the Connect Slack modal", () => {
  it("opens the modal from Connect Slack straight into the steps, and sets the bot up in Slack once", async () => {
    const w = world();
    let finish: (value: unknown) => void = () => {};
    w.attachSlack.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await mountNewBotDm(w);
    expect(primary("slack").textContent?.trim()).toBe("Connect Slack");
    expect(primary("slack").getAttribute("aria-haspopup")).toBe("dialog");
    await openModal();
    expect(inModal("card-modal-title")!.textContent).toBe("Connect Nova to Slack");
    expect(dialog()!.dataset.icon).toBe("slack");
    const cardArt = card("slack").querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    expect(dialog()!.querySelector<HTMLElement>(".card-modal-art")!.style.backgroundImage).toBe(cardArt);
    // No first screen: step 1 is current with its spinner, and the press on the card was the intent.
    expect(stage()).toBe("approve");
    expect(inModal("slack-connect-intro")).toBeNull();
    expect(inModal("slack-connect-start")).toBeNull();
    expect(steps()).toEqual(["current:Approve Nova in Slack", "todo:Create a token for Nova", "todo:HQ finishes the setup"]);
    expect(inModal("slack-connect-starting")).not.toBeNull();
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    expect(w.attachSlack).toHaveBeenCalledWith(NOVA);
    // Nothing opens by itself, and the card does not move until the server answers.
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(card("slack").dataset.state).toBe("offered");
    expect(hiddenNotices(w)).toHaveLength(0);
    finish(ok({ config: PENDING_INSTALL, followUpUrl: INSTALL }));
    await vi.waitFor(() => expect(inModal("slack-connect-open-slack")).not.toBeNull());
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
  });

  it("runs the whole flow: approve, token, connected card, one notice to the bot, and no token left anywhere", async () => {
    const w = world();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await mountNewBotDm(w);
    await openModal();

    // Opening the modal sets the bot up in Slack.
    await vi.waitFor(() => expect(stage()).toBe("approve"));
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    expect(w.attachSlack).toHaveBeenCalledWith(NOVA);
    expect(steps()).toEqual(["current:Approve Nova in Slack", "todo:Create a token for Nova", "todo:HQ finishes the setup"]);
    // The card behind follows the server.
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    expect(card("slack").textContent).toContain("Setup is not finished. Approve Nova in Slack.");
    expect(primary("slack").textContent?.trim()).toBe("Continue");
    expect(decline("slack")!.textContent?.trim()).toBe("Not now");

    inModal<HTMLButtonElement>("slack-connect-open-slack")!.click();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(w.openUrl).toHaveBeenCalledWith(INSTALL);

    // The person approved in Slack and came back to the app.
    w.slack = { ...INSTALLED };
    w.capability = "socket-mode-degraded";
    await refocus();
    await vi.waitFor(() => expect(stage()).toBe("token"));
    expect(steps()).toEqual(["done:Approve Nova in Slack", "current:Create a token for Nova", "todo:HQ finishes the setup"]);
    expect(card("slack").textContent).toContain("Setup is not finished. Paste the token to finish.");
    inModal<HTMLButtonElement>("slack-connect-open-app-page")!.click();
    expect(w.openUrl).toHaveBeenLastCalledWith(`${APP}/general`);

    expect(tokenField()!.type).toBe("password");
    paste(TOKEN);
    await settle();
    const field = tokenField()!;
    inModal<HTMLButtonElement>("slack-connect-submit")!.click();
    await vi.waitFor(() => expect(stage()).toBe("finishing"));
    expect(w.submitSlackAppToken).toHaveBeenCalledTimes(1);
    expect(w.submitSlackAppToken).toHaveBeenCalledWith(NOVA, TOKEN);
    expect(field.value).toBe("");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:Create a token for Nova", "current:HQ finishes the setup"]);
    expect(dialog()!.textContent).toContain("Connecting Nova to Slack. This usually takes a minute or two.");
    await vi.waitFor(() => expect(card("slack").textContent).toContain("Setup is not finished. Connecting."));
    expect(hiddenNotices(w)).toHaveLength(0);

    // The bot's computer connected.
    w.capability = "socket-mode";
    await refocus();
    await vi.waitFor(() => expect(stage()).toBe("connected"));
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:Create a token for Nova", "done:HQ finishes the setup"]);
    expect(dialog()!.textContent).toContain("Nova is in Slack. Invite it to a channel or send it a direct message.");
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    expect(card("slack").textContent).toContain("Nova is in Slack.");

    // The bot is told once, on the lane the person never sees.
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    const [to, body, extras] = hiddenNotices(w)[0]!;
    expect(to).toBe(NOVA);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `new-bot-slack-${NOVA}` });
    expect(body).toMatch(/^Automatic message from HQ: Corey just connected you to Slack\./);

    inModal<HTMLButtonElement>("slack-connect-finish")!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await refocus();
    expect(hiddenNotices(w)).toHaveLength(1);
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    expect(w.submitSlackAppToken).toHaveBeenCalledTimes(1);
    // Only Slack's own pages were opened: never the console's Slack page.
    expect(w.openUrl.mock.calls.map(([url]) => url)).toEqual([INSTALL, `${APP}/general`]);

    // The token is nowhere: not in storage, not in the page, not in anything sent.
    expectTokenNowhere(w);
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(TOKEN);
    expect(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "").not.toContain("xapp-");
  });

  it("runs the two-step flow when the server asks for no token", async () => {
    const w = world();
    w.attachSlack.mockImplementation(async () => {
      w.slack = { ...EVENTS_PENDING_INSTALL };
      w.capability = "pending-install";
      return ok({ config: w.slack, followUpUrl: INSTALL });
    });
    await mountNewBotDm(w);
    await openModal();
    await vi.waitFor(() => expect(steps()).toEqual(["current:Approve Nova in Slack", "todo:HQ finishes the setup"]));
    expect(stage()).toBe("approve");
    inModal<HTMLButtonElement>("slack-connect-open-slack")!.click();
    expect(w.openUrl).toHaveBeenCalledWith(INSTALL);

    w.slack = { ...EVENTS_INSTALLED };
    w.capability = "unknown";
    await refocus();
    await vi.waitFor(() => expect(stage()).toBe("finishing"));
    expect(steps()).toEqual(["done:Approve Nova in Slack", "current:HQ finishes the setup"]);
    expect(tokenField()).toBeNull();

    w.capability = "ok";
    await refocus();
    await vi.waitFor(() => expect(stage()).toBe("connected"));
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:HQ finishes the setup"]);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    expect(w.submitSlackAppToken).not.toHaveBeenCalled();
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
  });

  it("resumes at the right step when it is closed mid-way and opened again, without setting Slack up twice", async () => {
    const w = world();
    await mountNewBotDm(w);
    await openModal();
    await vi.waitFor(() => expect(inModal("slack-connect-open-slack")).not.toBeNull());
    expect(stage()).toBe("approve");
    await closeModal();
    expect(card("slack").dataset.state).toBe("connecting");
    expect(primary("slack").textContent?.trim()).toBe("Continue");

    // Opened again from Continue: the approve step, straight from the status, with no second setup.
    await openModal();
    expect(stage()).toBe("approve");
    expect(inModal("slack-connect-starting")).toBeNull();
    expect(inModal("slack-connect-open-slack")).not.toBeNull();
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    await closeModal();

    // Approved while the modal was closed: the card keeps asking and moves on.
    w.slack = { ...INSTALLED };
    w.capability = "socket-mode-degraded";
    await refocus();
    await vi.waitFor(() => expect(card("slack").textContent).toContain("Paste the token to finish."));
    await openModal();
    expect(stage()).toBe("token");
    expect(tokenField()!.value).toBe("");
    await closeModal();

    // Closed during the last step, too.
    w.slack = { ...TOKEN_STORED };
    await refocus();
    await openModal();
    expect(stage()).toBe("finishing");
    await closeModal();

    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    expect(w.submitSlackAppToken).not.toHaveBeenCalled();
  });

  it("resumes a setup that was started somewhere else, and still never attaches", async () => {
    const w = world({ slack: { ...INSTALLED }, capability: "socket-mode-degraded" });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    expect(primary("slack").textContent?.trim()).toBe("Continue");
    await openModal();
    expect(stage()).toBe("token");
    paste(TOKEN);
    await settle();
    inModal<HTMLButtonElement>("slack-connect-submit")!.click();
    await vi.waitFor(() => expect(stage()).toBe("finishing"));
    w.capability = "socket-mode";
    await refocus();
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connected"));
    // The person finished it here: the bot is told, once.
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    expect(w.attachSlack).not.toHaveBeenCalled();
    expectTokenNowhere(w);
  });

  it("keeps asking the server while the modal is open, and never sets Slack up over a setup that exists", async () => {
    const w = world();
    // Someone set Slack up on the web before the modal opened.
    w.slack = { ...PENDING_INSTALL };
    w.capability = "pending-install";
    await mountNewBotDm(w);
    expect(card("slack").dataset.state).toBe("connecting");
    await openModal();
    expect(stage()).toBe("approve");
    expect(inModal("slack-connect-starting")).toBeNull();
    expect(inModal("slack-connect-open-slack")).not.toBeNull();
    const asked = w.getStatus.mock.calls.length;
    await refocus();
    expect(w.getStatus.mock.calls.length).toBeGreaterThan(asked);
    // Approved in the meantime: the open modal moves on by itself.
    w.slack = { ...INSTALLED };
    w.capability = "socket-mode-degraded";
    await refocus();
    await vi.waitFor(() => expect(stage()).toBe("token"));
    expect(w.attachSlack).not.toHaveBeenCalled();
  });

  it("shows the blocked sentence to a member who is not an admin", async () => {
    const w = world();
    w.attachSlack.mockResolvedValue({ ok: false, reason: "error", code: "http-404", message: "Not found", status: 404 });
    await mountNewBotDm(w);
    await openModal();
    await vi.waitFor(() => expect(stage()).toBe("blocked"));
    expect(dialog()!.textContent).toContain("Only a company owner or admin can connect a bot to Slack.");
    expect(inModal("slack-connect-start")).toBeNull();
    expect(inModal("slack-connect-blocked-action")).toBeNull();
    // Nothing was started: the card is as it was, and the bot is told nothing.
    expect(card("slack").dataset.state).toBe("offered");
    inModal<HTMLButtonElement>("slack-connect-close")!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(card("slack").dataset.state).toBe("offered");
    expect(w.attachSlack).toHaveBeenCalledTimes(1);
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(hiddenNotices(w)).toHaveLength(0);
  });

  it("shows the blocked sentence at once, with nothing to press but Close, to a member who may not read the bot's status", async () => {
    const w = world();
    w.getStatus.mockResolvedValue({ ok: false, reason: "error", code: "http-404", message: "Not found" });
    // With no status there is no company to list connections for.
    await mountNewBotDm(w, "status");
    expect(card("slack").dataset.state).toBe("offered");
    await openModal();
    expect(stage()).toBe("blocked");
    expect(dialog()!.textContent).toContain("Only a company owner or admin can connect a bot to Slack.");
    expect(inModal("slack-connect-start")).toBeNull();
    await settle();
    expect(w.attachSlack).not.toHaveBeenCalled();
  });

  it("opens the company's HQ Integrations by its slug when the company's Slack is not connected to HQ", async () => {
    const w = world();
    w.attachSlack.mockResolvedValue({ ok: false, reason: "error", code: "FACTORY_ROOT_MISSING", message: "x", status: 400 });
    await mountNewBotDm(w);
    await openModal();
    await vi.waitFor(() => expect(stage()).toBe("blocked"));
    expect(dialog()!.textContent).toContain("Your company's Slack is not connected to HQ yet.");
    inModal<HTMLButtonElement>("slack-connect-blocked-action")!.click();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(w.openUrl).toHaveBeenCalledWith("https://hq.computer/companies/acme/integrations");
  });

  it("opens the company's bots page by its slug, or the web's front page when the slug is not known, never the uid", async () => {
    for (const [companies, url] of [
      [[ACME], "https://hq.computer/companies/acme/agents"],
      [[], "https://hq.computer"],
    ] as const) {
      const w = world({ companies: [...companies] });
      w.attachSlack.mockResolvedValue({ ok: false, reason: "error", code: "SLACK_PASTE_REQUIRED", message: "x", status: 409 });
      await mountNewBotDm(w);
      await openModal();
      await vi.waitFor(() => expect(stage()).toBe("blocked"));
      expect(inModal("slack-connect-blocked-action")!.textContent?.trim()).toBe("Open Slack setup");
      inModal<HTMLButtonElement>("slack-connect-blocked-action")!.click();
      expect(w.openUrl).toHaveBeenCalledTimes(1);
      expect(w.openUrl).toHaveBeenCalledWith(url);
      expect(JSON.stringify(w.openUrl.mock.calls)).not.toContain("cmp_");
      await unmount(component!);
      component = null;
      host.remove();
      window.localStorage.clear();
    }
  });
});

describe("DesktopApp: the Slack card while a setup is not finished", () => {
  it("does not time out a setup the server has, however long ago it was started here", async () => {
    const w = world();
    await mountNewBotDm(w);
    await openModal();
    await vi.waitFor(() => expect(inModal("slack-connect-open-slack")).not.toBeNull());
    await closeModal();
    expect(card("slack").dataset.state).toBe("connecting");

    clock += CONNECTING_TIMEOUT_MS + 60 * 60_000;
    await refocus();
    expect(card("slack").dataset.state).toBe("connecting");
    expect(card("slack").textContent).toContain("Setup is not finished. Approve Nova in Slack.");
    expect(primary("slack").textContent?.trim()).toBe("Continue");
    expect(card("slack").textContent).not.toContain("Slack was not connected.");
  });

  it("keeps Not now on a setup that is not finished", async () => {
    const w = world({ slack: { ...PENDING_INSTALL }, capability: "pending-install" });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    decline("slack")!.click();
    await settle();
    expect(card("slack").dataset.state).toBe("declined");
    expect(w.attachSlack).not.toHaveBeenCalled();
  });
});

describe("DesktopApp: the token and the app around the modal", () => {
  async function toTokenStep(w: World): Promise<void> {
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    await openModal();
    expect(stage()).toBe("token");
  }

  it("clears the token when the conversation changes, and the field is empty when the person comes back", async () => {
    const w = world({ slack: { ...INSTALLED }, capability: "socket-mode-degraded" });
    await toTokenStep(w);
    paste(TOKEN);
    await settle();
    const field = tokenField()!;
    expect(field.value).toBe(TOKEN);

    window.dispatchEvent(new CustomEvent(MESSAGE_PERSON_EVENT, { detail: { personUid: "prs_teammate" } }));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await settle();
    expect(field.value).toBe("");
    expectTokenNowhere(w);

    window.dispatchEvent(new CustomEvent(MESSAGE_PERSON_EVENT, { detail: { personUid: NOVA } }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await vi.waitFor(() => expect(card("slack").dataset.state).toBe("connecting"));
    await openModal();
    expect(stage()).toBe("token");
    expect(tokenField()!.value).toBe("");
    expect(w.submitSlackAppToken).not.toHaveBeenCalled();
    expectTokenNowhere(w);
  });

  it("clears the token when the modal is closed, and the field is empty when it is opened again", async () => {
    const w = world({ slack: { ...INSTALLED }, capability: "socket-mode-degraded" });
    await toTokenStep(w);
    paste(TOKEN);
    await settle();
    const field = tokenField()!;
    await closeModal();
    expect(field.value).toBe("");
    expectTokenNowhere(w);
    await openModal();
    expect(tokenField()!.value).toBe("");
  });

  it("lets no app shortcut fire from the token field or from a button, and nothing opens over the modal", async () => {
    const w = world({ slack: { ...INSTALLED }, capability: "socket-mode-degraded" });
    await toTokenStep(w);
    const field = tokenField()!;
    field.focus();
    // Paste, and the two shortcuts that would otherwise fire: one inside a field, one outside.
    const pasted = chord(field, "v", "KeyV");
    const help = chord(field, "/", "Slash");
    await settle();
    expect(pasted.defaultPrevented).toBe(false);
    expect(help.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-testid="shortcut-cheat-sheet"]')).toBeNull();

    const button = inModal<HTMLButtonElement>("slack-connect-open-app-page")!;
    button.focus();
    chord(button, "k", "KeyK");
    chord(button, ",", "Comma");
    chord(button, "[", "BracketLeft");
    chord(window, "k", "KeyK");
    await settle();
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
    expect(document.querySelector('[data-testid="shortcut-cheat-sheet"]')).toBeNull();
    // Still the same conversation, the same dialog, the same step.
    expect(dialog()).not.toBeNull();
    expect(stage()).toBe("token");
    expect(cards()).toHaveLength(1);

    // Once the modal is closed the shortcuts are back.
    await closeModal();
    chord(window, "k", "KeyK");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="command-palette"]')).not.toBeNull());
  });
});
