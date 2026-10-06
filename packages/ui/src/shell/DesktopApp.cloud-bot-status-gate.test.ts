// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * N-1: a cloud bot that was not made in the New Bot flow on this device is
 * known to be a cloud bot only once the server answers this person's read of
 * its status. One failed read (the network, a 5xx, a timeout, a 401 while
 * the sign-in is refreshed) used to end the asking, so an owner's
 * conversation had no cards, no chips and no sync strip until they left it
 * and came back. Only a refusal (403, 404) ends it now.
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

/**
 * Newest first. The bot's first answer carries its own Slack card; its
 * newest message carries two suggestions (a message with cards shows none).
 */
const THREAD = [
  {
    eventId: "b3",
    fromPersonUid: NOVA,
    fromDisplayName: "Nova",
    body: `Or I can start on something else.${fence([{ kind: "suggestions", items: ["Summarize our company files", "List our open projects"] }])}`,
    createdAt: "2026-10-02T14:06:00.000Z",
  },
  {
    eventId: "b2",
    fromPersonUid: NOVA,
    fromDisplayName: "Nova",
    body: `Here is what I can connect.${fence([{ kind: "connect", items: [{ app: "slack" }] }])}`,
    createdAt: "2026-10-02T14:05:30.000Z",
  },
  { eventId: "p1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "What can you connect?", createdAt: "2026-10-02T14:05:00.000Z" },
];

const STATUS = ok({
  setupState: { phase: "ready" },
  agent: { companyUid: COMPANY, runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" }, channels: null, channelDiagnostics: { slack: { inboundCapability: "unknown" } } },
});

type StatusFn = (agentUid: string) => Promise<unknown>;

let thread: Array<Record<string, unknown>> = THREAD;

function adapter(getStatus: StatusFn, listConnections: () => Promise<unknown>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: thread }),
      sendDm: async () => ok({ eventId: "sent_1" }),
    },
    agents: { getStatus },
    integrations: {
      listConnections,
      grantConnectionAccess: async () => ok({}),
      catalogSearch: async () => ok({ ok: true, companyUid: COMPANY, entries: [] }),
    },
    settings: { getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }) },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  thread = THREAD;
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
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

async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const chips = (): string[] =>
  [...host.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')].map((el) => el.textContent?.trim() ?? "");

interface Mounted {
  getStatus: ReturnType<typeof vi.fn<StatusFn>>;
  listConnections: ReturnType<typeof vi.fn>;
}

/** The DM of a bot this device has no record of: the status read is the only sign it is a cloud bot. */
async function mountDm(getStatus: ReturnType<typeof vi.fn<StatusFn>>, shows = "Here is what I can connect."): Promise<Mounted> {
  const listConnections = vi.fn(async () =>
    ok({
      companyUid: COMPANY,
      viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
      connections: [],
      audit: [],
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(getStatus, listConnections),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: null } as ConversationRow,
      companies: [ACME],
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(shows));
  await vi.waitFor(() => expect(getStatus).toHaveBeenCalled());
  await settle();
  return { getStatus, listConnections };
}

function expectNoCloudBotFeatures(m: Mounted): void {
  expect(cards()).toHaveLength(0);
  expect(chips()).toEqual([]);
  expect(m.listConnections).not.toHaveBeenCalled();
}

async function expectCloudBotFeatures(): Promise<void> {
  await vi.waitFor(() => expect(cards().map((el) => el.dataset.target)).toEqual(["slack"]));
  await vi.waitFor(() => expect(chips()).toEqual(["Summarize our company files", "List our open projects"]));
}

/** A status read that fails `times` times in the given way, then answers. */
function failingThenOk(times: number, failure: () => unknown): ReturnType<typeof vi.fn<StatusFn>> {
  let calls = 0;
  return vi.fn<StatusFn>(async () => {
    calls += 1;
    if (calls <= times) return failure();
    return STATUS;
  });
}

describe("DesktopApp: the status read that says a bot is a cloud bot", () => {
  const FAILURES: Array<[string, () => unknown]> = [
    ["a failure with no http code", () => ({ ok: false, reason: "unavailable", message: "offline" })],
    ["a 500", () => ({ ok: false, reason: "error", code: "http-500", message: "boom" })],
    ["a 502 by status", () => ({ ok: false, reason: "error", status: 502, message: "bad gateway" })],
    ["a 401 while the sign-in is refreshed", () => ({ ok: false, reason: "error", code: "http-401", message: "expired" })],
    ["a 401 by status", () => ({ ok: false, reason: "error", status: 401, message: "expired" })],
    [
      "a read that throws",
      () => {
        throw new Error("timeout");
      },
    ],
  ];

  for (const [name, failure] of FAILURES) {
    it(`${name} is retried, and the cards and chips appear once a later read answers`, async () => {
      const m = await mountDm(failingThenOk(1, failure));
      expect(m.getStatus).toHaveBeenCalledTimes(1);
      expectNoCloudBotFeatures(m);

      // Nothing more is asked before the wait is over.
      await pass(9_000);
      expect(m.getStatus).toHaveBeenCalledTimes(1);
      // The next try comes by itself, without the person leaving the
      // conversation.
      await pass(2_000);
      await expectCloudBotFeatures();
      expect(m.listConnections).toHaveBeenCalledWith(COMPANY);
      // Rewritten 2026-10-04: this used to allow "2 or more", because the
      // cards read the status a second time once the poll had answered. The
      // cards now take the poll's own answer: the failed read, then the one
      // that answered, and no third.
      await pass(1_000);
      expect(m.getStatus).toHaveBeenCalledTimes(2);
      expect(m.listConnections).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps trying, less often each time, while the read keeps failing", async () => {
    const m = await mountDm(failingThenOk(3, () => ({ ok: false, reason: "error", code: "http-503", message: "busy" })));
    expect(m.getStatus).toHaveBeenCalledTimes(1);
    await pass(11_000);
    expect(m.getStatus).toHaveBeenCalledTimes(2);
    // 20 s after the second failure, not 10.
    await pass(11_000);
    expect(m.getStatus).toHaveBeenCalledTimes(2);
    await pass(10_000);
    expect(m.getStatus).toHaveBeenCalledTimes(3);
    expectNoCloudBotFeatures(m);
    // 40 s after the third.
    await pass(35_000);
    expect(m.getStatus).toHaveBeenCalledTimes(3);
    await pass(6_000);
    await expectCloudBotFeatures();
    // Three failed reads and the one that answered. The cards add no read of
    // their own (rewritten 2026-10-04: was "4 or more").
    expect(m.getStatus).toHaveBeenCalledTimes(4);
  });

  it("opens with one status read and one list read: the cards take the poll's answer", async () => {
    const m = await mountDm(vi.fn<StatusFn>(async () => STATUS));
    await expectCloudBotFeatures();
    await pass(1_000);
    expect(m.getStatus).toHaveBeenCalledTimes(1);
    expect(m.listConnections).toHaveBeenCalledTimes(1);
    expect(m.listConnections).toHaveBeenCalledWith(COMPANY);
  });

  it("asks again at once when the window comes back to the front, becomes visible, or the network returns", async () => {
    const resumes: Array<[string, () => void]> = [
      ["focus", () => window.dispatchEvent(new Event("focus"))],
      ["online", () => window.dispatchEvent(new Event("online"))],
      ["visible", () => document.dispatchEvent(new Event("visibilitychange"))],
    ];
    for (const [name, resume] of resumes) {
      const m = await mountDm(failingThenOk(1, () => ({ ok: false, reason: "unavailable" })));
      expect(m.getStatus, name).toHaveBeenCalledTimes(1);
      resume();
      await settle();
      // The failed read, and the one made at once on coming back. The cards
      // use that answer too (rewritten 2026-10-04: was "2 or more").
      expect(m.getStatus, name).toHaveBeenCalledTimes(2);
      await expectCloudBotFeatures();
      await settle();
      // Answered: coming back again asks nothing more.
      const asked = m.getStatus.mock.calls.length;
      resume();
      resume();
      await settle();
      expect(m.getStatus, name).toHaveBeenCalledTimes(asked);
      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });

  it("does not ask while the window is hidden", async () => {
    const m = await mountDm(failingThenOk(1, () => ({ ok: false, reason: "unavailable" })));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await settle();
      expect(m.getStatus).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
    }
  });

  for (const refusal of [
    { ok: false, reason: "error", code: "http-403", message: "no" },
    { ok: false, reason: "error", code: "http-404", message: "no" },
    { ok: false, reason: "error", status: 403, message: "no" },
    { ok: false, reason: "error", status: 404, message: "no" },
  ]) {
    it(`a refusal (${refusal.code ?? refusal.status}) stops after one call, whatever happens next`, async () => {
      const m = await mountDm(vi.fn<StatusFn>(async () => refusal));
      expect(m.getStatus).toHaveBeenCalledTimes(1);
      await pass(600_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await pass(60_000);
      expect(m.getStatus).toHaveBeenCalledTimes(1);
      expectNoCloudBotFeatures(m);
    });
  }
});

/**
 * A plain member's read of a cloud bot's status is answered 404, so that
 * member gets no cards and no chips in the bot's conversation. What the bot
 * wrote must still read normally, and a message that was nothing but cards
 * must not leave an empty row with the bot's name on it.
 */
describe("DesktopApp: a member who may not read the bot's status", () => {
  const CONNECT = fence([{ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }]);
  const refusedRead = () => vi.fn<StatusFn>(async () => ({ ok: false, reason: "error", code: "http-404", message: "Not found" }));
  const messageRow = (eventId: string): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`);
  const row = (eventId: string, from: string, body: string, at: string): Record<string, unknown> => ({
    eventId,
    fromPersonUid: from,
    fromDisplayName: from === NOVA ? "Nova" : "Corey",
    body,
    createdAt: `2026-10-02T14:${at}.000Z`,
  });

  it("reads the prose of a message that also carries a connect block, with no cards and no raw block", async () => {
    thread = [row("b2", NOVA, `Here is what I can connect.${CONNECT}`, "05:30"), row("p1", "prs_me", "What can you connect?", "05:00")];
    const m = await mountDm(refusedRead());
    await pass(1_000);
    expect(messageRow("b2")?.textContent).toContain("Here is what I can connect.");
    expect(threadText()).not.toContain("hq-block");
    expect(threadText()).not.toContain("linear.app");
    expectNoCloudBotFeatures(m);
    expect(m.getStatus).toHaveBeenCalledTimes(1);
  });

  it("draws nothing for a message that is only a connect block: no empty row under the bot's name", async () => {
    thread = [
      row("b4", NOVA, "Anything else?", "07:00"),
      row("b3", NOVA, CONNECT.trim(), "06:00"),
      row("b2", NOVA, "Hello Corey.", "05:30"),
      row("p1", "prs_me", "What can you connect?", "05:00"),
    ];
    const m = await mountDm(refusedRead(), "Anything else?");
    await pass(1_000);
    expect(messageRow("b2")).not.toBeNull();
    expect(messageRow("b4")).not.toBeNull();
    expect(messageRow("b3"), "the block-only message draws no row").toBeNull();
    expect(threadText()).not.toContain("hq-block");
    expectNoCloudBotFeatures(m);
  });

  it("an owner still sees that same message, as its cards", async () => {
    thread = [
      row("b3", NOVA, CONNECT.trim(), "06:00"),
      row("b2", NOVA, "Hello Corey.", "05:30"),
      row("p1", "prs_me", "What can you connect?", "05:00"),
    ];
    await mountDm(vi.fn<StatusFn>(async () => STATUS), "Hello Corey.");
    await vi.waitFor(() => expect(messageRow("b3")?.querySelectorAll('[data-testid="connection-card"]').length).toBeGreaterThan(0));
  });
});

/**
 * Round 2, c: "made in the New Bot flow on this device" is a fact about the
 * person who made the bot. A second account signing in on the same Mac must
 * not get it from what the first one left in storage.
 */
describe("DesktopApp: a bot another account made on this Mac", () => {
  const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";
  const CARDS_KEY = "hq.chat.botConnectionCards.v1";
  const MADE_KEY = "hq.chat.botHelloAskedAt.v1";
  const refusedRead = () => vi.fn<StatusFn>(async () => ({ ok: false, reason: "error", code: "http-404", message: "Not found" }));

  /** What the device holds after `maker` made Nova here in the New Bot flow. */
  function seedMadeHere(maker: string | null): void {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    window.localStorage.setItem(CARDS_KEY, JSON.stringify({ [NOVA]: {} }));
    if (maker) window.localStorage.setItem(MADE_KEY, JSON.stringify({ v: 2, accounts: { [maker]: { asked: {}, made: [NOVA] } } }));
  }

  it("is not 'made here' for the account now signed in: a refused status read means no cards, and the asking stops", async () => {
    seedMadeHere("prs_someone_else");
    const m = await mountDm(refusedRead());
    await pass(120_000);
    expectNoCloudBotFeatures(m);
    expect(m.getStatus).toHaveBeenCalledTimes(1);
    // The other account's record is left as it was.
    expect(JSON.parse(window.localStorage.getItem(MADE_KEY)!).accounts.prs_someone_else.made).toEqual([NOVA]);
  });

  it("is still a cloud bot for that account when the server lets it read the status", async () => {
    seedMadeHere("prs_someone_else");
    await mountDm(vi.fn<StatusFn>(async () => STATUS));
    await expectCloudBotFeatures();
  });

  it("stays 'made here' for the account that made it, whatever the status read says", async () => {
    seedMadeHere("prs_me");
    await mountDm(refusedRead());
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
  });

  it("a bot with no maker on record (made before accounts were kept apart) is treated as before", async () => {
    seedMadeHere(null);
    await mountDm(refusedRead());
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
  });
});
