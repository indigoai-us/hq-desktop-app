import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import {
  BOT_NOT_RUNNABLE_HERE,
  BOT_START_MAX_ATTEMPTS,
  botRunsHere,
  canStartBot,
  classifyBotStartFailure,
  clearBotStartGate,
  isDefinitiveBotStartFailure,
  recordBotStartFailure,
  type BotStartGate,
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
