import { describe, expect, it } from "vitest";
import type { LocalBotRow, RemoteBotRow } from "@hq/platform";

import {
  AUTO_RESTORE_MAX_ATTEMPTS,
  AUTO_RESTORE_RUNNING,
  AUTO_RESTORE_STARTING_THIS_BOT,
  autoRestoreAllowed,
  autoRestoreCandidates,
  autoRestoreDoneLine,
  autoRestoreExhausted,
  autoRestoreFailedLine,
  autoRestoreStateKey,
  countAutoRestoreAttempt,
  joinBotNames,
} from "./bot-auto-restore.js";
import { remoteBotListingFailed, remoteBotListingOk, NO_REMOTE_BOT_LISTING } from "./bot-restore.js";

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

describe("one listing state is acted on once", () => {
  it("is order-independent, so the same bots are the same state", () => {
    const a = autoRestoreStateKey([remote(), remote({ agentUid: "agt_test" })]);
    const b = autoRestoreStateKey([remote({ agentUid: "agt_test" }), remote()]);
    expect(a).toBe(b);
  });

  it("changes when a bot appears — a bot wiped by an update comes back too", () => {
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

  it("joins names without inventing punctuation for one of them", () => {
    expect(joinBotNames([" setup ", "", "test-bot"])).toBe("setup and test-bot");
    expect(joinBotNames([])).toBe("");
  });
});
