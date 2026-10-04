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

  /** Fake time moves the way real time does: the 5 s checks all run. */
  async function pass(msTotal: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(msTotal);
    await settle();
  }
  const fakeTime = (): void => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  };

  it("after the person asks: ends the row 90 s after the bot's last status, logs it, and says the bot stopped responding", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());
    expect(thinkingRow()).not.toBeNull();

    // A status every 20 s keeps it up well past 90 s.
    for (let i = 1; i <= 5; i += 1) {
      await pass(20_000);
      await botStatus(wakes, "Running", Date.now());
      expect(thinkingRow(), `still working at ${i * 20}s`).not.toBeNull();
    }

    // 85 s after the last status: still up.
    await pass(85_000);
    expect(thinkingRow()).not.toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([]);

    // Past 90 s: the next check ends it. The person's message is the newest
    // one in the conversation, so the DM says so.
    await pass(10_000);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("status-silent", "yes")]);
    expect(stoppedNote()?.textContent?.trim()).toBe("Nova stopped responding. Try again.");

    // A fresh status is the newer event: the row comes back, the sentence goes.
    await botStatus(wakes, "Working", Date.now());
    expect(thinkingRow()?.textContent).toContain("Nova: Working");
    expect(stoppedNote()).toBeNull();
  });

  it("ends the row silently when the newest message in the DM is the bot's", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    // Nobody asked anything here: the bot's hello is the newest message, and
    // the bot reports it is working (a job of its own, a late status).
    await botStatus(wakes, "Working", Date.now());
    expect(thinkingRow()).not.toBeNull();

    await pass(95_000);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("status-silent", "yes")]);
    expect(stoppedNote(), "nothing is said under the bot's own message").toBeNull();
  });

  it("says nothing under a completed answer when a late status restarts the row", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("What is the plan?");
    await botStatus(wakes, "Working", Date.now());
    await botAnswers(w, wakes);
    expect(threadText()).toContain("Done.");
    expect(thinkingRow()).toBeNull();

    // A status that reads as newer than the answer (no sentAt, a clock that
    // runs ahead) puts the row back up, pinned to the answer.
    await botStatus(wakes, "Running", Date.now() + 60_000);
    expect(thinkingRow()).not.toBeNull();

    // Nothing follows. The row goes away, and the DM says nothing: the
    // newest message is the bot's answer.
    await pass(95_000);
    expect(thinkingRow()).toBeNull();
    expect(stoppedNote(), "no sentence under the answer").toBeNull();
    await pass(30_000);
    expect(stoppedNote()).toBeNull();
  });

  it("the person writing right after a status is a new ask: the row does not end seconds later", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await botStatus(wakes, "Working", Date.now());
    await pass(85_000);
    expect(thinkingRow()).not.toBeNull();

    // 85 s into the bot's silence the person writes.
    await typeAndSend("Are you there?");
    await pass(30_000);
    expect(thinkingRow(), "the earlier status does not end the row under the new message").not.toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([]);

    // The bot picks it up, then goes quiet: 90 s after that status the DM says so.
    await botStatus(wakes, "Working", Date.now());
    await pass(95_000);
    expect(thinkingRow()).toBeNull();
    expect(stoppedNote()?.textContent?.trim()).toBe("Nova stopped responding. Try again.");
  });

  it("does not end the row on the first check after the Mac slept: the 90 s start over", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());
    await pass(10_000);

    // The clock jumps three minutes with no check in between (sleep). The
    // statuses sent meanwhile were lost: wakes are not redelivered.
    vi.setSystemTime(Date.now() + 180_000);
    await pass(5_000);
    expect(thinkingRow(), "the first check after the gap ends nothing").not.toBeNull();
    expect(stoppedNote()).toBeNull();
    expect(thinkingLog()).toEqual([]);

    // Still nothing 80 s later.
    await pass(80_000);
    expect(thinkingRow()).not.toBeNull();
    expect(stoppedNote()).toBeNull();

    // A full 90 s after the app was listening again with nothing heard: now it ends.
    await pass(15_000);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("status-silent", "yes")]);
    expect(stoppedNote()?.textContent?.trim()).toBe("Nova stopped responding. Try again.");
  });

  it("ends no row while the window is hidden, and starts the 90 s over when it is visible again", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await pass(200_000);
      expect(thinkingRow(), "hidden: nothing ends").not.toBeNull();
      expect(thinkingLog()).toEqual([]);

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await pass(85_000);
      expect(thinkingRow(), "85 s after it became visible").not.toBeNull();
      expect(stoppedNote()).toBeNull();

      await pass(10_000);
      expect(thinkingRow()).toBeNull();
      expect(stoppedNote()?.textContent?.trim()).toBe("Nova stopped responding. Try again.");
    } finally {
      visibility.mockRestore();
    }
  });

  it("starts the 90 s over when the wake connection reconnects, the network returns, or a catch-up runs", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());

    const resumes: Array<() => void> = [
      () => wakes.emit("mesh:connection", { state: "connected" }),
      () => window.dispatchEvent(new Event("online")),
      () => wakes.emit("mesh:catchup", { reason: "connect" }),
    ];
    for (const [i, resume] of resumes.entries()) {
      // Each resume comes 80 s after the status (or the resume) before it.
      await pass(i === 0 ? 80_000 : 65_000);
      resume();
      await settle(20);
      await pass(15_000);
      expect(thinkingRow(), `resume ${i}: 95 s after the one before, 15 s after listening resumed`).not.toBeNull();
      expect(stoppedNote()).toBeNull();
    }
    // A connection that is not connected restarts nothing.
    wakes.emit("mesh:connection", { state: "reconnecting" });
    await pass(80_000);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("status-silent", "yes")]);
  });

  it("drops the stopped-responding sentence when the bot answers after all", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());

    await pass(95_000);
    expect(stoppedNote()).not.toBeNull();

    await botAnswers(w, wakes);
    expect(threadText()).toContain("Done.");
    expect(stoppedNote()).toBeNull();
    expect(thinkingRow()).toBeNull();
  });

  it("drops the stopped-responding sentence when the person writes again", async () => {
    fakeTime();
    const w = world(Date.now());
    const wakes = await mountDm(w);
    await typeAndSend("Are you there?");
    await botStatus(wakes, "Working", Date.now());

    await pass(95_000);
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

describe("DesktopApp: a status after a reply the app has only heard about (B-7)", () => {
  it("pins the row to the announced reply, so that reply arriving on a page does not end it", async () => {
    const w = world(Date.now());
    const wakes = await mountDm(w);

    // A wake announces the bot's reply. The page read it triggers is a step
    // behind and does not carry the reply yet.
    const repliedAt = Date.now() + 5_000;
    wakes.emit("dm:new-message", { fromPersonUid: NOVA, eventId: "e9", createdAt: iso(repliedAt), direction: "in" });
    await settle(20);
    expect(threadText()).not.toContain("Done.");

    // The bot starts on something new after that reply.
    await botStatus(wakes, "Working", repliedAt + 2_000);
    expect(thinkingRow()?.textContent).toContain("Nova: Working");

    // The reply lands on the next page. It is older than the status: the bot
    // is still working, and the row stays.
    w.thread = [{ eventId: "e9", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "Done.", createdAt: iso(repliedAt) }, ...w.thread];
    await pageFetch(wakes);
    expect(threadText()).toContain("Done.");
    expect(thinkingRow(), "the announced reply does not end the row a newer status began").not.toBeNull();
    expect(thinkingLog()).toEqual([]);

    // The answer to the new work ends it.
    w.thread = [{ eventId: "e10", fromPersonUid: NOVA, fromDisplayName: "Nova", body: "And the second thing.", createdAt: iso(repliedAt + 9_000) }, ...w.thread];
    await pageFetch(wakes);
    expect(thinkingRow()).toBeNull();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "yes")]);
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
    await vi.advanceTimersByTimeAsync(105_000);
    await settle();
    expect(thinkingLog()).toEqual([endedLine("newer-message", "no")]);

    // A status created after the reply is a new turn, pinned to that reply.
    await botStatus(wakes, "Working", repliedAt + 2_000);
    await vi.advanceTimersByTimeAsync(95_000);
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
    await vi.advanceTimersByTimeAsync(100_000);
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
