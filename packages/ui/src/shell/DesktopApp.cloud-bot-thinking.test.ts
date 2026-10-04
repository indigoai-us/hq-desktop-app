// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * A cloud bot's "is thinking" row stays up until the bot answers.
 *
 * Owner walkthrough: the rows started by the app's hidden notices to the bot
 * (a tool connected) were unpinned, so the bot message 100 s and 21 s before
 * each notice ended them on the next page fetch, long before the answer.
 * Every row ending also writes one `bot-thinking` line to the file log.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

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

const iso = (ms: number): string => new Date(ms).toISOString();

/** Newest first, as the server returns a direct-message page. The bot's
 *  hello landed 100 s ago: inside the old two-minute skew window. */
function thread(now: number): Row[] {
  return [
    { eventId: "e2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: iso(now - 100_000), rootEventId: "e1" },
    {
      eventId: "e1",
      fromPersonUid: "prs_me",
      fromDisplayName: "Corey",
      body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }),
      createdAt: iso(now - 130_000),
      audience: "agent",
      replyCount: 1,
    },
  ];
}

interface World {
  thread: Row[];
  connections: Row[];
  sendDm: ReturnType<typeof vi.fn>;
  grantConnectionAccess: ReturnType<typeof vi.fn>;
}

function world(now: number, connections: Row[] = []): World {
  return {
    thread: thread(now),
    connections,
    sendDm: vi.fn(async () => ok({ eventId: `sent_${Math.random().toString(36).slice(2)}` })),
    grantConnectionAccess: vi.fn(async () => ok({ connectionId: "acct_linear" })),
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
    agents: {
      getStatus: async () =>
        ok({
          setupState: { phase: "ready" },
          agent: { companyUid: COMPANY, runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" }, channels: null, channelDiagnostics: {} },
        }),
    },
    integrations: {
      listConnections: async () =>
        ok({
          companyUid: COMPANY,
          viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
          factoryEnabled: true,
          connections: w.connections,
          audit: [],
        }),
      grantConnectionAccess: w.grantConnectionAccess,
      catalogSearch: async () => ok({ ok: true, companyUid: COMPANY, entries: [] }),
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
let hqLog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  hqLog = vi.fn();
  (globalThis as { __hqLog?: unknown }).__hqLog = hqLog;
});

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
  delete (globalThis as { __hqLog?: unknown }).__hqLog;
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW: ConversationRow = { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: null } as ConversationRow;

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const thinkingRow = (): Element | null => host.querySelector('[data-testid="agent-thinking-row"]');
const hiddenNotices = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");
const thinkingLog = (): string[] =>
  hqLog.mock.calls.filter(([tag]) => tag === "bot-thinking").map(([, line]) => String(line));

async function mountNewBotDm(w: World, wakes = createChatWakeBus()) {
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
      companies: [ACME],
      wakes,
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain("Hi Corey, I am Nova."));
  await settle();
  return wakes;
}

/** The bot answers, and the next page fetch carries it. */
async function botAnswers(w: World, wakes: ReturnType<typeof createChatWakeBus>): Promise<void> {
  w.thread = [
    { eventId: "e9", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Done.", createdAt: iso(Date.now() + 1_000) },
    ...w.thread,
  ];
  wakes.emit("mesh:catchup", {} as { reason: "connect" | "focus" });
  await settle(20);
}

async function typeAndSend(text: string): Promise<void> {
  const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
  expect(composer, "live composer renders for the bot DM").toBeTruthy();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(20);
}

describe("DesktopApp cloud bot thinking row", () => {
  it("a notice's row outlives a page fetch that still carries the bot's earlier message, and ends on the answer", async () => {
    const w = world(Date.now(), [
      {
        id: "acct_linear",
        provider: "factory:linear",
        status: "connected",
        createdBy: "prs_me",
        createdAt: "2026-10-02T14:10:00.000Z",
        updatedAt: "2026-10-02T14:10:00.000Z",
        access: { mode: "private", grantCount: 0 },
        installation: { displayName: "Linear", domain: "linear.app" },
      },
    ]);
    const wakes = await mountNewBotDm(w);
    const allow = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(
        '[data-testid="connection-card"][data-domain="linear.app"] [data-testid="connection-card-primary"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    allow.click();
    await settle(20);
    await vi.waitFor(() => expect(hiddenNotices(w)).toHaveLength(1));
    await vi.waitFor(() => expect(thinkingRow()).not.toBeNull());

    // The next page fetch: the bot's hello (100 s old) is on it again.
    wakes.emit("mesh:catchup", {} as { reason: "connect" | "focus" });
    await settle(20);
    expect(thinkingRow(), "the bot's earlier message does not end the row").not.toBeNull();
    expect(thinkingLog()).toEqual([]);

    await botAnswers(w, wakes);
    expect(thinkingRow(), "the answer ends the row").toBeNull();
    const lines = thinkingLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^ended agent=${NOVA} row=dm:${NOVA} reason=newer-message elapsedMs=\\d+ pinned=yes$`));
  });

  it("'Connect more tools' is one message: its row stays pinned through a page fetch and ends on the answer", async () => {
    // B-9: the app used to send a hidden request right after this message,
    // and the bot answered both. Now the person's message is the only one.
    const w = world(Date.now());
    const wakes = await mountNewBotDm(w);
    await typeAndSend("Connect more tools");
    await settle(40);
    expect(w.sendDm).toHaveBeenCalledTimes(1);
    expect(hiddenNotices(w)).toHaveLength(0);
    expect(thinkingRow()).not.toBeNull();

    wakes.emit("mesh:catchup", {} as { reason: "connect" | "focus" });
    await settle(20);
    expect(thinkingRow(), "the bot's earlier message does not end the row").not.toBeNull();

    await botAnswers(w, wakes);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([
      expect.stringMatching(new RegExp(`^ended agent=${NOVA} row=dm:${NOVA} reason=newer-message elapsedMs=\\d+ pinned=yes$`)),
    ]);
  });

  it("logs the expiry when no answer comes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    await mountNewBotDm(w);
    await typeAndSend("Are you there?");
    expect(thinkingRow()).not.toBeNull();

    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([
      expect.stringMatching(new RegExp(`^ended agent=${NOVA} row=dm:${NOVA} reason=expired elapsedMs=\\d+ pinned=yes$`)),
    ]);
  });
});

/**
 * B-4: a hello request the bot had already answered started a thinking row
 * that nothing ended for ten minutes. What the row does is decided by
 * `helloThinkingState` (agent-thinking.test.ts). This holds the shell to it:
 * the request's time is kept, the decision waits for the conversation to
 * load, and the row is never started without asking.
 */
describe("DesktopApp: the row for a hello request in flight (source contract)", () => {
  const source = readFileSync(join(import.meta.dirname, "DesktopApp.svelte"), "utf8");
  const effectStart = source.indexOf("const pending = uid ? cloudBotHelloPending[uid] : undefined;");
  const effect = source.slice(effectStart, source.indexOf("const SETUP_DONE_PLACEHOLDER", effectStart));

  it("keeps the time the request was sent with the pending bot", () => {
    expect(source).toContain("let cloudBotHelloPending = $state<Record<string, { name: string; askedAt: number }>>({});");
    const send = source.slice(source.indexOf("async function sendCloudBotHello("), source.indexOf("async function cloudBotHelloArrived("));
    expect(send.indexOf("const askedAt = Date.now();")).toBeGreaterThan(-1);
    // Taken before the request leaves, so the bot's answer is never older than it.
    expect(send.indexOf("const askedAt = Date.now();")).toBeLessThan(send.indexOf("adapter.messaging.sendDm("));
  });

  it("waits for the conversation to load, then asks helloThinkingState before starting a row", () => {
    expect(effectStart).toBeGreaterThan(-1);
    expect(effect).toContain("liveTimelineId !== row.id || timelineHydrating) return;");
    const decide = effect.indexOf("helloThinkingState(messages, uid, pending.askedAt, Date.now())");
    const start = effect.indexOf("startThinkingIn(");
    expect(decide).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(decide);
    expect(effect.slice(decide, start)).toContain('if (decision.state !== "start") return;');
    // Started as of the request, pinned to the bot's newest message.
    expect(effect.slice(start)).toContain("decision.startedAt,");
    expect(effect.slice(start)).toContain("{ afterMs: decision.afterMs }");
  });
});
