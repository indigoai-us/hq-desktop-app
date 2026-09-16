import { describe, expect, it } from "vitest";
import type { BotRestoreResult, BotRestoreRow, RemoteBotRow } from "@hq/platform";

import {
  BOT_RESTORE_DISMISSED_KEY,
  BOT_START_HERE,
  adoptFallbackNotice,
  botRestorePromptBody,
  botRestorePromptDismissed,
  botRestoreRowFailed,
  botRestoreRowLine,
  botRestoreSummary,
  botsNotHere,
  ownedBotNotHere,
  rememberBotRestoreDismissed,
  type RestorePromptMemory,
} from "./bot-restore.js";

function remote(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "scout",
    agentUid: "agt_scout",
    kind: "personal",
    online: false,
    lastHeartbeatAt: null,
    here: true,
    settings: "claude, synced memory",
    ...over,
  };
}

function row(over: Partial<BotRestoreRow> = {}): BotRestoreRow {
  return { name: "scout", agentUid: "agt_scout", action: "restored", detail: "", ...over };
}

function result(over: Partial<BotRestoreResult> = {}): BotRestoreResult {
  return { ok: true, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 0, bots: [], ...over };
}

function memory(initial: Record<string, string> = {}): RestorePromptMemory & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

describe("which bots this computer cannot run", () => {
  it("is exactly the owned bots the remote listing flags as not here", () => {
    const rows = [remote(), remote({ name: "iris", agentUid: "agt_iris", here: false })];
    expect(botsNotHere(rows).map((b) => b.name)).toEqual(["iris"]);
    expect(botsNotHere(null)).toEqual([]);
  });

  it("ignores a row with no agent uid, which nothing could be matched against", () => {
    expect(botsNotHere([remote({ agentUid: "  ", here: false })])).toEqual([]);
  });

  it("answers null for a bot that runs here, and for an agent it has never heard of", () => {
    const rows = [remote(), remote({ name: "iris", agentUid: "agt_iris", here: false })];
    expect(ownedBotNotHere(rows, "agt_iris")?.name).toBe("iris");
    // Runs here: nothing to offer.
    expect(ownedBotNotHere(rows, "agt_scout")).toBeNull();
    // A cloud/fleet agent is never on this listing, so it keeps its own
    // behaviour rather than being called a bot that cannot run.
    expect(ownedBotNotHere(rows, "agt_fleet_teammate")).toBeNull();
    expect(ownedBotNotHere(rows, "")).toBeNull();
    expect(ownedBotNotHere(null, "agt_iris")).toBeNull();
  });
});

describe("the copy", () => {
  it("says bot, never agent, and offers the computer the person is on", () => {
    const text = [
      BOT_START_HERE,
      botRestorePromptBody(1),
      botRestorePromptBody(3),
      adoptFallbackNotice("scout"),
      botRestoreSummary(result({ restored: 2 })),
    ].join(" ");
    expect(text).not.toMatch(/\bagent\b/i);
    expect(BOT_START_HERE).toBe("Start on this computer");
  });

  it("counts, so one bot is never described as several", () => {
    expect(botRestorePromptBody(1)).toContain("One of your bots isn't");
    expect(botRestorePromptBody(1)).toContain("brings it back");
    expect(botRestorePromptBody(3)).toContain("3 of your bots aren't");
    expect(botRestorePromptBody(3)).toContain("brings them back");
  });
});

describe("the prompt is remembered per machine", () => {
  it("is offered until it is answered, and never again by itself", () => {
    const store = memory();
    expect(botRestorePromptDismissed(store)).toBe(false);
    rememberBotRestoreDismissed(store);
    expect(store.store[BOT_RESTORE_DISMISSED_KEY]).toBe("1");
    expect(botRestorePromptDismissed(store)).toBe(true);
  });

  it("survives a host with no storage at all rather than throwing in the shell", () => {
    const broken: RestorePromptMemory = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(botRestorePromptDismissed(broken)).toBe(false);
    expect(() => rememberBotRestoreDismissed(broken)).not.toThrow();
    expect(botRestorePromptDismissed(null)).toBe(false);
  });
});

describe("what a restore says afterwards", () => {
  it("gives every outcome a sentence a person can read", () => {
    expect(botRestoreRowLine(row({ action: "restored" }))).toBe("scout is back on this computer.");
    expect(botRestoreRowLine(row({ action: "repaired" }))).toContain("sign-in was refreshed");
    expect(botRestoreRowLine(row({ action: "skipped" }))).toContain("already set up here");
    expect(botRestoreRowLine(row({ action: "would-restore" }))).toContain("would come back");
    expect(botRestoreRowFailed(row({ action: "restored" }))).toBe(false);
    expect(botRestoreRowFailed(row({ action: "failed" }))).toBe(true);
  });

  it("never renders the CLI's or the API's own words for a bot that failed", () => {
    const raw = 'HQ API /v1/agents/agt_scout/credentials → 403: {"code":"NOT_OWNER"}';
    const line = botRestoreRowLine(row({ action: "failed", detail: raw }));
    expect(line).toBe("scout could not be brought back.");
    expect(line).not.toContain("403");
    // A sentence the CLI wrote for a person survives as-is.
    expect(botRestoreRowLine(row({ action: "failed", detail: "Its name cannot be a folder name here." }))).toBe(
      "Its name cannot be a folder name here.",
    );
  });

  it("summarises what actually happened, counting failures honestly", () => {
    expect(botRestoreSummary(result({ restored: 1 }))).toBe("One bot is back on this computer.");
    expect(botRestoreSummary(result({ restored: 3 }))).toBe("3 bots are back on this computer.");
    expect(botRestoreSummary(result({ skipped: 2 }))).toBe("Every bot you own was already set up here.");
    expect(botRestoreSummary(result({ failed: 1 }))).toBe("One bot could not be brought back.");
    expect(botRestoreSummary(result({ restored: 2, failed: 1 }))).toBe(
      "2 of your bots are back; 1 could not be brought back.",
    );
  });
});
