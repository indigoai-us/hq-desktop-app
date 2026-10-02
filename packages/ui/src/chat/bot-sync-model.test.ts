import { describe, expect, it } from "vitest";

import {
  BOT_SYNC_DONE_TITLE,
  BOT_SYNC_DONE_VISIBLE_MS,
  BOT_SYNC_ESTIMATE_HOLD,
  BOT_SYNC_ESTIMATE_MS,
  BOT_SYNC_FAILED_TITLE,
  BOT_SYNC_REAL_HOLD,
  BOT_SYNC_STALE_MS,
  BOT_SYNC_TITLE,
  advanceBotSync,
  botSyncNeedsClock,
  botSyncView,
  estimatedSyncProgress,
  observeBotSync,
  type BotSyncFacts,
} from "./bot-sync-model.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function syncing(over: Partial<BotSyncFacts> = {}): BotSyncFacts {
  return { state: "syncing", startedAt: NOW, endedAt: null, filesDone: null, filesTotal: null, ...over };
}

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

describe("botSyncView", () => {
  it("shows nothing without facts", () => {
    expect(botSyncView(null, { botName: "Crassly", now: NOW })).toMatchObject({ visible: false, progress: null });
    expect(botSyncView(undefined, { now: NOW }).visible).toBe(false);
  });

  it("syncing with no numbers from the server: an estimate, and no percent in words", () => {
    const view = botSyncView(syncing({ startedAt: NOW - 60_000 }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      detail: "You can chat now. Crassly will know more as this finishes.",
      estimated: true,
      amount: null,
      counts: null,
    });
    expect(view.title).toBe("Syncing your company's files");
    expect(view.title).not.toMatch(/\d/);
    expect(view.detail).not.toMatch(/\d/);
    expect(view.progress).toBeGreaterThan(0);
    expect(view.progress).toBeLessThan(BOT_SYNC_ESTIMATE_HOLD);
  });

  it("the estimate moves forward with time and never reaches 100", () => {
    let last = -1;
    for (const elapsed of [0, 30_000, 120_000, BOT_SYNC_ESTIMATE_MS, 2 * BOT_SYNC_ESTIMATE_MS, 60 * BOT_SYNC_ESTIMATE_MS, 365 * 86_400_000]) {
      const progress = botSyncView(syncing({ startedAt: NOW - elapsed }), { now: NOW }).progress as number;
      expect(progress).toBeGreaterThanOrEqual(last);
      expect(progress).toBeLessThanOrEqual(BOT_SYNC_ESTIMATE_HOLD);
      expect(progress).toBeLessThan(100);
      last = progress;
    }
    expect(last).toBe(BOT_SYNC_ESTIMATE_HOLD);
    // A clock that runs behind the server's never makes it go backwards or negative.
    expect(estimatedSyncProgress(NOW + 60_000, NOW)).toBe(estimatedSyncProgress(NOW, NOW));
    expect(estimatedSyncProgress(NOW, NOW)).toBeGreaterThan(0);
  });

  it("uses the source's own typical duration when it gives one", () => {
    const slow = botSyncView(syncing({ startedAt: NOW - 60_000 }), { now: NOW }).progress as number;
    const fast = botSyncView(syncing({ startedAt: NOW - 60_000, estimateMs: 60_000 }), { now: NOW }).progress as number;
    expect(fast).toBeGreaterThan(slow);
  });

  it("syncing with no start time has no honest number at all", () => {
    const view = botSyncView(syncing({ startedAt: null }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({ visible: true, state: "syncing", progress: null, estimated: false, amount: null });
  });

  it("syncing with real file counts: the real percent, in words too", () => {
    const view = botSyncView(syncing({ filesDone: 128, filesTotal: 412 }), { botName: "Crassly", now: NOW });
    expect(view).toMatchObject({
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      progress: 31,
      estimated: false,
      amount: "31%",
      counts: "128 of 412 files",
    });
  });

  it("real counts hold below 100 until the server says the sync is done", () => {
    const all = botSyncView(syncing({ filesDone: 412, filesTotal: 412 }), { now: NOW });
    expect(all.progress).toBe(BOT_SYNC_REAL_HOLD);
    expect(all.amount).toBe("99%");
    const over = botSyncView(syncing({ filesDone: 999, filesTotal: 412 }), { now: NOW });
    expect(over.progress).toBe(BOT_SYNC_REAL_HOLD);
    expect(over.counts).toBe("412 of 412 files");
    expect(botSyncView(syncing({ percent: 100 }), { now: NOW }).progress).toBe(BOT_SYNC_REAL_HOLD);
  });

  it("a total of zero is not a number: it falls back to the estimate", () => {
    const view = botSyncView(syncing({ startedAt: NOW - 60_000, filesDone: 0, filesTotal: 0 }), { now: NOW });
    expect(view.estimated).toBe(true);
    expect(view.amount).toBeNull();
  });

  it("uses a percent the source reports, then bytes, when there are no file counts", () => {
    expect(botSyncView(syncing({ percent: 42.9 }), { now: NOW })).toMatchObject({ progress: 42, amount: "42%", counts: null });
    expect(botSyncView(syncing({ bytesDone: 250, bytesTotal: 1000 }), { now: NOW })).toMatchObject({ progress: 25, estimated: false });
    expect(botSyncView(syncing({ percent: -5 }), { now: NOW }).progress).toBe(0);
  });

  it("done shows a full bar for a few seconds, then nothing", () => {
    const done: BotSyncFacts = { state: "done", startedAt: NOW - 400_000, endedAt: NOW, filesDone: 412, filesTotal: 412 };
    expect(botSyncView(done, { botName: "Crassly", now: NOW })).toMatchObject({
      visible: true,
      state: "done",
      title: BOT_SYNC_DONE_TITLE,
      detail: "412 files synced.",
      progress: 100,
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

  it("failed says so in one sentence and stays", () => {
    const failed: BotSyncFacts = { state: "failed", startedAt: NOW - 400_000, endedAt: NOW, filesDone: 3, filesTotal: 412 };
    const view = botSyncView(failed, { botName: "Crassly", now: NOW + 86_400_000 });
    expect(view).toMatchObject({
      visible: true,
      state: "failed",
      title: BOT_SYNC_FAILED_TITLE,
      detail: "Crassly could not finish downloading your company's files.",
      progress: null,
      amount: null,
    });
    expect(view.detail.match(/\./g)).toHaveLength(1);
    expect(botSyncView(failed, { now: NOW }).detail).toBe("Your bot could not finish downloading your company's files.");
  });

  it("has no long dash in any copy", () => {
    const all = [
      botSyncView(syncing(), { botName: "Crassly", now: NOW }),
      botSyncView({ state: "done", startedAt: null, endedAt: NOW, filesDone: 1, filesTotal: 1 }, { now: NOW }),
      botSyncView({ state: "failed", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null }, { now: NOW }),
    ];
    for (const view of all) expect(`${view.title} ${view.detail}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("needs a clock only while time changes what it shows", () => {
    expect(botSyncNeedsClock(null, NOW)).toBe(false);
    expect(botSyncNeedsClock(syncing(), NOW)).toBe(true);
    expect(botSyncNeedsClock(syncing({ startedAt: null }), NOW)).toBe(false);
    expect(botSyncNeedsClock(syncing({ filesDone: 1, filesTotal: 2 }), NOW)).toBe(false);
    const done: BotSyncFacts = { state: "done", startedAt: null, endedAt: NOW, filesDone: null, filesTotal: null };
    expect(botSyncNeedsClock(done, NOW + 1_000)).toBe(true);
    expect(botSyncNeedsClock(done, NOW + BOT_SYNC_DONE_VISIBLE_MS)).toBe(false);
    expect(botSyncNeedsClock({ ...done, state: "failed" }, NOW)).toBe(false);
  });
});

describe("observeBotSync", () => {
  const live = (over: Record<string, unknown> = {}) => ({
    phase: "pull",
    filesTotal: 412,
    filesDone: 128,
    startedAt: iso(NOW - 120_000),
    updatedAt: iso(NOW - 20_000),
    ...over,
  });

  it("reads the first download's real counts from runtime.firstSync", () => {
    expect(observeBotSync(status({ firstSync: live(), firstSyncStartedAt: iso(NOW - 125_000) }), NOW)).toEqual({
      state: "syncing",
      startedAt: NOW - 120_000,
      filesDone: 128,
      filesTotal: 412,
      bytesDone: null,
      bytesTotal: null,
    });
    expect(observeBotSync(status({ firstSync: live({ bytesTotal: 1000, bytesDone: 10 }) }), NOW)).toMatchObject({
      bytesDone: 10,
      bytesTotal: 1000,
    });
  });

  it("a first download with no progress yet counts only for a bot made here, or once it has started", () => {
    expect(observeBotSync(status({ status: "running" }), NOW)).toEqual({ state: "none" });
    expect(observeBotSync(status({ status: "running" }), NOW, { expectFirstSync: true })).toEqual({
      state: "syncing",
      startedAt: null,
      filesDone: null,
      filesTotal: null,
      bytesDone: null,
      bytesTotal: null,
    });
    expect(observeBotSync(status({ firstSyncStartedAt: iso(NOW - 5_000) }), NOW)).toMatchObject({
      state: "syncing",
      startedAt: NOW - 5_000,
    });
  });

  it("says nothing before the bot can chat, or when the answer has no runtime", () => {
    const waking = status({ firstSync: live() }, { setupState: { phase: "provisioning", steps: [{ name: "sync", status: "running" }] } });
    expect(observeBotSync(waking, NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    expect(observeBotSync(status(null), NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    expect(observeBotSync({ setupState: { phase: "ready" } }, NOW, { expectFirstSync: true })).toEqual({ state: "none" });
    for (const junk of [null, undefined, "x", 3, [], {}]) expect(observeBotSync(junk, NOW)).toEqual({ state: "none" });
  });

  it("is done once a sync has finished well", () => {
    expect(observeBotSync(status({ syncOkAt: iso(NOW) }), NOW)).toEqual({ state: "done", filesTotal: null });
    expect(
      observeBotSync(
        status({ syncOkAt: iso(NOW), firstSyncFinalized: { totalObjects: 412, startedAt: iso(NOW - 9), finishedAt: iso(NOW) } }),
        NOW,
      ),
    ).toEqual({ state: "done", filesTotal: 412 });
  });

  it("a later full download shows while the bot's computer reports fresh progress", () => {
    const later = status({ syncOkAt: iso(NOW - 86_400_000), firstSync: live() });
    expect(observeBotSync(later, NOW)).toMatchObject({ state: "syncing", filesDone: 128, filesTotal: 412 });
    // Progress nobody has refreshed is not a sync that is running now.
    const stale = status({ syncOkAt: iso(NOW - 86_400_000), firstSync: live({ updatedAt: iso(NOW - BOT_SYNC_STALE_MS - 1) }) });
    expect(observeBotSync(stale, NOW)).toEqual({ state: "done", filesTotal: null });
  });

  it("a failed sync step is a failed first download; another setup failure is not", () => {
    const stepFailed = status({}, { setupState: { phase: "failed", steps: [{ name: "codex-auth", status: "done" }, { name: "sync", status: "failed" }] } });
    expect(observeBotSync(stepFailed, NOW)).toEqual({ state: "failed", first: true });
    const otherFailed = status({}, { setupState: { phase: "failed", steps: [{ name: "codex-auth", status: "failed" }] } });
    expect(observeBotSync(otherFailed, NOW)).toEqual({ state: "failed", first: false });
    const laterFailed = status({ syncOkAt: iso(NOW - 86_400_000), lastHeartbeat: { at: iso(NOW), components: { sync: "failed" } } });
    expect(observeBotSync(laterFailed, NOW)).toEqual({ state: "failed", first: false });
    // A degraded or unknown last run is not a failure.
    const degraded = status({ syncOkAt: iso(NOW - 86_400_000), lastHeartbeat: { at: iso(NOW), components: { sync: "degraded" } } });
    expect(observeBotSync(degraded, NOW).state).toBe("done");
  });
});

describe("advanceBotSync", () => {
  const seen = { state: "syncing" as const, startedAt: NOW - 60_000, filesDone: 10, filesTotal: 40, bytesDone: null, bytesTotal: null };

  it("starts showing a sync, and keeps the same object while nothing changes", () => {
    const first = advanceBotSync(null, seen, NOW);
    expect(first).toEqual({ state: "syncing", startedAt: NOW - 60_000, endedAt: null, filesDone: 10, filesTotal: 40, bytesDone: null, bytesTotal: null });
    expect(advanceBotSync(first, seen, NOW + 30_000)).toBe(first);
    expect(advanceBotSync(first, { ...seen, filesDone: 20 }, NOW + 30_000)).toMatchObject({ filesDone: 20 });
  });

  it("times an unreported start from when the app first saw the sync, and keeps it", () => {
    const blind = { ...seen, startedAt: null, filesDone: null, filesTotal: null };
    const first = advanceBotSync(null, blind, NOW);
    expect(first?.startedAt).toBe(NOW);
    expect(advanceBotSync(first, blind, NOW + 30_000)).toBe(first);
  });

  it("done after a sync this app saw: up to date, then hidden after the delay", () => {
    const running = advanceBotSync(null, seen, NOW);
    const done = advanceBotSync(running, { state: "done", filesTotal: 40 }, NOW + 90_000);
    expect(done).toMatchObject({ state: "done", endedAt: NOW + 90_000, filesTotal: 40 });
    expect(botSyncView(done, { now: NOW + 90_000 })).toMatchObject({ visible: true, title: BOT_SYNC_DONE_TITLE, progress: 100 });
    expect(botSyncView(done, { now: NOW + 90_000 + BOT_SYNC_DONE_VISIBLE_MS }).visible).toBe(false);
    // The next answer says done again: nothing comes back.
    expect(advanceBotSync(done, { state: "done", filesTotal: 40 }, NOW + 120_000)).toBe(done);
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
  });

  it("a sync that stops being reported stops showing", () => {
    const running = advanceBotSync(null, seen, NOW);
    expect(advanceBotSync(running, { state: "none" }, NOW + 1)).toBeNull();
  });
});
