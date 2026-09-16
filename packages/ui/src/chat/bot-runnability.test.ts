import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import {
  BOT_NOT_RUNNABLE_HERE,
  BOT_START_MAX_ATTEMPTS,
  LOCAL_BOT_TRACE_KEY,
  botRunsHere,
  canStartBot,
  classifyBotStartFailure,
  clearBotStartGate,
  isDefinitiveBotStartFailure,
  localBotsTracedButGone,
  readLocalBotTrace,
  reconcileLocalBotTrace,
  recordBotStartFailure,
  rememberLocalBots,
  type BotStartGate,
  type LocalBotTraceStore,
} from "./bot-runnability.js";

/** The exact line the owner's VM wrote 48 times into the bot's log. */
const NO_SUCH_BOT = 'No bot named "setup". Create one with: hq bot create setup';

function row(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: "agt_setup",
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 1,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    ...over,
  } as LocalBotRow;
}

describe("classifyBotStartFailure", () => {
  it('reads the CLI\'s "no such bot" as definitive and specific', () => {
    expect(classifyBotStartFailure(NO_SUCH_BOT)).toBe("missing");
    expect(classifyBotStartFailure('No such bot "cobot"')).toBe("missing");
    expect(classifyBotStartFailure('Bot "test-bot" does not exist')).toBe("missing");
  });

  it("reads timeouts and an unreachable CLI as worth another go", () => {
    expect(classifyBotStartFailure("hq bot start setup did not finish within 60s")).toBe("transient");
    expect(classifyBotStartFailure("Could not start the hq CLI: ENOENT")).toBe("transient");
    expect(classifyBotStartFailure("connect ECONNRESET")).toBe("transient");
    expect(classifyBotStartFailure("HQ API /v1/agents → 503: Service Unavailable")).toBe("transient");
  });

  it("treats anything it does not recognise as definitive, never as a retry", () => {
    // Guessing "transient" is what produces a loop; guessing "blocked" costs
    // one click.
    expect(classifyBotStartFailure("Claude Code is not signed in.")).toBe("blocked");
    expect(classifyBotStartFailure("This bot is held for cloud promotion.")).toBe("blocked");
    expect(classifyBotStartFailure("")).toBe("blocked");
    expect(classifyBotStartFailure(null)).toBe("blocked");
    expect(isDefinitiveBotStartFailure("blocked")).toBe(true);
    expect(isDefinitiveBotStartFailure("missing")).toBe(true);
    expect(isDefinitiveBotStartFailure("transient")).toBe(false);
  });
});

describe("the start gate", () => {
  it("closes after ONE definitive failure", () => {
    let gate: BotStartGate = {};
    expect(canStartBot(gate, "setup")).toBe(true);
    gate = recordBotStartFailure(gate, "setup", classifyBotStartFailure(NO_SUCH_BOT));
    expect(canStartBot(gate, "setup")).toBe(false);
    expect(gate.setup?.attempts).toBe(1);
  });

  it("bounds transient failures instead of retrying forever", () => {
    let gate: BotStartGate = {};
    for (let i = 1; i < BOT_START_MAX_ATTEMPTS; i += 1) {
      gate = recordBotStartFailure(gate, "setup", "transient");
      expect(canStartBot(gate, "setup"), `attempt ${i} still allows a retry`).toBe(true);
    }
    gate = recordBotStartFailure(gate, "setup", "transient");
    expect(canStartBot(gate, "setup")).toBe(false);
    expect(gate.setup?.attempts).toBe(BOT_START_MAX_ATTEMPTS);
  });

  it("keeps each bot's budget to itself, and reopens on recovery", () => {
    let gate: BotStartGate = recordBotStartFailure({}, "setup", "missing");
    expect(canStartBot(gate, "cobot")).toBe(true);
    gate = clearBotStartGate(gate, "setup");
    expect(canStartBot(gate, "setup")).toBe(true);
    expect(clearBotStartGate(gate, "absent")).toBe(gate);
  });
});

describe("botRunsHere", () => {
  it("is true only when this Mac has the bot", () => {
    expect(botRunsHere([row()], "agt_setup")).toBe(true);
    expect(botRunsHere([row()], " agt_setup ")).toBe(true);
    expect(botRunsHere([], "agt_setup")).toBe(false);
    expect(botRunsHere(null, "agt_setup")).toBe(false);
    expect(botRunsHere([row()], "")).toBe(false);
  });
});

describe("the copy", () => {
  it("never quotes the CLI or the API", () => {
    expect(BOT_NOT_RUNNABLE_HERE).not.toMatch(/hq bot|HQ API|\d{3}/);
    expect(BOT_NOT_RUNNABLE_HERE).toContain("another computer");
  });
});

/**
 * BOTS THIS COMPUTER HAS RUN.
 *
 * `hq bot list` reads each bot's own config, so a wiped bot drops off it
 * silently — and with the account's own listing unavailable (the owner's VM
 * had it answering 404) the app had nothing left to tell "your bot, here,
 * with nothing to run it" from "someone else's cloud bot". It drew four of the
 * owner's own bots as `Cloud` and let a message spin for 2 m 39 s. This trace
 * is the local evidence that needs no server.
 */
describe("the trace of bots this computer has run", () => {
  function store(initial: Record<string, string> = {}): LocalBotTraceStore & {
    values: Record<string, string>;
    writes: number;
  } {
    const values = { ...initial };
    return {
      values,
      writes: 0,
      getItem(key) {
        return values[key] ?? null;
      },
      setItem(key, value) {
        values[key] = value;
        this.writes += 1;
      },
    };
  }

  it("remembers every bot the listing named, by uid and local folder name", () => {
    const s = store();
    const trace = rememberLocalBots(s, {}, [row(), row({ name: "iris", agentUid: "agt_iris" })]);
    expect(trace).toEqual({ agt_setup: "setup", agt_iris: "iris" });
    expect(readLocalBotTrace(s)).toEqual(trace);
  });

  it("never writes absence back, because absence is the wipe it exists to notice", () => {
    const s = store();
    const first = rememberLocalBots(s, {}, [row()]);
    // The config is gone, so the bot is gone from the listing.
    const second = rememberLocalBots(s, first, []);
    expect(second).toBe(first);
    expect(second).toEqual({ agt_setup: "setup" });
    expect(s.writes, "an unchanged trace is not re-written").toBe(1);
  });

  it("drops a bot that finished promotion, so a cloud bot is never called local", () => {
    const s = store();
    const trace = rememberLocalBots(s, { agt_setup: "setup" }, [row({ hosting: "cloud" })]);
    expect(trace).toEqual({});
  });

  it("prunes bots the account no longer owns, but only from a listing that answered", () => {
    const s = store();
    const trace = { agt_setup: "setup", agt_removed: "removed" };
    expect(reconcileLocalBotTrace(s, trace, [{ agentUid: "agt_setup" }])).toEqual({
      agt_setup: "setup",
    });
    // A listing that failed is not evidence that anything is gone.
    expect(reconcileLocalBotTrace(s, trace, null)).toBe(trace);
  });

  it("names the bots that are traced here and no longer on this Mac's listing", () => {
    const trace = { agt_setup: "setup", agt_iris: "iris" };
    expect(localBotsTracedButGone(trace, [row()])).toEqual([{ name: "iris", agentUid: "agt_iris" }]);
    expect(localBotsTracedButGone(trace, [])).toHaveLength(2);
    expect(localBotsTracedButGone({}, [])).toEqual([]);
  });

  it("treats an unreadable or missing trace as no trace, never as a throw", () => {
    expect(readLocalBotTrace(null)).toEqual({});
    expect(readLocalBotTrace(store({ [LOCAL_BOT_TRACE_KEY]: "not json" }))).toEqual({});
    expect(readLocalBotTrace(store({ [LOCAL_BOT_TRACE_KEY]: "[1,2]" }))).toEqual({});
    expect(readLocalBotTrace(store({ [LOCAL_BOT_TRACE_KEY]: '{"agt_x": 7}' }))).toEqual({});
    const throwing: LocalBotTraceStore = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(readLocalBotTrace(throwing)).toEqual({});
    expect(rememberLocalBots(throwing, {}, [row()])).toEqual({ agt_setup: "setup" });
  });
});
