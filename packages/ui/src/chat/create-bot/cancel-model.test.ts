import { describe, expect, it, vi } from "vitest";

import {
  beginBotRemoval,
  botRemovalDismissLabel,
  botRemovalLine,
  canRetryBotRemoval,
  cancelBotConfirmCopy,
  loadOpenBotRemovals,
  loadRemovedBots,
  readBotRemovalAnswer,
  rememberRemovedBot,
  runBotRemoval,
  saveOpenBotRemovals,
  type BotRemoval,
  type BotRemovalPhase,
  type BotRemovalProblem,
} from "./cancel-model.js";

const noWait = async (): Promise<void> => {};

/** The long dash, which screen copy never uses. Built from its code so this file has none. */
const LONG_DASH = String.fromCharCode(0x2014);

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("readBotRemovalAnswer", () => {
  it("says removed only on the server's own word", () => {
    expect(readBotRemovalAnswer({ ok: true, value: { terminal: true } })).toEqual({ kind: "removed" });
    expect(
      readBotRemovalAnswer({ ok: true, value: { terminal: false, setupState: { phase: "deprovisioned" } } }),
    ).toEqual({ kind: "removed" });
    // Removal started and has more to do.
    expect(
      readBotRemovalAnswer({ ok: true, value: { terminal: false, setupState: { phase: "deprovisioning" } } }),
    ).toEqual({ kind: "working" });
    // A success that does not say the bot is gone is not treated as gone.
    expect(readBotRemovalAnswer({ ok: true, value: {} })).toEqual({ kind: "working" });
    expect(readBotRemovalAnswer({ ok: true })).toEqual({ kind: "working" });
  });

  it("reads the refusals the server can answer with", () => {
    expect(
      readBotRemovalAnswer({ ok: false, code: "STEP_ALREADY_IN_PROGRESS" }),
    ).toEqual({ kind: "busy" });
    expect(
      readBotRemovalAnswer({ ok: false, code: "AGENTS_V2_BOX_PROTECTED", instanceId: "i-0abc1234def567890" }),
    ).toEqual({ kind: "name-machine", instanceId: "i-0abc1234def567890" });
    // The same refusal without the machine cannot be answered.
    expect(readBotRemovalAnswer({ ok: false, code: "AGENTS_V2_BOX_PROTECTED" })).toEqual({ kind: "failed" });
    expect(readBotRemovalAnswer({ ok: false, code: "http-403" })).toEqual({ kind: "refused", problem: "not-allowed" });
    expect(
      readBotRemovalAnswer({ ok: false, code: "TEAM_SETUP_AGENT_PROTECTED" }),
    ).toEqual({ kind: "refused", problem: "plan-bot" });
  });

  it("treats everything else as a failure, including a bot the server cannot find", () => {
    expect(readBotRemovalAnswer({ ok: false, code: "http-404" })).toEqual({ kind: "failed" });
    expect(readBotRemovalAnswer({ ok: false, code: "http-502" })).toEqual({ kind: "failed" });
    expect(readBotRemovalAnswer(null)).toEqual({ kind: "failed" });
    expect(readBotRemovalAnswer(undefined)).toEqual({ kind: "failed" });
  });
});

describe("runBotRemoval", () => {
  it("removes a bot the server takes down in one request", async () => {
    const remove = vi.fn(async () => ({ ok: true, value: { terminal: true } }));
    await expect(runBotRemoval("agt_nova", remove, { sleep: noWait })).resolves.toBe("removed");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("agt_nova", undefined);
  });

  it("names the running computer when the server asks for it, then keeps naming it", async () => {
    const answers = [
      { ok: false, code: "AGENTS_V2_BOX_PROTECTED", instanceId: "i-0abc1234def567890" },
      { ok: true, value: { terminal: false, setupState: { phase: "deprovisioning" } } },
      { ok: true, value: { terminal: true } },
    ];
    const remove = vi.fn(async () => answers.shift());
    await expect(runBotRemoval("agt_nova", remove, { sleep: noWait })).resolves.toBe("removed");
    expect(remove.mock.calls).toEqual([
      ["agt_nova", undefined],
      ["agt_nova", { confirmDestroyInstanceId: "i-0abc1234def567890" }],
      ["agt_nova", { confirmDestroyInstanceId: "i-0abc1234def567890" }],
    ]);
  });

  it("stops when naming the computer does not help", async () => {
    const remove = vi.fn(async () => ({
      ok: false,
      code: "AGENTS_V2_BOX_PROTECTED",
      instanceId: "i-0abc1234def567890",
    }));
    await expect(runBotRemoval("agt_nova", remove, { sleep: noWait })).resolves.toBe("error");
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("waits and asks again while the server is busy with a setup step", async () => {
    const sleep = vi.fn(noWait);
    const answers = [
      { ok: false, code: "STEP_ALREADY_IN_PROGRESS" },
      { ok: false, code: "STEP_ALREADY_IN_PROGRESS" },
      { ok: true, value: { terminal: true } },
    ];
    const remove = vi.fn(async () => answers.shift());
    await expect(runBotRemoval("agt_nova", remove, { sleep, retryMs: 250 })).resolves.toBe("removed");
    expect(remove).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("gives up after three failed requests in a row, and a thrown request counts as one", async () => {
    let calls = 0;
    const remove = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("offline");
      return { ok: false, code: "http-502" };
    });
    await expect(runBotRemoval("agt_nova", remove, { sleep: noWait })).resolves.toBe("error");
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("does not report removed when the server never finishes", async () => {
    const remove = vi.fn(async () => ({ ok: true, value: { terminal: false } }));
    await expect(
      runBotRemoval("agt_nova", remove, { sleep: noWait, maxRequests: 5 }),
    ).resolves.toBe("error");
    expect(remove).toHaveBeenCalledTimes(5);
  });

  it("does not keep asking when the server will not remove the bot for this person", async () => {
    const remove = vi.fn(async () => ({ ok: false, code: "http-403" }));
    await expect(runBotRemoval("agt_nova", remove, { sleep: noWait })).resolves.toBe("not-allowed");
    expect(remove).toHaveBeenCalledTimes(1);

    const planBot = vi.fn(async () => ({ ok: false, code: "TEAM_SETUP_AGENT_PROTECTED" }));
    await expect(runBotRemoval("agt_nova", planBot, { sleep: noWait })).resolves.toBe("plan-bot");
    expect(planBot).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a bot with no id", async () => {
    const remove = vi.fn();
    await expect(runBotRemoval("  ", remove, { sleep: noWait })).resolves.toBe("unknown-bot");
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("what the person reads", () => {
  const phases: Array<[BotRemovalPhase, BotRemovalProblem | null]> = [
    ["stopping", null],
    ["removing", null],
    ["removed", null],
    ["not-created", null],
    ["failed", "error"],
    ["failed", "not-allowed"],
    ["failed", "plan-bot"],
    ["failed", "unknown-bot"],
  ];

  it("names the bot on every line, in plain words", () => {
    for (const [phase, problem] of phases) {
      const line = botRemovalLine({ name: "Nova", phase, problem });
      expect(line).toContain("Nova");
      expect(line).not.toContain(LONG_DASH);
      expect(line).not.toMatch(/deprovision|decommission|instance|identity|membership|vault|runtime|step/i);
    }
  });

  it("never says removed for a bot that still exists", () => {
    expect(botRemovalLine({ name: "Nova", phase: "removed", problem: null })).toBe("Nova was removed.");
    for (const [phase, problem] of phases.filter(([value]) => value !== "removed")) {
      expect(botRemovalLine({ name: "Nova", phase, problem })).not.toContain("was removed");
    }
    expect(botRemovalLine({ name: "Nova", phase: "failed", problem: "error" })).toBe(
      "We couldn't remove Nova. It still exists.",
    );
  });

  it("offers Try again only when asking again can help", () => {
    const base = { agentUid: "agt_nova", phase: "failed" as const };
    expect(canRetryBotRemoval({ ...base, problem: "error" })).toBe(true);
    expect(canRetryBotRemoval({ ...base, problem: "not-allowed" })).toBe(false);
    expect(canRetryBotRemoval({ ...base, problem: "plan-bot" })).toBe(false);
    expect(canRetryBotRemoval({ agentUid: "", phase: "failed", problem: "unknown-bot" })).toBe(false);
    expect(canRetryBotRemoval({ agentUid: "agt_nova", phase: "removing", problem: null })).toBe(false);
  });

  it("says the bot is kept when a removal that could be asked again is put away", () => {
    const base = { name: "Nova", agentUid: "agt_nova", phase: "failed" as const };
    expect(botRemovalDismissLabel({ ...base, problem: "error" })).toBe("Keep Nova");
    expect(botRemovalDismissLabel({ ...base, problem: "not-allowed" })).toBe("OK");
    expect(botRemovalDismissLabel({ ...base, problem: "plan-bot" })).toBe("OK");
    expect(botRemovalDismissLabel({ ...base, agentUid: "", problem: "unknown-bot" })).toBe("OK");
  });

  it("asks before removing a bot that exists, naming the bot and the company", () => {
    const copy = cancelBotConfirmCopy({ name: "Nova", companyLabel: "Acme" });
    expect(copy.title).toBe("Cancel Nova?");
    expect(copy.body).toContain("Nova will be removed from Acme");
    expect(copy.confirm).toBe("Remove Nova");
    expect(copy.keep).toBe("Keep Nova");
    expect(`${copy.title} ${copy.body}`).not.toContain(LONG_DASH);
  });
});

describe("cancelled bots across restarts", () => {
  it("starts a cancel in the right phase", () => {
    expect(beginBotRemoval({ name: "Nova", companyUid: "cmp_acme" }).phase).toBe("stopping");
    expect(beginBotRemoval({ name: "Nova", companyUid: "cmp_acme", agentUid: "agt_nova" }).phase).toBe("removing");
  });

  it("keeps bots that still exist and are known by id, and nothing else", () => {
    const storage = memoryStorage();
    const removing = beginBotRemoval({ name: "Nova", companyUid: "cmp_acme", agentUid: "agt_nova", brain: "claude", hadRow: true });
    const failed: BotRemoval = {
      ...beginBotRemoval({ name: "Rex", companyUid: "cmp_acme", agentUid: "agt_rex" }),
      phase: "failed",
      problem: "not-allowed",
    };
    const stopping = beginBotRemoval({ name: "Ivy", companyUid: "cmp_acme" });
    const removed: BotRemoval = { ...beginBotRemoval({ name: "Old", companyUid: "cmp_acme", agentUid: "agt_old" }), phase: "removed" };
    saveOpenBotRemovals([removing, failed, stopping, removed], storage);

    const loaded = loadOpenBotRemovals(storage);
    expect(loaded.map((removal) => [removal.agentUid, removal.phase, removal.problem, removal.hadRow, removal.brain])).toEqual([
      ["agt_nova", "removing", null, true, "claude"],
      ["agt_rex", "failed", "not-allowed", false, null],
    ]);
  });

  it("reads nothing from missing or damaged storage", () => {
    expect(loadOpenBotRemovals(null)).toEqual([]);
    expect(loadOpenBotRemovals({ getItem: () => "{not json" })).toEqual([]);
    expect(loadRemovedBots({ getItem: () => "{not json" })).toEqual([]);
  });

  it("remembers removed bots once each", () => {
    const storage = memoryStorage();
    let uids = rememberRemovedBot([], "agt_nova", storage);
    uids = rememberRemovedBot(uids, "agt_nova", storage);
    uids = rememberRemovedBot(uids, "agt_rex", storage);
    expect(uids).toEqual(["agt_rex", "agt_nova"]);
    expect(loadRemovedBots(storage)).toEqual(["agt_rex", "agt_nova"]);
  });
});
