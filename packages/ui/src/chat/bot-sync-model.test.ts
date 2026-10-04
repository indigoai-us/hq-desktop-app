import { describe, expect, it } from "vitest";

import {
  BOT_SYNC_DONE_TITLE,
  BOT_SYNC_DONE_VISIBLE_MS,
  BOT_SYNC_FAILED_TITLE,
  BOT_SYNC_FILES_TITLE,
  BOT_SYNC_HEARTBEAT_FRESH_MS,
  BOT_SYNC_PREPARING,
  BOT_SYNC_REAL_HOLD,
  BOT_SYNC_STALE_MS,
  BOT_SYNC_STALE_TITLE,
  BOT_SYNC_TITLE,
  advanceBotSync,
  botSyncHideDeadline,
  botSyncNeedsClock,
  botSyncView,
  observeBotSync,
  type BotSyncFacts,
} from "./bot-sync-model.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function syncing(over: Partial<BotSyncFacts> = {}): BotSyncFacts {
  return { state: "syncing", startedAt: NOW, endedAt: null, filesDone: null, filesTotal: null, ...over };
}

const stale: BotSyncFacts = { state: "stale", startedAt: NOW - 40 * MINUTE, endedAt: null, filesDone: null, filesTotal: null };

/** A status answer for a bot that can chat. */
function status(runtime: Record<string, unknown> | null, over: Record<string, unknown> = {}): unknown {
  return {
    setupState: {
      phase: "waiting",
      steps: [
        { name: "codex-auth", status: "done" },
        { name: "sync", status: "done" },
      ],
    },
    agent: { uid: "agt_nova", ...(runtime ? { runtime } : {}) },
    ...over,
  };
}

/** A heartbeat `ago` milliseconds old whose last sync run ended as `sync`. */
const heartbeat = (ago: number, sync = "unknown"): Record<string, unknown> => ({ at: iso(NOW - ago), components: { sync } });

describe("botSyncView", () => {
  it("shows nothing without facts", () => {
    expect(botSyncView(null, { botName: "Crassly", now: NOW })).toMatchObject({ visible: false, progress: null });
    expect(botSyncView(undefined, { now: NOW }).visible).toBe(false);
  });

  it("syncing with no numbers from the server: 'Preparing.', no percent, and an empty bar that does not move with time", () => {
    const view = botSyncView(syncing({ startedAt: NOW - 60_000 }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      detail: BOT_SYNC_PREPARING,
      progress: null,
      fill: 0,
      amount: null,
      counts: null,
    });
    expect(view.title).toBe("Syncing your company's files");
    expect(view.detail).toBe("Preparing.");
    expect(view.title).not.toMatch(/\d/);
    expect(view.detail).not.toMatch(/\d/);
    // No guess from elapsed time: an hour later the bar is still empty.
    for (const elapsed of [0, 30_000, 120_000, 8 * MINUTE, 60 * MINUTE, 365 * 86_400_000]) {
      expect(botSyncView(syncing({ startedAt: NOW - elapsed }), { now: NOW })).toMatchObject({ progress: null, fill: 0 });
    }
  });

  it("the copy is the same for any sync and never names the bot or what it will know", () => {
    const views = [
      botSyncView(syncing({ startedAt: NOW - 60_000 }), { botName: "Big Nuts", now: NOW }),
      botSyncView(syncing({ filesDone: 4_867, filesTotal: 68_141, phase: "pull" }), { botName: "Big Nuts", now: NOW }),
      botSyncView(syncing({ filesDone: 10, filesTotal: 10, phase: "pull" }), { botName: "Big Nuts", now: NOW }),
      botSyncView(stale, { botName: "Big Nuts", now: NOW }),
      botSyncView({ state: "done", startedAt: null, endedAt: NOW, filesDone: 10, filesTotal: 10 }, { botName: "Big Nuts", now: NOW }),
      botSyncView({ state: "failed", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null }, { botName: "Big Nuts", now: NOW }),
    ];
    for (const view of views) {
      const words = `${view.title} ${view.detail}`;
      expect(words).not.toContain("Big Nuts");
      expect(words).not.toContain("Your bot");
      expect(words).not.toMatch(/know more|chat now|first/i);
    }
  });

  it("names the scope in the title: the company's files, or just files", () => {
    expect(botSyncView(syncing({ scope: "company" }), { now: NOW }).title).toBe("Syncing your company's files");
    expect(botSyncView(syncing({ scope: null }), { now: NOW }).title).toBe("Syncing your company's files");
    expect(botSyncView(syncing({ scope: "other" }), { now: NOW }).title).toBe(BOT_SYNC_FILES_TITLE);
    expect(BOT_SYNC_FILES_TITLE).toBe("Syncing files");
    expect(botSyncView(syncing({ scope: "other", filesDone: 1, filesTotal: 4, phase: "pull" }), { now: NOW }).title).toBe("Syncing files");
  });

  it("syncing with no start time has no honest number at all", () => {
    const view = botSyncView(syncing({ startedAt: null }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({ visible: true, state: "syncing", progress: null, fill: 0, amount: null });
  });

  it("the live box (2026-10-03): 10 of 68,322 is a nearly empty determinate bar with the counts", () => {
    const view = botSyncView(syncing({ phase: "pull", filesDone: 10, filesTotal: 68_322 }), { now: NOW });
    expect(view).toMatchObject({
      state: "syncing",
      detail: "Pulling files down. 10 of 68,322 files",
      counts: "10 of 68,322 files",
      progress: 0,
      amount: "<1%",
    });
    // The fill is the real fraction, unrounded: a sliver, not zero and not a sweep.
    expect(view.fill).toBeCloseTo((10 / 68_322) * 100, 10);
    expect(view.fill).toBeGreaterThan(0);
    expect(view.fill).toBeLessThan(1);
  });

  it("live file counts: the real percent, and the phase with the counts on the status line", () => {
    const view = botSyncView(syncing({ filesDone: 128, filesTotal: 412, phase: "pull" }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      detail: "Pulling files down. 128 of 412 files",
      progress: 31,
      amount: "31%",
      counts: "128 of 412 files",
    });
    expect(view.fill).toBeCloseTo((128 / 412) * 100, 10);
    expect(botSyncView(syncing({ filesDone: 1, filesTotal: 4, phase: "push" }), { now: NOW }).detail).toBe("Pushing files up. 1 of 4 files");
    // No phase known: the counts alone.
    expect(botSyncView(syncing({ filesDone: 1, filesTotal: 4 }), { now: NOW }).detail).toBe("1 of 4 files");
    // Large counts are grouped.
    expect(botSyncView(syncing({ filesDone: 4_867, filesTotal: 68_141, phase: "pull" }), { now: NOW })).toMatchObject({
      detail: "Pulling files down. 4,867 of 68,141 files",
      progress: 7,
      amount: "7%",
    });
  });

  it("the live run (Big Nuts, 2026-10-03): 10 of 10 planned and not finished is 'Preparing.', not 99%", () => {
    // filesTotal is the sum of the targets planned so far: the personal target
    // planned and finished its 10 files while the company vault was still
    // being listed. The old strip read this as 99%.
    const view = botSyncView(syncing({ filesDone: 10, filesTotal: 10, phase: "pull", startedAt: NOW - 60_000 }), { botName: "Big Nuts", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      detail: "Preparing. 10 files so far",
      progress: null,
      fill: 0,
      amount: null,
      counts: "10 files so far",
    });
    expect(view.detail).not.toMatch(/%|99/);
    expect(view.detail).not.toContain("of");
    // Nothing moves: no clock, and the bar stays empty.
    expect(botSyncNeedsClock(syncing({ filesDone: 10, filesTotal: 10 }), NOW)).toBe(false);
    // Then the company target's plan lands: a real percent and a sliver of fill.
    const planned = botSyncView(syncing({ filesDone: 10, filesTotal: 68_151, phase: "pull" }), { now: NOW });
    expect(planned).toMatchObject({
      detail: "Pulling files down. 10 of 68,151 files",
      progress: 0,
      amount: "<1%",
      counts: "10 of 68,151 files",
    });
    expect(planned.fill).toBeGreaterThan(0);
  });

  it("counts past their total, or a stated 100 percent, are 'Preparing.' too, never a percent", () => {
    const over = botSyncView(syncing({ filesDone: 999, filesTotal: 412, phase: "push" }), { now: NOW });
    expect(over).toMatchObject({ detail: "Preparing. 999 files so far", progress: null, fill: 0, amount: null, counts: "999 files so far" });
    expect(botSyncView(syncing({ percent: 100 }), { now: NOW })).toMatchObject({ detail: BOT_SYNC_PREPARING, progress: null, amount: null, counts: null });
    expect(botSyncView(syncing({ percent: 100, filesDone: 1, filesTotal: 1 }), { now: NOW }).counts).toBe("1 file so far");
    expect(botSyncView(syncing({ bytesDone: 1000, bytesTotal: 1000, filesDone: 10, filesTotal: 10 }), { now: NOW }).progress).toBeNull();
  });

  it("a live percent from counts is always below 100; a stated percent holds at the cap", () => {
    expect(botSyncView(syncing({ filesDone: 411, filesTotal: 412 }), { now: NOW })).toMatchObject({ progress: 99, amount: "99%" });
    expect(botSyncView(syncing({ filesDone: 68_140, filesTotal: 68_141 }), { now: NOW }).progress).toBe(99);
    expect(botSyncView(syncing({ percent: 99.9 }), { now: NOW })).toMatchObject({ progress: BOT_SYNC_REAL_HOLD, fill: BOT_SYNC_REAL_HOLD });
    expect(BOT_SYNC_REAL_HOLD).toBe(99);
  });

  it("a snapshot with nothing planned and nothing done is 'Preparing.' with no count", () => {
    // The console's 'starting' shape (filesTotal 0, filesDone 0). The server
    // has reported, and said nothing countable: the line shimmers.
    const view = botSyncView(syncing({ startedAt: NOW - 60_000, filesDone: 0, filesTotal: 0, phase: "pull" }), { now: NOW });
    expect(view).toMatchObject({ detail: BOT_SYNC_PREPARING, progress: null, fill: 0, amount: null, counts: null });
    expect(botSyncNeedsClock(syncing({ startedAt: NOW - 60_000, filesDone: 0, filesTotal: 0 }), NOW)).toBe(false);
    // The console's 'running, total unknown' shape (filesTotal 0, filesDone above 0): the files so far.
    expect(botSyncView(syncing({ filesDone: 5, filesTotal: 0 }), { now: NOW })).toMatchObject({ detail: "Preparing. 5 files so far", progress: null, amount: null });
  });

  it("prefers a percent the source reports, then bytes, then file counts", () => {
    expect(botSyncView(syncing({ percent: 42.9 }), { now: NOW })).toMatchObject({ progress: 42, fill: 42.9, amount: "42%", counts: null, detail: "" });
    expect(botSyncView(syncing({ bytesDone: 250, bytesTotal: 1000 }), { now: NOW })).toMatchObject({ progress: 25, fill: 25 });
    // Bytes move evenly where file counts jump: with both, the percent is the bytes'.
    expect(botSyncView(syncing({ bytesDone: 250, bytesTotal: 1000, filesDone: 1, filesTotal: 2 }), { now: NOW })).toMatchObject({
      progress: 25,
      amount: "25%",
      counts: "1 of 2 files",
    });
    // A byte total of zero says nothing: the files decide.
    expect(botSyncView(syncing({ bytesDone: 0, bytesTotal: 0, filesDone: 1, filesTotal: 2 }), { now: NOW }).progress).toBe(50);
    // Bytes that have reached their total while files have not: the files still move, so they decide.
    expect(botSyncView(syncing({ bytesDone: 1000, bytesTotal: 1000, filesDone: 1, filesTotal: 2 }), { now: NOW }).progress).toBe(50);
    expect(botSyncView(syncing({ percent: -5 }), { now: NOW })).toMatchObject({ progress: 0, fill: 0, amount: "0%" });
  });

  it("stale: 'Still syncing.', no number, whatever counts the facts carry", () => {
    const view = botSyncView({ ...stale, filesDone: 412, filesTotal: 412, percent: 100 }, { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "stale",
      title: BOT_SYNC_STALE_TITLE,
      detail: "",
      progress: null,
      fill: 0,
      amount: null,
      counts: null,
    });
    expect(BOT_SYNC_STALE_TITLE).toBe("Still syncing.");
    expect(`${view.title} ${view.detail}`).not.toMatch(/\d/);
    // It does not move with time.
    expect(botSyncView(stale, { now: NOW + 3_600_000 })).toMatchObject({ progress: null, fill: 0 });
    expect(botSyncNeedsClock(stale, NOW)).toBe(false);
  });

  it("done shows a full bar for a few seconds, then nothing", () => {
    const done: BotSyncFacts = { state: "done", startedAt: NOW - 400_000, endedAt: NOW, filesDone: 412, filesTotal: 412 };
    expect(botSyncView(done, { botName: "Crassly", now: NOW })).toMatchObject({
      visible: true,
      state: "done",
      title: BOT_SYNC_DONE_TITLE,
      detail: "412 files synced.",
      progress: 100,
      fill: 100,
      amount: null,
    });
    expect(BOT_SYNC_DONE_TITLE).toBe("Files are up to date.");
    expect(botSyncView(done, { now: NOW + BOT_SYNC_DONE_VISIBLE_MS - 1 }).visible).toBe(true);
    expect(botSyncView(done, { now: NOW + BOT_SYNC_DONE_VISIBLE_MS }).visible).toBe(false);
    expect(botSyncView(done, { now: NOW + 3_600_000 }).visible).toBe(false);
    // A clock a moment behind the one that saw it finish still shows it.
    expect(botSyncView(done, { now: NOW - 2_000 }).visible).toBe(true);
    // No count known: no line.
    expect(botSyncView({ ...done, filesTotal: null }, { now: NOW }).detail).toBe("");
    // A sync nobody saw finish shows nothing.
    expect(botSyncView({ ...done, endedAt: null }, { now: NOW }).visible).toBe(false);
  });

  it("failed says so in one sentence, with no percent, and stays", () => {
    const failed: BotSyncFacts = { state: "failed", startedAt: NOW - 400_000, endedAt: NOW, filesDone: 3, filesTotal: 412 };
    const view = botSyncView(failed, { botName: "Crassly", now: NOW + 86_400_000 });
    expect(view).toMatchObject({
      visible: true,
      state: "failed",
      title: BOT_SYNC_FAILED_TITLE,
      detail: "",
      progress: null,
      amount: null,
      counts: null,
    });
    expect(BOT_SYNC_FAILED_TITLE).toBe("Sync hit a problem.");
    expect(`${view.title} ${view.detail}`).not.toMatch(/\d/);
  });

  it("has no long dash in any copy", () => {
    const all = [
      botSyncView(syncing(), { botName: "Crassly", now: NOW }),
      botSyncView(syncing({ filesDone: 1, filesTotal: 2, phase: "pull" }), { botName: "Crassly", now: NOW }),
      botSyncView(syncing({ filesDone: 2, filesTotal: 2, phase: "pull" }), { botName: "Crassly", now: NOW }),
      botSyncView(stale, { now: NOW }),
      botSyncView({ state: "done", startedAt: null, endedAt: NOW, filesDone: 1, filesTotal: 1 }, { now: NOW }),
      botSyncView({ state: "failed", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null }, { now: NOW }),
    ];
    for (const view of all) expect(`${view.title} ${view.detail}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("needs a clock only while time changes what it shows", () => {
    expect(botSyncNeedsClock(null, NOW)).toBe(false);
    // A running sync never ticks: the bar moves only when new counts arrive.
    expect(botSyncNeedsClock(syncing(), NOW)).toBe(false);
    expect(botSyncNeedsClock(syncing({ startedAt: null }), NOW)).toBe(false);
    expect(botSyncNeedsClock(syncing({ filesDone: 1, filesTotal: 2 }), NOW)).toBe(false);
    expect(botSyncNeedsClock(syncing({ filesDone: 2, filesTotal: 2 }), NOW)).toBe(false);
    const done: BotSyncFacts = { state: "done", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null };
    expect(botSyncNeedsClock(done, NOW + 1_000)).toBe(true);
    expect(botSyncNeedsClock(done, NOW + BOT_SYNC_DONE_VISIBLE_MS)).toBe(false);
    expect(botSyncNeedsClock({ ...done, state: "failed" }, NOW)).toBe(false);
  });

  it("names the one moment the strip changes by itself, so the widget sets one timer instead of polling", () => {
    const done: BotSyncFacts = { state: "done", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null };
    expect(botSyncHideDeadline(done, NOW)).toBe(NOW + BOT_SYNC_DONE_VISIBLE_MS);
    expect(botSyncHideDeadline(done, NOW + 1_500)).toBe(NOW + BOT_SYNC_DONE_VISIBLE_MS);
    // A reader whose clock is a moment behind still gets the same deadline.
    expect(botSyncHideDeadline(done, NOW - 500)).toBe(NOW + BOT_SYNC_DONE_VISIBLE_MS);
    // Past it, and for every state time does not change, there is none.
    expect(botSyncHideDeadline(done, NOW + BOT_SYNC_DONE_VISIBLE_MS)).toBeNull();
    expect(botSyncHideDeadline({ ...done, endedAt: null }, NOW)).toBeNull();
    expect(botSyncHideDeadline({ ...done, state: "failed" }, NOW)).toBeNull();
    expect(botSyncHideDeadline(syncing(), NOW)).toBeNull();
    expect(botSyncHideDeadline(null, NOW)).toBeNull();
  });
});

describe("observeBotSync", () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    phase: "pull",
    filesTotal: 412,
    filesDone: 128,
    startedAt: iso(NOW - 120_000),
    updatedAt: iso(NOW - 20_000),
    ...over,
  });
  const LIVE_SYNCING = {
    state: "syncing",
    startedAt: NOW - 120_000,
    phase: "pull",
    filesDone: 128,
    filesTotal: 412,
    bytesDone: null,
    bytesTotal: null,
  };

  it("reads a live snapshot: fresh runtime.firstSync on a computer that is heartbeating", () => {
    const answer = status({ firstSync: snapshot(), firstSyncStartedAt: iso(NOW - 125_000), lastHeartbeat: heartbeat(30_000) });
    expect(observeBotSync(answer, NOW)).toEqual(LIVE_SYNCING);
    const bytes = status({ firstSync: snapshot({ bytesTotal: 1000, bytesDone: 10, phase: "push" }), lastHeartbeat: heartbeat(30_000) });
    expect(observeBotSync(bytes, NOW)).toMatchObject({ state: "syncing", phase: "push", bytesDone: 10, bytesTotal: 1000 });
    // A heartbeat stamped a moment ahead of this clock is fresh.
    expect(observeBotSync(status({ firstSync: snapshot(), lastHeartbeat: heartbeat(-5_000) }), NOW).state).toBe("syncing");
    // An unknown phase word is no phase.
    expect(observeBotSync(status({ firstSync: snapshot({ phase: "sideways" }), lastHeartbeat: heartbeat(0) }), NOW)).toMatchObject({ phase: null });
  });

  it("the live run (Big Nuts, 2026-10-03 20:48Z): 10 of 10, refreshed every second, not finished, is 'Preparing.'", () => {
    // What the server said: runtime.firstSync = { phase: "pull", filesDone: 10,
    // filesTotal: 10, startedAt: 20:48:38Z, updatedAt advancing every second },
    // no syncOkAt, no firstSyncFinalized, the computer heartbeating. The old
    // strip read it as 99%.
    const now = Date.parse("2026-10-03T20:49:40.000Z");
    const answer = status({
      status: "running",
      firstSyncStartedAt: "2026-10-03T20:48:38.000Z",
      firstSync: { phase: "pull", filesDone: 10, filesTotal: 10, startedAt: "2026-10-03T20:48:38.000Z", updatedAt: "2026-10-03T20:49:39.000Z" },
      lastHeartbeat: { at: "2026-10-03T20:49:30.000Z", components: { sync: "unknown" } },
    });
    const seen = observeBotSync(answer, now);
    expect(seen).toEqual({
      state: "syncing",
      startedAt: Date.parse("2026-10-03T20:48:38.000Z"),
      phase: "pull",
      filesDone: 10,
      filesTotal: 10,
      bytesDone: null,
      bytesTotal: null,
    });
    const facts = advanceBotSync(null, seen, now);
    const view = botSyncView(facts, { botName: "Big Nuts", now });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: "Syncing your company's files",
      detail: "Preparing. 10 files so far",
      progress: null,
      fill: 0,
      amount: null,
      counts: "10 files so far",
    });
    expect(`${view.title} ${view.detail}`).not.toMatch(/\d+%|99|Big Nuts|know more|chat now/);
    // A minute later the company target has been planned: the real percent, climbing.
    const planned = status({
      status: "running",
      firstSyncStartedAt: "2026-10-03T20:48:38.000Z",
      firstSync: { phase: "pull", filesDone: 4_867, filesTotal: 68_141, startedAt: "2026-10-03T20:48:38.000Z", updatedAt: "2026-10-03T20:50:39.000Z" },
      lastHeartbeat: { at: "2026-10-03T20:50:30.000Z", components: { sync: "unknown" } },
    });
    const later = advanceBotSync(facts, observeBotSync(planned, now + 60_000), now + 60_000);
    expect(botSyncView(later, { botName: "Big Nuts", now: now + 60_000 })).toMatchObject({
      detail: "Pulling files down. 4,867 of 68,141 files",
      progress: 7,
      amount: "7%",
      counts: "4,867 of 68,141 files",
    });
  });

  it("the live run from the walkthrough: a finished-looking snapshot 40 minutes old is stale, with no percent", () => {
    const answer = status({
      firstSyncStartedAt: iso(NOW - 50 * MINUTE),
      firstSync: snapshot({ filesDone: 412, filesTotal: 412, updatedAt: iso(NOW - 40 * MINUTE) }),
      lastHeartbeat: heartbeat(30_000, "degraded"),
    });
    const seen = observeBotSync(answer, NOW);
    expect(seen).toEqual({ state: "stale", startedAt: NOW - 120_000 });
    const facts = advanceBotSync(null, seen, NOW);
    const view = botSyncView(facts, { botName: "Nova", now: NOW });
    expect(view).toMatchObject({ visible: true, state: "stale", title: BOT_SYNC_STALE_TITLE, progress: null, amount: null, counts: null });
    expect(`${view.title} ${view.detail}`).not.toContain("99");
    // The same with "unknown" as the last run, and with no heartbeat at all.
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }), lastHeartbeat: heartbeat(0, "unknown") }), NOW).state).toBe("stale");
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }) }), NOW).state).toBe("stale");
  });

  it("a fresh snapshot on a computer that stopped heartbeating is stale too", () => {
    const quiet = status({ firstSync: snapshot(), lastHeartbeat: heartbeat(BOT_SYNC_HEARTBEAT_FRESH_MS) });
    expect(observeBotSync(quiet, NOW)).toEqual({ state: "stale", startedAt: NOW - 120_000 });
    expect(observeBotSync(status({ firstSync: snapshot() }), NOW).state).toBe("stale");
    // Right at the edges: a snapshot ten minutes old is still live, a moment older is not.
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: iso(NOW - BOT_SYNC_STALE_MS) }), lastHeartbeat: heartbeat(0) }), NOW).state).toBe("syncing");
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: iso(NOW - BOT_SYNC_STALE_MS - 1) }), lastHeartbeat: heartbeat(0) }), NOW).state).toBe("stale");
    // A snapshot with no update time cannot be live.
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: undefined }), lastHeartbeat: heartbeat(0) }), NOW).state).toBe("stale");
  });

  it("a first download with no snapshot yet counts only for a bot made here, or once it has started", () => {
    expect(observeBotSync(status({ status: "running" }), NOW)).toEqual({ state: "none" });
    expect(observeBotSync(status({ status: "running" }), NOW, { expectFirstSync: true })).toEqual({
      state: "syncing",
      startedAt: null,
      phase: null,
      filesDone: null,
      filesTotal: null,
      bytesDone: null,
      bytesTotal: null,
    });
    expect(observeBotSync(status({ firstSyncStartedAt: iso(NOW - 5_000) }), NOW)).toMatchObject({
      state: "syncing",
      startedAt: NOW - 5_000,
      phase: null,
    });
  });

  it("says nothing before the bot can chat, or when the answer has no runtime", () => {
    const waking = status(
      { firstSync: snapshot(), lastHeartbeat: heartbeat(0) },
      { setupState: { phase: "provisioning", steps: [{ name: "sync", status: "running" }] } },
    );
    expect(observeBotSync(waking, NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    expect(observeBotSync(status(null), NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    expect(observeBotSync({ setupState: { phase: "ready" } }, NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    for (const junk of [null, undefined, "x", 3, [], {}]) expect(observeBotSync(junk, NOW)).toEqual({ state: "none" });
  });

  it("is finished once the first download is finalized, whatever snapshot is left", () => {
    const finalized = { totalObjects: 412, startedAt: iso(NOW - 9), finishedAt: iso(NOW) };
    expect(observeBotSync(status({ syncOkAt: iso(NOW), firstSyncFinalized: finalized }), NOW)).toEqual({ state: "done", filesTotal: 412 });
    expect(observeBotSync(status({ firstSyncFinalized: finalized, firstSync: snapshot(), lastHeartbeat: heartbeat(0) }), NOW)).toEqual({
      state: "done",
      filesTotal: 412,
    });
    expect(observeBotSync(status({ firstSyncFinalized: {} }), NOW)).toEqual({ state: "done", filesTotal: null });
  });

  it("is finished when a sync has finished well and no snapshot is left", () => {
    expect(observeBotSync(status({ syncOkAt: iso(NOW) }), NOW)).toEqual({ state: "done", filesTotal: null });
    expect(observeBotSync(status({ syncOkAt: iso(NOW - 86_400_000), lastHeartbeat: heartbeat(3 * 86_400_000, "failed") }), NOW).state).toBe("done");
  });

  it("is finished when a fresh heartbeat says the last sync run was ok, even with a snapshot left", () => {
    expect(observeBotSync(status({ firstSync: snapshot(), lastHeartbeat: heartbeat(60_000, "ok") }), NOW)).toEqual({ state: "done", filesTotal: null });
    expect(observeBotSync(status({ firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }), lastHeartbeat: heartbeat(60_000, "OK") }), NOW).state).toBe("done");
    // An old "ok" says nothing about now.
    expect(observeBotSync(status({ firstSync: snapshot(), lastHeartbeat: heartbeat(BOT_SYNC_HEARTBEAT_FRESH_MS, "ok") }), NOW).state).toBe("stale");
  });

  it("a later full download shows while the bot's computer reports fresh progress", () => {
    const later = status({ syncOkAt: iso(NOW - 86_400_000), firstSync: snapshot(), lastHeartbeat: heartbeat(30_000, "degraded") });
    expect(observeBotSync(later, NOW)).toMatchObject({ state: "syncing", filesDone: 128, filesTotal: 412 });
    // Progress nobody has refreshed is not a sync that is running now.
    const old = status({ syncOkAt: iso(NOW - 86_400_000), firstSync: snapshot({ updatedAt: iso(NOW - BOT_SYNC_STALE_MS - 1) }), lastHeartbeat: heartbeat(30_000, "degraded") });
    expect(observeBotSync(old, NOW)).toEqual({ state: "stale", startedAt: NOW - 120_000 });
  });

  it("a failed sync step is a failed first download; another setup failure is not", () => {
    const stepFailed = status({}, { setupState: { phase: "failed", steps: [{ name: "codex-auth", status: "done" }, { name: "sync", status: "failed" }] } });
    expect(observeBotSync(stepFailed, NOW)).toEqual({ state: "failed", first: true });
    const otherFailed = status({}, { setupState: { phase: "failed", steps: [{ name: "codex-auth", status: "failed" }] } });
    expect(observeBotSync(otherFailed, NOW)).toEqual({ state: "failed", first: false });
  });

  it("a fresh heartbeat whose last sync run failed is a failure; an old one, or a degraded run, is not", () => {
    const laterFailed = status({ syncOkAt: iso(NOW - 86_400_000), firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }), lastHeartbeat: heartbeat(0, "failed") });
    expect(observeBotSync(laterFailed, NOW)).toEqual({ state: "failed", first: false });
    // The first download, no snapshot: the bot has never synced, so it always shows.
    expect(observeBotSync(status({ firstSyncStartedAt: iso(NOW - 5 * MINUTE), lastHeartbeat: heartbeat(0, "failed") }), NOW)).toEqual({ state: "failed", first: true });
    // Stale snapshot, old failed heartbeat: stale, not failed.
    const oldFailure = status({ firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }), lastHeartbeat: heartbeat(BOT_SYNC_HEARTBEAT_FRESH_MS, "failed") });
    expect(observeBotSync(oldFailure, NOW).state).toBe("stale");
    // A live snapshot wins over a failed last run: the sync is running again.
    expect(observeBotSync(status({ firstSync: snapshot(), lastHeartbeat: heartbeat(0, "failed") }), NOW).state).toBe("syncing");
    const degraded = status({ firstSync: snapshot({ updatedAt: iso(NOW - 40 * MINUTE) }), lastHeartbeat: heartbeat(0, "degraded") });
    expect(observeBotSync(degraded, NOW).state).toBe("stale");
  });
});

describe("advanceBotSync", () => {
  const seen = {
    state: "syncing" as const,
    startedAt: NOW - 60_000,
    phase: "pull" as const,
    filesDone: 10,
    filesTotal: 40,
    bytesDone: null,
    bytesTotal: null,
  };
  const gone = { state: "stale" as const, startedAt: NOW - 60_000 };

  it("starts showing a sync, and keeps the same object while nothing changes", () => {
    const first = advanceBotSync(null, seen, NOW);
    expect(first).toEqual({
      state: "syncing",
      startedAt: NOW - 60_000,
      endedAt: null,
      filesDone: 10,
      filesTotal: 40,
      bytesDone: null,
      bytesTotal: null,
      phase: "pull",
    });
    expect(advanceBotSync(first, seen, NOW + 30_000)).toBe(first);
    expect(advanceBotSync(first, { ...seen, filesDone: 20 }, NOW + 30_000)).toMatchObject({ filesDone: 20 });
    expect(advanceBotSync(first, { ...seen, phase: "push" }, NOW + 30_000)).toMatchObject({ phase: "push" });
  });

  it("times an unreported start from when the app first saw the sync, and keeps it", () => {
    const blind = { ...seen, startedAt: null, phase: null, filesDone: null, filesTotal: null };
    const first = advanceBotSync(null, blind, NOW);
    expect(first?.startedAt).toBe(NOW);
    expect(advanceBotSync(first, blind, NOW + 30_000)).toBe(first);
  });

  it("stale shows with no counts, and keeps the same object while nothing changes", () => {
    const running = advanceBotSync(null, seen, NOW);
    const idle = advanceBotSync(running, gone, NOW + 20 * MINUTE);
    expect(idle).toEqual({ state: "stale", startedAt: NOW - 60_000, endedAt: null, filesDone: null, filesTotal: null });
    expect(advanceBotSync(idle, gone, NOW + 21 * MINUTE)).toBe(idle);
    expect(botSyncView(idle, { now: NOW + 21 * MINUTE })).toMatchObject({ state: "stale", progress: null, amount: null });
    // Seen stale first, with no start time of its own.
    expect(advanceBotSync(null, { state: "stale", startedAt: null }, NOW)).toMatchObject({ state: "stale", startedAt: null });
    // It comes back to life with fresh counts, and keeps the start it had.
    const again = advanceBotSync(idle, { ...seen, startedAt: null, filesDone: 30 }, NOW + 22 * MINUTE);
    expect(again).toMatchObject({ state: "syncing", startedAt: NOW - 60_000, filesDone: 30 });
  });

  it("done after a sync this app saw: up to date, then hidden after the delay", () => {
    const running = advanceBotSync(null, seen, NOW);
    const done = advanceBotSync(running, { state: "done", filesTotal: 40 }, NOW + 90_000);
    expect(done).toMatchObject({ state: "done", endedAt: NOW + 90_000, filesTotal: 40 });
    expect(botSyncView(done, { now: NOW + 90_000 })).toMatchObject({ visible: true, title: BOT_SYNC_DONE_TITLE, progress: 100 });
    expect(botSyncView(done, { now: NOW + 90_000 + BOT_SYNC_DONE_VISIBLE_MS }).visible).toBe(false);
    // The next answer says done again: nothing comes back.
    expect(advanceBotSync(done, { state: "done", filesTotal: 40 }, NOW + 120_000)).toBe(done);
    // A stale strip finishing shows up to date too.
    const idle = advanceBotSync(null, gone, NOW);
    expect(advanceBotSync(idle, { state: "done", filesTotal: 40 }, NOW + 1)).toMatchObject({ state: "done", endedAt: NOW + 1, filesTotal: 40 });
  });

  it("a bot that was already in sync shows nothing", () => {
    expect(advanceBotSync(null, { state: "done", filesTotal: 40 }, NOW)).toBeNull();
    expect(advanceBotSync(null, { state: "none" }, NOW)).toBeNull();
  });

  it("failed stays until the next change", () => {
    const running = advanceBotSync(null, seen, NOW);
    const failed = advanceBotSync(running, { state: "failed", first: false }, NOW + 1_000);
    expect(failed).toMatchObject({ state: "failed", endedAt: NOW + 1_000 });
    expect(advanceBotSync(failed, { state: "failed", first: false }, NOW + 60_000)).toBe(failed);
    expect(advanceBotSync(failed, { state: "none" }, NOW + 60_000)).toBe(failed);
    expect(botSyncView(failed, { now: NOW + 86_400_000 }).visible).toBe(true);
    // It runs again, then finishes.
    const again = advanceBotSync(failed, seen, NOW + 120_000);
    expect(again?.state).toBe("syncing");
    expect(advanceBotSync(failed, { state: "done", filesTotal: null }, NOW + 120_000)).toMatchObject({ state: "done", endedAt: NOW + 120_000 });
  });

  it("a first download's failure always shows; a later run's only when it was seen running", () => {
    expect(advanceBotSync(null, { state: "failed", first: true }, NOW)).toMatchObject({ state: "failed" });
    expect(advanceBotSync(null, { state: "failed", first: false }, NOW)).toBeNull();
    const done: BotSyncFacts = { state: "done", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null };
    expect(advanceBotSync(done, { state: "failed", first: false }, NOW)).toBe(done);
    // A stale strip counts as seen running.
    const idle = advanceBotSync(null, gone, NOW);
    expect(advanceBotSync(idle, { state: "failed", first: false }, NOW + 1)).toMatchObject({ state: "failed" });
  });

  it("a sync that stops being reported stops showing", () => {
    const running = advanceBotSync(null, seen, NOW);
    expect(advanceBotSync(running, { state: "none" }, NOW + 1)).toBeNull();
    const idle = advanceBotSync(null, gone, NOW);
    expect(advanceBotSync(idle, { state: "none" }, NOW + 1)).toBeNull();
  });
});
