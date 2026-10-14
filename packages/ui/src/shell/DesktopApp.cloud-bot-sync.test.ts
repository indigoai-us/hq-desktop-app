// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { BOT_SYNC_DONE_VISIBLE_MS, BOT_SYNC_POLL_MS } from "../chat/bot-sync-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/**
 * The sync status in the header of a cloud bot's direct message: a still
 * sync glyph and one muted line to the right of "Direct message", shown
 * while the bot's company files are being downloaded, drawn from the bot's
 * status, gone a few seconds after the server says the files are there.
 *
 * Rewritten 2026-10-04. It used to be a full-width strip with a progress bar
 * under the header, and these tests pinned that strip (where it sat, its
 * bar's value). The owner asked for it in the header instead: "remove the
 * 'syncing' progress bar and just add it as a sync icon and message to the
 * right of the 'Direct message' in the header next to the bot's name". When
 * it shows and what it says come from the same model as before.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

const fence = (blocks: unknown[]): string => `\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks })}\n\`\`\``;
const SUGGESTIONS = fence([{ kind: "suggestions", items: ["Summarize our company files", "List our open projects"] }]);

type Row = Record<string, unknown>;

/** Newest first, as the server returns a direct-message page. */
function thread(peerUid: string, helloExtra = ""): Row[] {
  return [
    { eventId: "e2", fromPersonUid: peerUid, fromDisplayName: "Nova", body: `Hi Corey, I am Nova.${helloExtra}`, createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
    {
      eventId: "e1",
      fromPersonUid: "prs_me",
      fromDisplayName: "Corey",
      body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: true }),
      createdAt: "2026-10-02T13:53:50.000Z",
      audience: "agent",
      replyCount: 1,
    },
  ];
}

const CHAT_STEPS = [
  { name: "codex-auth", status: "done" },
  { name: "sync", status: "done" },
];

/** A status answer: the bot can chat; `runtime` says where its files are. */
function statusOf(runtime: Row, setupState: Row = { phase: "waiting", steps: CHAT_STEPS }): unknown {
  return { setupState, agent: { companyUid: COMPANY, runtime, channels: null } };
}

/** The bot's computer reported `ago` milliseconds back; its last sync run ended as `sync`. */
const heartbeat = (ago: number, sync = "unknown"): Row => ({ at: new Date(Date.now() - ago).toISOString(), components: { sync } });

/** A live download: a snapshot refreshed moments ago on a computer that is heartbeating. */
const downloading = (filesDone: number, filesTotal: number): Row => ({
  firstSyncStartedAt: new Date(Date.now() - 120_000).toISOString(),
  firstSync: {
    phase: "pull",
    filesTotal,
    filesDone,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 5_000).toISOString(),
  },
  lastHeartbeat: heartbeat(10_000),
});
const SYNCED: Row = { syncOkAt: "2026-10-02T14:20:00.000Z", firstSyncFinalized: { totalObjects: 412, startedAt: "2026-10-02T14:10:00.000Z", finishedAt: "2026-10-02T14:20:00.000Z" } };

interface World {
  thread: Row[];
  channel: Row[];
  /** What the next status read answers. A function may refuse the read. */
  status: () => unknown | null;
  getStatus: ReturnType<typeof vi.fn>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    thread: thread(NOVA),
    channel: [],
    status: () => statusOf(downloading(128, 412)),
    getStatus: vi.fn(async () => {
      const value = w.status();
      return value === null
        ? { ok: false as const, reason: "error" as const, code: "http-403", message: "Only owners and admins can read this." }
        : ok(value);
    }),
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
      sendDm: vi.fn(async () => ok({ eventId: "sent_1" })),
    },
    agents: { getStatus: w.getStatus },
    integrations: {
      listConnections: async () =>
        ok({ companyUid: COMPANY, viewer: { personUid: "prs_me", canManageIntegrations: true }, connections: [] }),
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
  vi.useRealTimers();
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
  await vi.waitFor(() => expect(w.getStatus).toHaveBeenCalled());
  await settle(20);
}

const threadEl = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="conversation-thread"]');
const threadText = (): string => threadEl()?.textContent ?? "";
const header = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="channel-header"]')!;
/** The sync status: the glyph and the line in the header. */
const syncStatus = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="bot-sync-status"]');
const syncText = (): string | null => host.querySelector('[data-testid="bot-sync-status-text"]')?.textContent ?? null;
const syncTitle = (): string | null => syncStatus()?.getAttribute("title") ?? null;
const chipRow = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="suggested-replies"]');

/** True when `a` comes before `b` in the page. */
const before = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** The strip and its progress bar are gone from the page, wherever one looks. */
function expectNoStrip(): void {
  expect(host.querySelector('[data-testid="bot-sync-widget"]')).toBeNull();
  expect(host.querySelector('[data-testid="bot-sync-progress"]')).toBeNull();
  expect(host.querySelector('[data-testid="conversation-strip"]')).toBeNull();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
}

describe("DesktopApp sync status in the header of a cloud bot's direct message", () => {
  it("shows for a bot whose files are still downloading, with the server's real percent", async () => {
    const w = world();
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    const el = syncStatus()!;
    expect(el.dataset.state).toBe("syncing");
    expect(syncText()).toBe("Syncing your company's files, 31%");
    // The whole status is in the title, for a line that was cut short.
    expect(syncTitle()).toBe("Syncing your company's files. Pulling files down. 128 of 412 files (31%)");
    expect(el.textContent).not.toMatch(/Nova|know more|chat now/);
    expectNoStrip();
    // The grey line it replaced long ago is still gone.
    expect(host.querySelector('[data-testid="agent-dm-catching-up"]')).toBeNull();
    expect(threadText()).not.toContain("is still downloading your company's files");
    // The message box is not locked: the person can chat while the files arrive.
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  });

  it("shows the title alone, with no number, when the server sends no counts", async () => {
    const w = world({ status: () => statusOf({ status: "running" }) });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncStatus()!.dataset.state).toBe("syncing");
    expect(syncText()).toBe("Syncing your company's files");
    expect(syncStatus()!.textContent).not.toMatch(/\d/);
    expect(syncTitle()).toBe("Syncing your company's files. Preparing.");
    expectNoStrip();
  });

  it("is in the header, to the right of 'Direct message' and before the header's right side, and takes no room above the thread", async () => {
    // The bot answered a question with suggestions; the cards sit under the hello, above.
    const w = world({
      thread: [
        { eventId: "e4", fromPersonUid: NOVA, fromDisplayName: "Nova", body: `Quite a lot already.${SUGGESTIONS}`, createdAt: "2026-10-02T14:01:30.000Z" },
        { eventId: "e3", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "What do you know about us?", createdAt: "2026-10-02T14:01:00.000Z" },
        ...thread(NOVA),
      ],
    });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    await vi.waitFor(() => expect(chipRow()).not.toBeNull());
    const el = syncStatus()!;
    // In the conversation header, in the title block, not in the thread.
    expect(header().contains(el)).toBe(true);
    expect(el.closest(".channel-title-block")).not.toBeNull();
    expect(threadEl()!.contains(el)).toBe(false);
    // After the bot's name and the "Direct message" label, in that order.
    const name = header().querySelector<HTMLElement>('[data-testid="channel-name"]')!;
    const label = header().querySelector<HTMLElement>('[data-testid="channel-sub"]')!;
    expect(name.textContent).toBe("Nova");
    expect(label.textContent).toBe("Direct message");
    expect(before(name, label)).toBe(true);
    expect(before(label, el)).toBe(true);
    // The title and its label are one item of the title block; the status is
    // the next one, so it is the one that gives way in a narrow window.
    const block = el.parentElement!;
    expect(block.classList.contains("channel-title-block")).toBe(true);
    expect(Array.from(block.children).map((child) => child.className.split(" ")[0])).toEqual(["channel-title", "bot-sync-status"]);
    expect(block.querySelector(".channel-title")!.contains(label)).toBe(true);
    // Before the header's right side (Edit profile and the rest), which is not inside the title block.
    const trailing = header().querySelector<HTMLElement>(".channel-header-trailing")!;
    expect(before(el, trailing)).toBe(true);
    expect(block.contains(trailing)).toBe(false);
    // One glyph, then the words.
    expect(Array.from(el.children).map((child) => child.getAttribute("data-testid"))).toEqual(["bot-sync-status-icon", "bot-sync-status-text"]);
    expect(el.querySelector('[data-testid="bot-sync-status-icon"] svg')).not.toBeNull();
    // Nothing sits between the header and the thread any more.
    expectNoStrip();
    expect(host.querySelector('[data-testid="conversation-pinned"]')).toBeNull();
    // The chips are part of the bot's newest message, in the thread, above the message box.
    expect(threadEl()!.contains(chipRow()!)).toBe(true);
    expect(chipRow()!.closest('[data-testid="conversation-message"]')?.getAttribute("data-event-id")).toBe("e4");
    expect(before(chipRow()!, host.querySelector("textarea")!)).toBe(true);
    expect(chipRow()!.textContent).toContain("Summarize our company files");
  });

  it("the live run: a finished-looking snapshot forty minutes old is stale, with no percent", async () => {
    // What the walkthrough bot's status said: every file counted, no syncOkAt,
    // the box heartbeating but its last sync run not ok. The first strip read
    // the frozen counts as 99%.
    const w = world({
      status: () =>
        statusOf({
          firstSyncStartedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
          firstSync: {
            phase: "pull",
            filesTotal: 412,
            filesDone: 412,
            startedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
            updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
          },
          lastHeartbeat: heartbeat(20_000, "degraded"),
        }),
    });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncStatus()!.dataset.state).toBe("stale");
    expect(syncText()).toBe("Still syncing.");
    expect(syncStatus()!.textContent).not.toMatch(/\d/);
    expect(syncTitle()).toBe("Still syncing.");
  });

  it("the live run (Big Nuts, 2026-10-03): 10 of 10 planned, refreshed every second, not finished, reads the files so far and no percent", async () => {
    // runtime.firstSync = { phase: "pull", filesDone: 10, filesTotal: 10 }, no
    // syncOkAt, no firstSyncFinalized, the computer heartbeating. The personal
    // target was done; the company vault had not been planned yet. The first
    // strip read it as 99%.
    const w = world({ status: () => statusOf(downloading(10, 10)) });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncStatus()!.dataset.state).toBe("syncing");
    // The owner's own example of the header line.
    expect(syncText()).toBe("Syncing your company's files, 10 files so far");
    expect(syncTitle()).toBe("Syncing your company's files. Preparing. 10 files so far");
    expect(syncStatus()!.textContent).not.toMatch(/\d+%|99/);
    expect(syncTitle()).not.toMatch(/\d+%|99/);
  });

  it("shows for a bot that was not made here once its computer reports a download", async () => {
    const w = world();
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncText()).toBe("Syncing your company's files, 31%");
  });

  it("shows nothing for a bot whose files are already there", async () => {
    const w = world({ status: () => statusOf(SYNCED, { phase: "ready" }) });
    await mountNewBotDm(w);
    expect(syncStatus()).toBeNull();
    expect(header().textContent).not.toContain("Files are up to date.");
    expect(threadText()).not.toContain("Files are up to date.");
    // The header is as it is for any direct message: the name and the label.
    expect(header().querySelector('[data-testid="channel-sub"]')?.textContent).toBe("Direct message");
  });

  it("shows no status and no error when the bot's status cannot be read", async () => {
    const w = world({ status: () => null });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await vi.waitFor(() => expect(w.getStatus).toHaveBeenCalled());
    await settle(20);
    expect(syncStatus()).toBeNull();
    expect(host.textContent).not.toContain("Only owners and admins");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("is not shown in a conversation with a person, and asks for no status", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({
      thread: [
        { eventId: "p2", fromPersonUid: "prs_nova", fromDisplayName: "Nova", body: "Hello Corey", createdAt: "2026-10-02T13:54:20.000Z" },
        { eventId: "p1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Hello there", createdAt: "2026-10-02T13:53:50.000Z" },
      ],
    });
    await mountRow(w, DM_ROW("prs_nova"), "Hello Corey");
    await settle(20);
    expect(syncStatus()).toBeNull();
    expect(header().querySelector('[data-testid="channel-sub"]')?.textContent).toBe("Direct message");
    expect(w.getStatus).not.toHaveBeenCalled();
  });

  it("is not shown in a channel, even one the downloading bot is in", async () => {
    window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
    const w = world({
      channel: [
        { eventId: "c2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Hello team", createdAt: "2026-10-02T13:54:20.000Z" },
        { eventId: "c1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Hello there", createdAt: "2026-10-02T13:53:50.000Z" },
      ],
    });
    const row = { id: "ch:chn_team", kind: "channel", title: "team", channelId: "chn_team", channelScope: "channel", companyUid: COMPANY } as ConversationRow;
    await mountRow(w, row, "Hello team");
    await settle(20);
    expect(syncStatus()).toBeNull();
  });

  it("says a failed download in one sentence", async () => {
    const w = world({
      status: () =>
        statusOf({ status: "running" }, { phase: "failed", steps: [{ name: "codex-auth", status: "done" }, { name: "sync", status: "failed" }] }),
    });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncStatus()!.dataset.state).toBe("failed");
    expect(syncText()).toBe("Sync hit a problem.");
    expect(syncStatus()!.textContent).not.toContain("Nova");
    expectNoStrip();
  });
});

describe("DesktopApp sync status over time", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(Date.parse("2026-10-02T15:00:00.000Z"));
  });

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await settle(20);
  }
  /** Let time pass a second at a time until something is true, for at most a little over one slow timer. */
  async function until(what: () => boolean): Promise<void> {
    for (let waited = 0; waited <= BOT_SYNC_POLL_MS + 5_000 && !what(); waited += 1_000) await advance(1_000);
    expect(what()).toBe(true);
  }

  it("follows the download on a slow timer, says up to date when it is done, then goes away", async () => {
    let runtime: Row = downloading(128, 412);
    const w = world({ status: () => statusOf(runtime) });
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    expect(syncText()).toBe("Syncing your company's files, 31%");
    const asked = w.getStatus.mock.calls.length;

    // The next look, about half a minute later, has newer counts.
    runtime = downloading(309, 412);
    await until(() => syncText() === "Syncing your company's files, 75%");
    expect(w.getStatus.mock.calls.length).toBeGreaterThan(asked);

    // The server says the files are there.
    runtime = SYNCED;
    await until(() => syncStatus()?.dataset.state === "done");
    expect(syncText()).toBe("Files are up to date.");
    expect(syncTitle()).toBe("Files are up to date. 412 files synced.");

    // It goes away when the files are up to date, a few seconds on: the same moment the strip did.
    await advance(BOT_SYNC_DONE_VISIBLE_MS - 1_500);
    expect(syncStatus()).not.toBeNull();
    await advance(2_000);
    expect(syncStatus()).toBeNull();
    // The header is the plain one again.
    expect(header().querySelector('[data-testid="channel-sub"]')?.textContent).toBe("Direct message");
    // The bot is no longer a new bot waiting for its files.
    expect(JSON.parse(window.localStorage.getItem(NEW_BOTS_KEY) ?? "[]")).toEqual([]);
  });

  it("shows again when the server reports a later full download", async () => {
    // A bot from before the server wrote first-sync records: synced, with no
    // finalized record. A finalized record would mean finished whatever else
    // the status carried.
    const synced: Row = { syncOkAt: "2026-10-02T14:20:00.000Z" };
    let runtime: Row = synced;
    const w = world({ status: () => statusOf(runtime, { phase: "ready" }) });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await settle(20);
    expect(syncStatus()).toBeNull();

    runtime = { ...synced, ...downloading(40, 400) };
    await until(() => syncStatus() !== null);
    expect(syncStatus()!.dataset.state).toBe("syncing");
    expect(syncText()).toBe("Syncing your company's files, 10%");

    runtime = synced;
    await until(() => syncStatus()?.dataset.state === "done");
    expect(syncText()).toBe("Files are up to date.");
    await advance(BOT_SYNC_DONE_VISIBLE_MS + 2_000);
    expect(syncStatus()).toBeNull();
  });

  it("stops asking once the conversation is closed", async () => {
    const w = world();
    await mountNewBotDm(w);
    await vi.waitFor(() => expect(syncStatus()).not.toBeNull());
    await unmount(component!);
    component = null;
    const asked = w.getStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * BOT_SYNC_POLL_MS);
    expect(w.getStatus.mock.calls.length).toBe(asked);
  });

  it("does not keep asking for a bot whose status this person may not read", async () => {
    const w = world({ status: () => null });
    await mountRow(w, DM_ROW(NOVA), "Hi Corey, I am Nova.");
    await settle(20);
    const asked = w.getStatus.mock.calls.length;
    await advance(5 * BOT_SYNC_POLL_MS);
    // The cards and the hello lookup may ask on their own; the sync timer does not.
    expect(w.getStatus.mock.calls.length).toBe(asked);
    expect(syncStatus()).toBeNull();
  });
});
