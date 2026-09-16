import { describe, expect, it } from "vitest";
import type { BotRestoreResult, BotRestoreRow, LocalBotRow, RemoteBotRow } from "@hq/platform";

import {
  BOT_RESTORE_CLOUD_SIGN_IN,
  BOT_RESTORE_CLOUD_UNREACHABLE,
  BOT_RESTORE_DISMISSED_KEY,
  BOT_RESTORE_NEEDS_NEWER_CLOUD,
  BOT_START_HERE,
  NO_REMOTE_BOT_LISTING,
  adoptFallbackNotice,
  botRestorePromptBody,
  botRestorePromptDismissed,
  botRestoreRowFailed,
  botRestoreRowLine,
  botRestoreSummary,
  botsNotHere,
  classifyRemoteBotFailure,
  ownedBotNotHere,
  ownedBotsNotHere,
  rememberBotRestoreDismissed,
  remoteBotListingFailed,
  remoteBotListingNotice,
  remoteBotListingOk,
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
    const owned = ownedBotsNotHere(
      remoteBotListingOk([remote(), remote({ name: "iris", agentUid: "agt_iris", here: false })]),
      {},
      [],
    );
    expect(ownedBotNotHere(owned, "agt_iris")?.name).toBe("iris");
    // Runs here: nothing to offer.
    expect(ownedBotNotHere(owned, "agt_scout")).toBeNull();
    // A cloud/fleet agent is never on this listing, so it keeps its own
    // behaviour rather than being called a bot that cannot run.
    expect(ownedBotNotHere(owned, "agt_fleet_teammate")).toBeNull();
    expect(ownedBotNotHere(owned, "")).toBeNull();
    expect(ownedBotNotHere([], "agt_iris")).toBeNull();
  });
});

/**
 * THE LISTING IS AN ENHANCEMENT, NEVER A GATE.
 *
 * The owner's VM ran against an HQ Cloud that has no `/v1/agents/mine` route:
 * the listing answered 404 every time, and because the app read runnability
 * from it, four of the owner's own local bots were drawn as `Cloud`, a wiped
 * bot's DM showed a normal composer with no notice, and one message spun for
 * 2 m 39 s. These pin the rules that make a failed listing harmless.
 */
describe("when HQ Cloud cannot list your bots", () => {
  function local(over: Partial<LocalBotRow> = {}): LocalBotRow {
    return {
      name: "scout",
      agentUid: "agt_scout",
      ownerUid: "prs_me",
      runtime: "claude",
      state: "running",
      pid: 1,
      processAlive: true,
      online: true,
      lastHeartbeatAt: null,
      daemonInstalled: true,
      daemonLoaded: true,
      dir: "/tmp/.hq/bots/scout",
      ...over,
    } as LocalBotRow;
  }

  it("reads the CLI's own reason when it reaches the app as its JSON contract", () => {
    const json = (reason: string) =>
      JSON.stringify({ ok: false, reason, message: "whatever the CLI wrote", bots: [] });
    expect(classifyRemoteBotFailure("error", json("server-unsupported"))).toBe("server-unsupported");
    expect(classifyRemoteBotFailure("error", json("network"))).toBe("network");
    expect(classifyRemoteBotFailure("error", json("auth"))).toBe("auth");
    expect(classifyRemoteBotFailure("error", json("malformed"))).toBe("malformed");
  });

  it("classifies today's raw CLI text, which is all the VM had", () => {
    // Verbatim from the VM report (T2.1) — a route the server does not have.
    expect(classifyRemoteBotFailure("error", "HQ API /v1/agents/mine → 404: Not found")).toBe(
      "server-unsupported",
    );
    expect(classifyRemoteBotFailure("error", "HQ API /v1/agents/mine → 401: Unauthorized")).toBe("auth");
    expect(classifyRemoteBotFailure("error", "hq bot list --remote did not finish within 60s")).toBe(
      "network",
    );
    // Nothing recognised is "try again": it never claims a bot is missing and
    // never hides a route that does exist.
    expect(classifyRemoteBotFailure("error", "something nobody wrote a rule for")).toBe("network");
    expect(classifyRemoteBotFailure("error", "")).toBe("network");
    // A JSON document that is not the contract falls back to reading the text.
    expect(classifyRemoteBotFailure("error", '{"oops": 404}')).toBe("server-unsupported");
  });

  it("keeps the last good listing instead of losing the rows it named", () => {
    const good = remoteBotListingOk([remote({ here: false })]);
    expect(good).toEqual({ rows: [remote({ here: false })], failure: null });

    const failed = remoteBotListingFailed(good, "server-unsupported");
    expect(failed.rows?.map((b) => b.name)).toEqual(["scout"]);
    expect(failed.failure).toBe("server-unsupported");

    // Nothing good ever landed: there is nothing to keep.
    expect(remoteBotListingFailed(NO_REMOTE_BOT_LISTING, "network")).toEqual({
      rows: null,
      failure: "network",
    });
  });

  it("says one plain sentence per reason, and nothing at all while the listing is fine", () => {
    expect(remoteBotListingNotice("server-unsupported")).toBe(BOT_RESTORE_NEEDS_NEWER_CLOUD);
    expect(remoteBotListingNotice("auth")).toBe(BOT_RESTORE_CLOUD_SIGN_IN);
    expect(remoteBotListingNotice("network")).toBe(BOT_RESTORE_CLOUD_UNREACHABLE);
    expect(remoteBotListingNotice("malformed")).toBe(BOT_RESTORE_CLOUD_UNREACHABLE);
    expect(remoteBotListingNotice(null)).toBeNull();
    // Never the CLI's or the API's own words.
    for (const failure of ["server-unsupported", "auth", "network", "malformed"] as const) {
      const sentence = remoteBotListingNotice(failure) ?? "";
      expect(sentence).not.toMatch(/40\d|\/v\d|HQ API|hq bot/);
    }
  });

  it("falls back to this computer's own trace when the listing never answered", () => {
    // The VM's T5.2: a bot this Mac had run, its config wiped, and a listing
    // that 404s. It is the person's local bot, not a cloud teammate.
    const owned = ownedBotsNotHere(
      remoteBotListingFailed(NO_REMOTE_BOT_LISTING, "server-unsupported"),
      { agt_scout: "scout" },
      [],
    );
    expect(owned).toEqual([{ name: "scout", agentUid: "agt_scout", fromListing: false }]);
  });

  it("lets local evidence outrank a stale listing, so a bot that is back stays back", () => {
    // The listing last said "not here"; this Mac's own listing now has it.
    const stale = remoteBotListingFailed(remoteBotListingOk([remote({ here: false })]), "network");
    expect(ownedBotsNotHere(stale, { agt_scout: "scout" }, [local()])).toEqual([]);
  });

  it("never invents a bot for an agent with neither a listing row nor a trace", () => {
    const owned = ownedBotsNotHere(
      remoteBotListingFailed(NO_REMOTE_BOT_LISTING, "server-unsupported"),
      {},
      [],
    );
    expect(owned).toEqual([]);
  });

  it("counts a bot once when the listing and the trace both name it", () => {
    const owned = ownedBotsNotHere(
      remoteBotListingOk([remote({ here: false })]),
      { agt_scout: "scout" },
      [],
    );
    expect(owned).toEqual([{ name: "scout", agentUid: "agt_scout", fromListing: true }]);
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
