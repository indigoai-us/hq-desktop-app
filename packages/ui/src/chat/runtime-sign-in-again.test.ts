import { describe, expect, it, vi } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import {
  botNeedsSignIn,
  botsNeedingSignIn,
  runtimesNeedingSignIn,
  signInAgain,
  signInAgainCopy,
} from "./runtime-sign-in-again.js";

function bot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: "agt_setup",
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    pid: 7,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/HQ/personal/workers/setup",
    ...over,
  };
}

const expired = (runtime: LocalBotRow["runtime"]) => ({ state: "expired" as const, runtime, since: "2026-09-15T10:00:00Z" });

function deps(states: string[], rows: LocalBotRow[]) {
  const queue = [...states];
  const loginStart = vi.fn(async () => ({ ok: true as const, value: { state: queue.shift() } }));
  const loginStatus = vi.fn(async () => ({ ok: true as const, value: { state: queue.shift() } }));
  const order: string[] = [];
  const stop = vi.fn(async (name: string) => {
    order.push(`stop:${name}`);
    return { ok: true as const, value: {} };
  });
  const start = vi.fn(async (name: string) => {
    order.push(`start:${name}`);
    return { ok: true as const, value: {} };
  });
  const list = vi.fn(async () => {
    order.push("list");
    return { ok: true as const, value: { bots: rows } };
  });
  return {
    loginStart,
    loginStatus,
    stop,
    start,
    list,
    order,
    deps: {
      sessions: { loginStart, loginStatus },
      bots: { list, start, stop },
      sleep: async () => {},
    },
  };
}

describe("runtime sign-in helpers", () => {
  it("only an expired report counts, grouped by the reported runtime", () => {
    const rows = [
      bot({ name: "a", runtimeSignIn: expired("claude") }),
      bot({ name: "b", runtimeSignIn: null }),
      bot({ name: "c", runtime: "codex", runtimeSignIn: expired("codex") }),
      bot({ name: "d" }),
    ];
    expect(botNeedsSignIn(rows[0])).toBe(true);
    expect(botNeedsSignIn(rows[1])).toBe(false);
    expect(botsNeedingSignIn(rows, "claude").map((b) => b.name)).toEqual(["a"]);
    expect(runtimesNeedingSignIn(rows)).toEqual(["claude", "codex"]);
  });

  it("names the tool and the bot in plain words", () => {
    const copy = signInAgainCopy(bot({ name: "scout", runtime: "codex", runtimeSignIn: expired("codex") }));
    expect(copy.lead).toBe("Codex needs you to sign in again before scout can keep working.");
    expect(copy.action).toBe("Sign in to Codex");
    expect(copy.waiting).toContain("scout will pick up where it left off");
  });
});

describe("signInAgain", () => {
  it("forces the vendor sign-in, waits for connected, then restarts only the affected bots", async () => {
    const rows = [
      bot({ name: "setup", runtimeSignIn: expired("claude") }),
      bot({ name: "fine", agentUid: "agt_fine" }),
      bot({ name: "other", agentUid: "agt_other", runtime: "codex", runtimeSignIn: expired("codex") }),
    ];
    const t = deps(["waiting", "waiting", "connected"], rows);
    const onwaiting = vi.fn();
    const result = await signInAgain("claude", { ...t.deps, onwaiting });

    expect(t.loginStart).toHaveBeenCalledWith("claude", { force: true });
    expect(t.loginStatus).toHaveBeenCalledTimes(2);
    expect(onwaiting).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, restarted: ["setup"], restartFailed: [] });
    expect(t.order).toEqual(["list", "stop:setup", "start:setup"]);
  });

  it("never touches bots when the sign-in ends in an error", async () => {
    const t = deps(["waiting", "error"], [bot({ runtimeSignIn: expired("claude") })]);
    const result = await signInAgain("claude", t.deps);
    expect(result.ok).toBe(false);
    expect(t.list).not.toHaveBeenCalled();
    expect(t.stop).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });

  it("treats a sign-in that ends signed out as not finished", async () => {
    const t = deps(["waiting", "disconnected"], [bot({ runtimeSignIn: expired("claude") })]);
    const result = await signInAgain("claude", t.deps);
    expect(result).toEqual({ ok: false, reason: "Signing in to Claude Code did not finish. Try again." });
    expect(t.start).not.toHaveBeenCalled();
  });

  it("gives up after the timeout without restarting anything", async () => {
    const t = deps(Array(50).fill("waiting"), [bot({ runtimeSignIn: expired("claude") })]);
    let clock = 0;
    const result = await signInAgain("claude", {
      ...t.deps,
      timeoutMs: 3_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(t.start).not.toHaveBeenCalled();
  });

  it("stops quietly when the view goes away", async () => {
    const t = deps(["waiting", "waiting", "connected"], [bot({ runtimeSignIn: expired("claude") })]);
    const result = await signInAgain("claude", { ...t.deps, cancelled: () => true });
    expect(result).toEqual({ ok: false, reason: "", cancelled: true });
    expect(t.start).not.toHaveBeenCalled();
  });
});
