import { describe, expect, it } from "vitest";
import type { LocalBotRow, RemoteBotRow } from "@hq/platform";

import {
  AUTO_RESTORE_MAX_ATTEMPTS,
  AUTO_RESTORE_RETRY_MS,
  AUTO_RESTORE_RUNNING,
  AUTO_RESTORE_STARTING_THIS_BOT,
  autoRestoreAllowed,
  autoRestoreCandidates,
  autoRestoreCoversAll,
  autoRestoreDoneLine,
  autoRestoreDue,
  autoRestoreExhausted,
  autoRestoreFailedLine,
  autoRestoreHeldBack,
  autoRestoreStateKey,
  countAutoRestoreAttempt,
  joinBotNames,
  noteAutoRestoreAttempt,
} from "./bot-auto-restore.js";
import {
  BOT_LIVE_ELSEWHERE_NOTICE,
  BOT_LIVE_ELSEWHERE_WINDOW_MS,
  botLiveElsewhere,
  botsLiveElsewhereNotice,
  remoteBotListingFailed,
  remoteBotListingOk,
  NO_REMOTE_BOT_LISTING,
} from "./bot-restore.js";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
/** A heartbeat `ago` milliseconds before `NOW`. */
function beat(ago: number): string {
  return new Date(NOW - ago).toISOString();
}

function remote(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "setup",
    agentUid: "agt_setup",
    kind: "personal",
    online: false,
    lastHeartbeatAt: null,
    here: false,
    ...over,
  } as RemoteBotRow;
}

function local(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return { name: "setup", agentUid: "agt_setup", processAlive: true, online: true, ...over } as LocalBotRow;
}

describe("autoRestoreCandidates", () => {
  it("names the bots the app may bring back by itself", () => {
    const listing = remoteBotListingOk([
      remote(),
      remote({ name: "test-bot", agentUid: "agt_test" }),
    ]);
    expect(autoRestoreCandidates(listing, []).map((b) => b.name)).toEqual(["setup", "test-bot"]);
  });

  it("never offers a company bot — it can only ever run in HQ Cloud", () => {
    const listing = remoteBotListingOk([
      remote({ name: "izzy", agentUid: "agt_izzy", kind: "company" }),
      remote({ name: "ops", agentUid: "agt_ops", runnable: false, reason: "company-bot" }),
      remote(),
    ]);
    expect(autoRestoreCandidates(listing, []).map((b) => b.name)).toEqual(["setup"]);
  });

  it("skips a bot that is already running on this computer", () => {
    const listing = remoteBotListingOk([remote()]);
    expect(autoRestoreCandidates(listing, [local()])).toEqual([]);
  });

  it("acts on nothing while the listing is unreadable — restoring goes through HQ Cloud", () => {
    expect(autoRestoreCandidates(NO_REMOTE_BOT_LISTING, [])).toEqual([]);
    const stale = remoteBotListingFailed(remoteBotListingOk([remote()]), "server-unsupported");
    expect(autoRestoreCandidates(stale, [])).toEqual([]);
  });
});

describe("a bot that is RUNNING on another computer is never taken by itself", () => {
  // Adopting rotates the machine secret, so the other Mac's copy stops at its
  // next token refresh. Opening the app on a second computer must not do that
  // to every bot with no click and nothing said.
  it("skips a bot the listing says is online elsewhere", () => {
    const listing = remoteBotListingOk([
      remote({ online: true }),
      remote({ name: "test-bot", agentUid: "agt_test" }),
    ]);
    expect(autoRestoreCandidates(listing, [], NOW).map((b) => b.name)).toEqual(["test-bot"]);
    expect(autoRestoreHeldBack(listing, [], NOW).map((b) => b.name)).toEqual(["setup"]);
  });

  it("skips a bot whose heartbeat is still fresh, even with online false", () => {
    // `online` lags both ways; the listing's own timestamp is the other half.
    const listing = remoteBotListingOk([remote({ online: false, lastHeartbeatAt: beat(60_000) })]);
    expect(autoRestoreCandidates(listing, [], NOW)).toEqual([]);
    expect(autoRestoreHeldBack(listing, [], NOW).map((b) => b.name)).toEqual(["setup"]);
  });

  it("still brings back the wiped Mac's bots: offline, and the heartbeat is old", () => {
    const listing = remoteBotListingOk([
      remote({ online: false, lastHeartbeatAt: beat(BOT_LIVE_ELSEWHERE_WINDOW_MS + 1_000) }),
      remote({ name: "test-bot", agentUid: "agt_test", online: false, lastHeartbeatAt: null }),
    ]);
    expect(autoRestoreCandidates(listing, [], NOW).map((b) => b.name)).toEqual([
      "setup",
      "test-bot",
    ]);
    expect(autoRestoreHeldBack(listing, [], NOW)).toEqual([]);
  });

  it("reads an unreadable or future heartbeat on the safe side", () => {
    expect(botLiveElsewhere(remote({ lastHeartbeatAt: "not a date" }), NOW)).toBe(false);
    // Two machines, two clocks: a beat from the future is still a live bot.
    expect(botLiveElsewhere(remote({ lastHeartbeatAt: beat(-30_000) }), NOW)).toBe(true);
  });

  it("is never 'elsewhere' for a bot that is set up HERE", () => {
    expect(botLiveElsewhere(remote({ here: true, online: true }), NOW)).toBe(false);
  });
});

describe("what is restored is what is charged", () => {
  const setup = remote();
  const test = remote({ name: "test-bot", agentUid: "agt_test" });

  it("uses the bulk restore only when the app is asking for exactly its set", () => {
    // `hq bot restore` takes no names: it brings back everything missing here.
    expect(autoRestoreCoversAll([setup, test], [test, setup])).toBe(true);
    expect(autoRestoreCoversAll([setup], [setup, test])).toBe(false);
    expect(autoRestoreCoversAll([], [])).toBe(true);
  });

  it("backs off per bot, so one bot's try never holds or spends another's", () => {
    let last = noteAutoRestoreAttempt({}, [setup], NOW);
    expect(autoRestoreDue(last, [setup, test], NOW).map((b) => b.name)).toEqual(["test-bot"]);
    // Inside the back-off it stays held…
    expect(autoRestoreDue(last, [setup], NOW + AUTO_RESTORE_RETRY_MS - 1)).toEqual([]);
    // …and after it, it is due again.
    expect(autoRestoreDue(last, [setup], NOW + AUTO_RESTORE_RETRY_MS).map((b) => b.name)).toEqual([
      "setup",
    ]);
    last = noteAutoRestoreAttempt(last, [test], NOW);
    expect(autoRestoreDue(last, [setup, test], NOW)).toEqual([]);
  });

  it("lets a bot never tried go at once", () => {
    expect(autoRestoreDue({}, [setup], NOW).map((b) => b.name)).toEqual(["setup"]);
  });
});

describe("the set fingerprint", () => {
  it("is order-independent, so the same bots are the same set", () => {
    const a = autoRestoreStateKey([remote(), remote({ agentUid: "agt_test" })]);
    const b = autoRestoreStateKey([remote({ agentUid: "agt_test" }), remote()]);
    expect(a).toBe(b);
  });

  it("changes when a bot appears, so a wider set is never mistaken for a narrower one", () => {
    const before = autoRestoreStateKey([remote()]);
    const after = autoRestoreStateKey([remote(), remote({ agentUid: "agt_test" })]);
    expect(after).not.toBe(before);
  });
});

describe("the per-bot budget", () => {
  it("stops after three automatic tries and leaves the manual notice", () => {
    const bots = [remote()];
    let attempts = {};
    for (let i = 0; i < AUTO_RESTORE_MAX_ATTEMPTS; i += 1) {
      expect(autoRestoreAllowed(attempts, bots)).toHaveLength(1);
      attempts = countAutoRestoreAttempt(attempts, bots);
    }
    expect(autoRestoreAllowed(attempts, bots)).toEqual([]);
    expect(autoRestoreExhausted(attempts, bots)).toBe(true);
  });

  it("is per bot: one bot's failures never spend another's budget", () => {
    const setup = remote();
    const test = remote({ name: "test-bot", agentUid: "agt_test" });
    let attempts = {};
    for (let i = 0; i < AUTO_RESTORE_MAX_ATTEMPTS; i += 1) {
      attempts = countAutoRestoreAttempt(attempts, [setup]);
    }
    expect(autoRestoreAllowed(attempts, [setup, test]).map((b) => b.name)).toEqual(["test-bot"]);
    expect(autoRestoreExhausted(attempts, [setup, test])).toBe(false);
  });

  it("is not exhausted when there is nothing to bring back", () => {
    expect(autoRestoreExhausted({}, [])).toBe(false);
  });
});

describe("what the person reads", () => {
  it("names the bots that came back, in plain words", () => {
    expect(autoRestoreDoneLine(["setup", "test-bot"])).toBe("setup and test-bot are back online.");
    expect(autoRestoreDoneLine(["setup"])).toBe("setup is back online.");
    expect(autoRestoreDoneLine(["a", "b", "c"])).toBe("a, b and c are back online.");
    expect(autoRestoreDoneLine([])).toBe("");
  });

  it("names the ones that could not, with the reason sentence the app already has", () => {
    expect(autoRestoreFailedLine(["setup"], "Restoring bots needs a newer HQ Cloud.")).toBe(
      "setup couldn't be brought back to this computer. Restoring bots needs a newer HQ Cloud.",
    );
    expect(autoRestoreFailedLine(["setup"], null)).toBe(
      "setup couldn't be brought back to this computer.",
    );
  });

  it("never renders anything a CLI or an API said", () => {
    for (const line of [
      AUTO_RESTORE_RUNNING,
      AUTO_RESTORE_STARTING_THIS_BOT,
      autoRestoreDoneLine(["setup"]),
      autoRestoreFailedLine(["setup"], null),
    ]) {
      expect(line).not.toMatch(/hq bot|HQ API|\/v1\/|\b\d{3}\b/);
      expect(line).not.toMatch(/\bagent\b/i);
    }
  });

  it("says what starting a live bot here costs, in one sentence", () => {
    expect(BOT_LIVE_ELSEWHERE_NOTICE).toBe(
      "This bot is running on another computer. Starting it here stops it there.",
    );
    expect(botsLiveElsewhereNotice(1)).toBe(BOT_LIVE_ELSEWHERE_NOTICE);
    expect(botsLiveElsewhereNotice(3)).toBe(
      "3 of these bots are running on another computer. Starting them here stops them there.",
    );
    expect(botsLiveElsewhereNotice(0)).toBe("");
    for (const line of [BOT_LIVE_ELSEWHERE_NOTICE, botsLiveElsewhereNotice(2)]) {
      expect(line).not.toMatch(/hq bot|HQ API|\/v1\/|credential|secret/i);
      expect(line).not.toMatch(/\bagent\b/i);
    }
  });

  it("joins names without inventing punctuation for one of them", () => {
    expect(joinBotNames([" setup ", "", "test-bot"])).toBe("setup and test-bot");
    expect(joinBotNames([])).toBe("");
  });
});
