// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/**
 * A cloud bot's "is thinking" row in its DM follows the bot's own status.
 *
 * The bot posts a short status at the start of a turn and at most every 20 s
 * while it works ("Working", "Searching the web", "Using Linear"). The server
 * relays each one to the person as an ephemeral `agent_status` wake with no
 * `channelId`: `{ type, agentUid, withPersonUid, status, ts, sentAt?,
 * rootEventId? }`. Hosts put it on the bus as `agent:dm-status`.
 */

const NOVA = "agt_nova";
const ME = "prs_me";

type Row = Record<string, unknown>;

const iso = (ms: number): string => new Date(ms).toISOString();

interface World {
  /** Newest first, as the server returns a direct-message page. */
  thread: Row[];
  channel: Row[];
  /** When the bot's one earlier message landed. */
  helloAt: number;
  sendDm: ReturnType<typeof vi.fn>;
}

function world(now: number): World {
  const helloAt = now - 100_000;
  return {
    helloAt,
    thread: [
      { eventId: "e2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: iso(helloAt) },
      { eventId: "e1", fromPersonUid: ME, fromDisplayName: "Corey", body: "Hello Nova", createdAt: iso(now - 130_000) },
    ],
    channel: [
      { eventId: "c1", fromPersonUid: ME, fromDisplayName: "Corey", body: "Morning all", createdAt: iso(now - 130_000) },
    ],
    sendDm: vi.fn(async () => ok({ eventId: `sent_${Math.random().toString(36).slice(2)}` })),
  };
}

function adapter(w: World): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [{ personUid: NOVA, displayName: "Nova" }] }),
      fetchChannel: async () => ok({ messages: w.channel, nextCursor: null }),
      fetchDmThread: async () => ok({ messages: w.thread }),
      sendDm: w.sendDm,
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
const CHANNEL_ROW: ConversationRow = { id: "ch:chn_test", kind: "channel", title: "general", channelId: "chn_test" } as ConversationRow;

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const thinkingRow = (): Element | null => host.querySelector('[data-testid="agent-thinking-row"]');
const thinkingRows = (): Element[] => [...host.querySelectorAll('[data-testid="agent-thinking-row"] .thinking-row')];
const stoppedNote = (): Element | null => host.querySelector('[data-testid="bot-stopped-responding"]');
const thinkingLog = (): string[] =>
  hqLog.mock.calls.filter(([tag]) => tag === "bot-thinking").map(([, line]) => String(line));

async function mountApp(w: World, row: ConversationRow, shows: string, wakes = createChatWakeBus()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(w),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: ME, displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: row,
      wakes,
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(shows));
  await settle();
  return wakes;
}

const mountDm = (w: World) => mountApp(w, DM_ROW, "Hi Corey, I am Nova.");

type Wakes = ReturnType<typeof createChatWakeBus>;

/** The bot reports a status in its DM with `withPersonUid`. */
async function botStatus(
  wakes: Wakes,
  status: string,
  ts: number,
  extra: { withPersonUid?: string; sentAt?: string; rootEventId?: string } = {},
): Promise<void> {
  const { withPersonUid = ME, ...rest } = extra;
  wakes.emit("agent:dm-status", { agentUid: NOVA, withPersonUid, status, ts: iso(ts), ...rest });
  await settle();
}

/** A page fetch for the open conversation. */
async function pageFetch(wakes: Wakes): Promise<void> {
  wakes.emit("mesh:catchup", {} as { reason: "connect" | "focus" });
  await settle(20);
}

/** The bot answers, and the next page fetch carries it. */
async function botAnswers(w: World, wakes: Wakes): Promise<void> {
  w.thread = [
    { eventId: `e9_${w.thread.length}`, fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Done.", createdAt: iso(Date.now() + 1_000) },
    ...w.thread,
  ];
  await pageFetch(wakes);
}

async function typeAndSend(text: string): Promise<void> {
  const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
  expect(composer, "live composer renders for the bot DM").toBeTruthy();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(20);
}

const endedLine = (reason: string, pinned: "yes" | "no") =>
  expect.stringMatching(new RegExp(`^ended agent=${NOVA} row=dm:${NOVA} reason=${reason} elapsedMs=\\d+ pinned=${pinned}$`));

describe("DesktopApp: a bot's status in its DM", () => {
  it("starts a row when there is none, with the bot's words, and the bot's answer ends it", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);
    expect(thinkingRow()).toBeNull();

    await botStatus(wakes, "Searching the web", Date.now());
    expect(thinkingRow()?.textContent).toContain("Nova: Searching the web");
    expect(thinkingRow()?.closest('[data-testid="conversation-thread"]'), "the row draws in the DM's main pane").not.toBeNull();

    // Pinned to the bot's newest message: seeing that message again on a page
    // fetch (100 s old, inside the two-minute skew window) does not end it.
    await pageFetch(wakes);
    expect(thinkingRow(), "the bot's earlier message does not end the row").not.toBeNull();
    expect(thinkingLog()).toEqual([]);

    await botAnswers(w, wakes);
    expect(thinkingRow(), "the answer ends the row").toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "yes")]);
  });

  it("refreshes a row that is already up without dropping its pin", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    expect(thinkingRow()?.textContent).toContain("Nova is thinking");

    await botStatus(wakes, "Working", Date.now());
    expect(thinkingRows()).toHaveLength(1);
    expect(thinkingRow()?.textContent).toContain("Nova: Working");
    await botStatus(wakes, "Using Linear", Date.now() + 1);
    expect(thinkingRows()).toHaveLength(1);
    expect(thinkingRow()?.textContent).toContain("Nova: Using Linear");

    await pageFetch(wakes);
    expect(thinkingRow(), "the refresh kept the pin").not.toBeNull();
    expect(thinkingLog()).toEqual([]);

    await botAnswers(w, wakes);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "yes")]);
  });

  it("ignores a status addressed to another person", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await botStatus(wakes, "Working", Date.now(), { withPersonUid: "prs_someone_else" });
    expect(thinkingRow()).toBeNull();

    // And it does not touch a row that is up for this person.
    await botStatus(wakes, "Searching the web", Date.now());
    await botStatus(wakes, "Using Linear", Date.now() + 1, { withPersonUid: "prs_someone_else" });
    expect(thinkingRow()?.textContent).toContain("Nova: Searching the web");
  });

  it("ignores a status no newer than the bot's newest message in the DM", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);

    // Older than the bot's last message, and exactly as old: both late.
    await botStatus(wakes, "Working", w.helloAt - 1_000);
    expect(thinkingRow()).toBeNull();
    await botStatus(wakes, "Working", w.helloAt);
    expect(thinkingRow()).toBeNull();

    // A turn: the status starts the row, the reply ends it, and a status from
    // before the reply that arrives afterwards must not bring it back.
    const statusAt = Date.now();
    await botStatus(wakes, "Working", statusAt);
    expect(thinkingRow()).not.toBeNull();
    await botAnswers(w, wakes);
    expect(thinkingRow()).toBeNull();
    await botStatus(wakes, "Running", statusAt + 500);
    expect(thinkingRow(), "a status older than the reply does not start a row").toBeNull();
    expect(stoppedNote()).toBeNull();
  });

  it("judges a late status by sentAt when the wake carries one", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);

    // Published after the bot's last message, created before it (and at the
    // same instant): late.
    await botStatus(wakes, "Working", Date.now(), { sentAt: iso(w.helloAt - 2_000) });
    expect(thinkingRow()).toBeNull();
    await botStatus(wakes, "Working", Date.now(), { sentAt: iso(w.helloAt) });
    expect(thinkingRow()).toBeNull();

    // Created after it: the bot is working.
    await botStatus(wakes, "Working", Date.now(), { sentAt: iso(w.helloAt + 1) });
    expect(thinkingRow()?.textContent).toContain("Nova: Working");
  });

  it("keeps one row for the DM when the statuses name different threads", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);

    await botStatus(wakes, "Searching the web", Date.now(), { rootEventId: "evt_thread_a" });
    await botStatus(wakes, "Using Linear", Date.now() + 1, { rootEventId: "evt_thread_b" });
    expect(thinkingRows(), "one row per DM, not one per thread").toHaveLength(1);
    expect(thinkingRow()?.textContent).toContain("Nova: Using Linear");
    expect(thinkingRow()?.closest('[data-testid="conversation-thread"]'), "a thread root does not move the row").not.toBeNull();

    await botStatus(wakes, "Searching the web", Date.now() + 2, { rootEventId: "evt_thread_a" });
    expect(thinkingRows()).toHaveLength(1);
    expect(thinkingRow()?.textContent).toContain("Nova: Searching the web");

    await botAnswers(w, wakes);
    expect(thinkingRow()).toBeNull();
  });

  it("ends the row after 90 s with no status and no message, logs it, and says the bot stopped responding", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    const wakes = await mountDm(w);
    const start = Date.now();
    await botStatus(wakes, "Working", start);
    expect(thinkingRow()).not.toBeNull();

    // A status every 20 s keeps it up well past 90 s.
    for (const at of [20_000, 40_000, 60_000, 80_000, 100_000]) {
      vi.setSystemTime(start + at);
      await botStatus(wakes, "Running", start + at);
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(thinkingRow(), `still working at ${at / 1000}s`).not.toBeNull();
    }
    const lastStatusAt = Date.now() - 5_000;

    // 85 s after the last status: still up.
    vi.setSystemTime(lastStatusAt + 80_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()).not.toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([]);

    // Past 90 s: the next check ends it.
    vi.setSystemTime(lastStatusAt + 90_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("status-silent", "yes")]);
    expect(stoppedNote()?.textContent?.trim()).toBe("Nova stopped responding. Try again.");

    // A fresh status is the newer event: the row comes back, the sentence goes.
    await botStatus(wakes, "Working", Date.now());
    expect(thinkingRow()?.textContent).toContain("Nova: Working");
    expect(stoppedNote()).toBeNull();
  });

  it("drops the stopped-responding sentence when the bot answers after all", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await botStatus(wakes, "Working", Date.now());

    vi.setSystemTime(Date.now() + 90_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(stoppedNote()).not.toBeNull();

    await botAnswers(w, wakes);
    expect(threadText()).toContain("Done.");
    expect(stoppedNote()).toBeNull();
    expect(thinkingRow()).toBeNull();
  });

  it("drops the stopped-responding sentence when the person writes again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    await mountDm(w).then(async (wakes) => botStatus(wakes, "Working", Date.now()));

    vi.setSystemTime(Date.now() + 90_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(stoppedNote()).not.toBeNull();

    await typeAndSend("Try again please");
    expect(stoppedNote()).toBeNull();
    expect(thinkingRow()?.textContent).toContain("Nova is thinking");
  });

  it("leaves a row that never received a status on the long timers", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    await mountDm(w);
    await typeAndSend("Are you there?");
    const start = Date.now();
    expect(thinkingRow()).not.toBeNull();

    // 90 s of silence does not end it.
    vi.setSystemTime(start + 95_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()).not.toBeNull();
    expect(stoppedNote()).toBeNull();

    // 150 s: "taking longer than usual".
    vi.setSystemTime(start + 155_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()?.textContent).toContain("Nova is taking longer than usual");

    // 600 s: the hard expiry, logged as before, with no sentence.
    vi.setSystemTime(start + 600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()).toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("expired", "yes")]);
  });
});

describe("DesktopApp: a bot's status for a DM that is not open", () => {
  it("is late when the bot's reply was announced by a wake, though the app holds no timeline for that DM", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    const wakes = await mountApp(w, CHANNEL_ROW, "Morning all");
    const start = Date.now();

    // The bot works, then answers; the answer arrives as a wake for a DM that
    // is not on screen and ends the row there.
    await botStatus(wakes, "Working", start);
    const repliedAt = start + 5_000;
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "e9", createdAt: iso(repliedAt), direction: "in" });
    await settle(20);
    expect(thinkingLog()).toEqual([endedLine("newer-message", "no")]);

    // A status from before the reply shows up afterwards: no row, so nothing
    // goes quiet 90 s later.
    await botStatus(wakes, "Running", repliedAt - 1_000);
    await botStatus(wakes, "Running", repliedAt + 1_000, { sentAt: iso(repliedAt) });
    vi.setSystemTime(start + 100_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "no")]);

    // A status created after the reply is a new turn, pinned to that reply.
    await botStatus(wakes, "Working", repliedAt + 2_000);
    vi.setSystemTime(Date.now() + 90_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "no"), endedLine("status-silent", "yes")]);
  });
});

describe("DesktopApp: a channel status is unchanged", () => {
  const channelStatus = async (wakes: Wakes, status: string, ts: number): Promise<void> => {
    wakes.emit("agent:status", { channelId: "chn_test", agentUid: NOVA, status, ts: iso(ts) });
    await settle();
  };

  it("draws in its channel, takes no DM status, and is not ended by 90 s of silence", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const w = world(Date.now());
    const wakes = await mountApp(w, CHANNEL_ROW, "Morning all");
    const start = Date.now();

    // A DM status for this person belongs to the DM, not to the open channel.
    await botStatus(wakes, "Searching the web", start);
    expect(thinkingRow()).toBeNull();

    await channelStatus(wakes, "reading the repo", start);
    expect(thinkingRows()).toHaveLength(1);
    expect(thinkingRow()?.textContent).toContain("reading the repo");

    // Channel rows keep the long timers: 90 s without a status changes nothing.
    vi.setSystemTime(start + 95_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(thinkingRow()?.textContent).toContain("reading the repo");
    expect(stoppedNote()).toBeNull();
    // The DM row (not on screen) did end for silence, and only that one logged.
    expect(thinkingLog()).toEqual([endedLine("status-silent", "no")]);
  });

  it("does not draw in the bot's DM", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await channelStatus(wakes, "reading the repo", Date.now());
    expect(thinkingRow()).toBeNull();
  });
});
