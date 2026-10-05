// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus, type ChatWakeBus } from "../chat/chat-api.js";
import { CONNECTIONS_RETRY_BASE_MS, ROW_SETTLE_MS } from "../chat/messaging/integration-cards-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * When the connection cards under a bot's message appear.
 *
 * Live, 2026-10-04: a new bot's first message came with its cards 7.5 to
 * 10.4 s late. The block was parsed with the message, but the row drew
 * nothing until the company's connection list was known, and that list was
 * read only after a message with cards was already on screen, behind a
 * second read of the bot's status. A failed list read was never tried again.
 *
 * Now the two are read when a cloud bot's conversation opens (the list at the
 * same time as the status, and the status from the conversation's own poll),
 * a failed list read is tried again, and an app that needs a catalog lookup
 * does not keep the other cards of its row from drawing.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
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

const fence = (blocks: unknown[]): string => `\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks })}\n\`\`\``;

type Row = Record<string, unknown>;

/** The person's own Linear connection: a card that is known the moment the list is. */
const LINEAR: Row = {
  id: "acct_linear",
  provider: "factory:linear",
  status: "connected",
  createdBy: "prs_me",
  createdAt: "2026-10-02T14:10:00.000Z",
  access: { mode: "private", grantCount: 0 },
  installation: { displayName: "Linear", domain: "linear.app" },
};
const NOTION_MATCH: Row = { name: "Notion", domain: "notion.so", mcpReady: true, authClass: "oauth", source: "integrations.sh" };

const mine = (eventId: string, body: string, second: number): Row => ({
  eventId,
  fromPersonUid: "prs_me",
  fromDisplayName: "Corey",
  body,
  createdAt: `2026-10-02T14:00:${String(second).padStart(2, "0")}.000Z`,
});
const novas = (eventId: string, body: string, second: number): Row => ({
  eventId,
  fromPersonUid: NOVA,
  fromDisplayName: "Nova",
  body,
  createdAt: `2026-10-02T14:00:${String(second).padStart(2, "0")}.000Z`,
});
/** A page of the direct message, newest first as the server returns it. */
const page = (...oldestFirst: Row[]): Row[] => [...oldestFirst].reverse();

/** A conversation with no cards in it yet. */
const QUIET = page(mine("p1", "Hello", 1), novas("b1", "Hello Corey.", 2));
/** The bot's next message: Slack, the connected Linear, and Notion, which needs a catalog lookup. */
const OFFER = novas(
  "b2",
  `Here is what I can connect.${fence([{ kind: "connect", items: [{ domain: "notion.so" }, { app: "slack" }, { domain: "linear.app" }] }])}`,
  30,
);

const STATUS = {
  setupState: { phase: "ready" },
  agent: { companyUid: COMPANY, runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" }, channels: null, channelDiagnostics: { slack: { inboundCapability: "unknown" } } },
};
const LIST = {
  companyUid: COMPANY,
  viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
  factoryEnabled: true,
  connections: [LINEAR],
  audit: [],
};
const FAILED = { ok: false as const, reason: "error" as const, code: "http-500", message: "boom" };

interface World {
  thread: Row[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  catalogSearch: ReturnType<typeof vi.fn>;
}

function world(over: Partial<World> = {}): World {
  return {
    thread: QUIET,
    getStatus: vi.fn(async () => ok(STATUS)),
    listConnections: vi.fn(async () => ok(LIST)),
    catalogSearch: vi.fn(async (_company: string, query: string) =>
      ok({ ok: true, companyUid: COMPANY, entries: query === "notion.so" ? [NOTION_MATCH] : [] }),
    ),
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
      sendDm: async () => ok({ eventId: "sent_1" }),
    },
    agents: { getStatus: w.getStatus },
    integrations: { listConnections: w.listConnections, grantConnectionAccess: async () => ok({}), catalogSearch: w.catalogSearch },
    settings: { getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }) },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
});

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW = (companyUid: string | null = null): ConversationRow =>
  ({ id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid }) as ConversationRow;

async function mountDm(w: World, wakes: ChatWakeBus, row: ConversationRow = DM_ROW(), shows = "Hello Corey."): Promise<void> {
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
      wakes,
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(shows));
  await settle();
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const message = (eventId: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`);
const cardsIn = (el: ParentNode | null): HTMLElement[] => (el ? [...el.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')] : []);
const idsIn = (el: ParentNode | null): string[] => cardsIn(el).map((card) => card.dataset.domain ?? card.dataset.target ?? "");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopApp: the cards of a bot's message show with the message", () => {
  it("reads the bot's connections when the conversation opens, before any message has cards", async () => {
    const w = world();
    await mountDm(w, createChatWakeBus());
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
    expect(cardsIn(host)).toHaveLength(0);
    // One status read: the conversation's poll. The cards take its answer.
    expect(w.getStatus).toHaveBeenCalledTimes(1);
  });

  // Rewritten 2026-10-05. It asserted that a row drew the cards it knew at
  // once (Slack, the connected Linear) and that an app waiting for its
  // catalog lookup joined later. The owner, of that: "it showed immediately
  // but the other cards took a while to show up". A row now draws as one
  // unit: nothing until every card it names is known, then all of them, in
  // the row's order, Slack first.
  it("a message that arrives with a connect block draws its row whole, once every card is known, and asks for no list again", async () => {
    const catalog = deferred<unknown>();
    const w = world({ catalogSearch: vi.fn(() => catalog.promise) });
    const wakes = createChatWakeBus();
    await mountDm(w, wakes);
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await settle();
    expect(cardsIn(host)).toHaveLength(0);

    const frames: string[][] = [];
    const observer = new MutationObserver(() => {
      const el = message("b2");
      const ids = el ? idsIn(el) : [];
      if (ids.length > 0 && ids.join() !== frames[frames.length - 1]?.join()) frames.push(ids);
    });
    observer.observe(host, { childList: true, subtree: true });
    w.thread = [OFFER, ...QUIET];
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "b2", createdAt: String(OFFER.createdAt), direction: "in" });
    await vi.waitFor(() => expect(message("b2")).not.toBeNull());
    await settle();
    // Notion still waits for the catalog: the row shows nothing yet.
    expect(idsIn(message("b2"))).toEqual([]);
    expect(w.catalogSearch).toHaveBeenCalledTimes(1);
    expect(w.catalogSearch.mock.calls[0]![1]).toBe("notion.so");
    catalog.resolve(ok({ ok: true, companyUid: COMPANY, entries: [NOTION_MATCH] }));
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "notion.so", "linear.app"]));
    observer.disconnect();
    // One frame with cards: all of them at once.
    expect(frames).toEqual([["slack", "notion.so", "linear.app"]]);
    // Nothing was read again for it: not the list, not the status.
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(w.getStatus).toHaveBeenCalledTimes(1);
  });

  it("a row whose catalog lookup is slow draws what is known after the settle time, and the late card joins at the end", async () => {
    const catalog = deferred<unknown>();
    const w = world({ catalogSearch: vi.fn(() => catalog.promise) });
    const wakes = createChatWakeBus();
    await mountDm(w, wakes);
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    w.thread = [OFFER, ...QUIET];
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "b2", createdAt: String(OFFER.createdAt), direction: "in" });
    await vi.waitFor(() => expect(message("b2")).not.toBeNull());
    await settle();
    expect(idsIn(message("b2"))).toEqual([]);
    // The wait is bounded: after it, Slack and the connected Linear draw.
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "linear.app"]), { timeout: ROW_SETTLE_MS + 2_000, interval: 50 });
    const [slackEl, linearEl] = cardsIn(message("b2"));
    catalog.resolve(ok({ ok: true, companyUid: COMPANY, entries: [NOTION_MATCH] }));
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "linear.app", "notion.so"]));
    expect(cardsIn(message("b2"))[0]).toBe(slackEl);
    expect(cardsIn(message("b2"))[1]).toBe(linearEl);
  }, 10_000);

  it("reads the list at the same time as the status when the row names the company", async () => {
    // A bot made here is a cloud bot before its status answers.
    window.localStorage.setItem("hq.chat.newCloudBots.v1", JSON.stringify([NOVA]));
    const status = deferred<unknown>();
    const w = world({ getStatus: vi.fn(() => status.promise) });
    await mountDm(w, createChatWakeBus(), DM_ROW(COMPANY));
    // The status has not answered, and the list is already asked for.
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    expect(w.listConnections).toHaveBeenCalledWith(COMPANY);
    expect(w.getStatus).toHaveBeenCalledTimes(1);
    status.resolve(ok(STATUS));
    await settle(40);
    // The status named the same company: the list is not read a second time.
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    expect(w.getStatus).toHaveBeenCalledTimes(1);
  });

  it("reads the list as a method of the adapter's own integrations object", async () => {
    // An adapter's method may use `this`. A read taken off its object and
    // called bare would lose it.
    const calledOn: unknown[] = [];
    const w = world({
      listConnections: vi.fn(async function (this: unknown) {
        calledOn.push(this);
        return ok(LIST);
      }),
    });
    await mountDm(w, createChatWakeBus());
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    expect(calledOn).toHaveLength(1);
    expect((calledOn[0] as { listConnections?: unknown } | undefined)?.listConnections).toBe(w.listConnections);
  });

  it("reads the list again for the status's company when the row named another one", async () => {
    window.localStorage.setItem("hq.chat.newCloudBots.v1", JSON.stringify([NOVA]));
    const w = world();
    await mountDm(w, createChatWakeBus(), DM_ROW("cmp_other"));
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(2));
    expect(w.listConnections.mock.calls.map(([company]) => company)).toEqual(["cmp_other", COMPANY]);
  });
});

describe("DesktopApp: a list read that fails is tried again", () => {
  /** The bot's message is already in the conversation: Slack and the connected Linear. */
  const WITH_CARDS = [
    novas("b2", `Here is what I can connect.${fence([{ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }])}`, 30),
    ...QUIET,
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });

  async function pass(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }

  /** A list read that fails `times` times, then answers. */
  function failingThenOk(times: number, failure: () => unknown = () => FAILED): ReturnType<typeof vi.fn> {
    let calls = 0;
    return vi.fn(async () => {
      calls += 1;
      if (calls <= times) return failure();
      return ok(LIST);
    });
  }

  it("draws what it can without the list after the settle time, then the app's card once a later read answers", async () => {
    const w = world({ thread: WITH_CARDS, listConnections: failingThenOk(1) });
    await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await settle();
    const asked = w.getStatus.mock.calls.length;

    // The first try again comes two seconds after the failure, not before.
    await pass(CONNECTIONS_RETRY_BASE_MS - 500);
    expect(w.listConnections).toHaveBeenCalledTimes(1);
    await pass(600);
    expect(w.listConnections).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "linear.app"]));
    // The status was known: the retry reads the list alone.
    expect(w.getStatus).toHaveBeenCalledTimes(asked);
    // Answered: nothing more is asked.
    await pass(120_000);
    expect(w.listConnections).toHaveBeenCalledTimes(2);
  });

  it("shows the Slack card without the list once the row has waited the settle time", async () => {
    // The list never answers well. The row named an app, so it waited for the
    // list; after the settle time it draws the card that does not need it.
    const w = world({ thread: WITH_CARDS, listConnections: vi.fn(async () => FAILED) });
    await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await pass(ROW_SETTLE_MS + 200);
    expect(idsIn(message("b2"))).toEqual(["slack"]);
  });

  it("a message that arrives after the list was refused still gets its Slack card, once its own settle time is over", async () => {
    // Nothing reads the list again after a refusal, so nothing else would
    // tell this row that time has passed: the row keeps its own timer.
    const refused = { ok: false as const, reason: "error" as const, code: "http-403", message: "no" };
    const w = world({ listConnections: vi.fn(async () => refused) });
    const wakes = createChatWakeBus();
    await mountDm(w, wakes);
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await pass(60_000);

    w.thread = [OFFER, ...QUIET];
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "b2", createdAt: String(OFFER.createdAt), direction: "in" });
    await vi.waitFor(() => expect(message("b2")).not.toBeNull());
    await settle();
    // The row names apps and there is no list: it waits.
    expect(idsIn(message("b2"))).toEqual([]);
    await pass(ROW_SETTLE_MS - 500);
    expect(idsIn(message("b2"))).toEqual([]);
    await pass(700);
    expect(idsIn(message("b2"))).toEqual(["slack"]);
    expect(w.listConnections).toHaveBeenCalledTimes(1);
  });

  it("waits twice as long each time while the read keeps failing, and a read that throws counts as a failure", async () => {
    const w = world({
      thread: WITH_CARDS,
      listConnections: failingThenOk(3, () => {
        throw new Error("offline");
      }),
    });
    await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await settle();
    await pass(2_100);
    expect(w.listConnections).toHaveBeenCalledTimes(2);
    // Four seconds after the second failure, not two.
    await pass(2_100);
    expect(w.listConnections).toHaveBeenCalledTimes(2);
    await pass(2_000);
    expect(w.listConnections).toHaveBeenCalledTimes(3);
    // Eight after the third.
    await pass(6_000);
    expect(w.listConnections).toHaveBeenCalledTimes(3);
    await pass(2_200);
    expect(w.listConnections).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "linear.app"]));
  });

  it("tries at once when the network comes back", async () => {
    const w = world({ thread: WITH_CARDS, listConnections: failingThenOk(1) });
    await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await settle();
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(w.listConnections).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(idsIn(message("b2"))).toEqual(["slack", "linear.app"]));
    // The try that was waiting its turn is not made as well.
    await pass(10_000);
    expect(w.listConnections).toHaveBeenCalledTimes(2);
  });

  it("does not ask again after a refusal, or once the conversation is closed", async () => {
    for (const refusal of [
      { ok: false as const, reason: "error" as const, code: "http-403", message: "no" },
      { ok: false as const, reason: "error" as const, status: 404, message: "no" },
    ]) {
      const w = world({ thread: WITH_CARDS, listConnections: vi.fn(async () => refusal) });
      await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
      await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
      await pass(300_000);
      expect(w.listConnections).toHaveBeenCalledTimes(1);
      if (component) await unmount(component);
      component = null;
      host.remove();
    }

    const w = world({ thread: WITH_CARDS, listConnections: vi.fn(async () => FAILED) });
    await mountDm(w, createChatWakeBus(), DM_ROW(), "Here is what I can connect.");
    await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalledTimes(1));
    await settle();
    if (component) await unmount(component);
    component = null;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(w.listConnections).toHaveBeenCalledTimes(1);
  });
});
