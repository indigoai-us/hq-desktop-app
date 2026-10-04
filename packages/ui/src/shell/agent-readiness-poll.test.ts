import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CATCHING_UP_POLL_MS,
  AGENT_CHAT_READY_POLL_MS,
  AGENT_READINESS_MAX_BACKOFF_MS,
  AGENT_READINESS_SLOW_POLL_MS,
  nextReadinessPollMs,
  readinessFailureRead,
  readinessReadDenied,
  readinessReadSignedOut,
  startReadinessPoll,
  type ReadinessRead,
} from "./agent-readiness-poll.js";
import { agentChatReadiness } from "../chat/agent-channel.js";

/**
 * B-10: the readiness poll asked every 5 s for ever, whatever came back.
 * B-10 follow-up: it then stopped for good on a failed setup and on a 401,
 * and nothing started it again, so the composer stayed locked after a retry
 * of the setup or one refused sign-in during a token refresh.
 */

const status = (chatReady: boolean, catchingUp: boolean, failed: boolean) =>
  ({ kind: "status", readiness: { chatReady, catchingUp, failed } }) as const;

describe("nextReadinessPollMs", () => {
  it("keeps the 5 s timer while the bot cannot chat yet, and the slow one while its files arrive", () => {
    expect(AGENT_CHAT_READY_POLL_MS).toBe(5_000);
    expect(AGENT_CATCHING_UP_POLL_MS).toBe(30_000);
    expect(nextReadinessPollMs(status(false, false, false), 0)).toBe(5_000);
    expect(nextReadinessPollMs(status(true, true, false), 0)).toBe(30_000);
  });

  it("stops when the bot is fully ready", () => {
    expect(nextReadinessPollMs(status(true, false, false), 0)).toBeNull();
  });

  it("goes on once a minute when the setup failed, because a retried setup moves again", () => {
    expect(AGENT_READINESS_SLOW_POLL_MS).toBe(60_000);
    expect(nextReadinessPollMs(status(false, false, true), 0)).toBe(60_000);
    expect(nextReadinessPollMs(status(false, true, true), 0)).toBe(60_000);
    // Every wording the readiness reads as failed.
    for (const phase of ["failed", "error", "blocked", "cancelled"]) {
      const readiness = agentChatReadiness({ setupState: { phase } });
      expect(readiness.failed, phase).toBe(true);
      expect(nextReadinessPollMs({ kind: "status", readiness }, 0), phase).toBe(60_000);
    }
  });

  it("goes on once a minute after a 401, whatever came before", () => {
    expect(nextReadinessPollMs({ kind: "signed-out" }, 0)).toBe(60_000);
    expect(nextReadinessPollMs({ kind: "signed-out" }, 9)).toBe(60_000);
  });

  it("stops for a bot that is being removed, whatever else its status says", () => {
    // The waiting screen stops for these phases (review A-I4). This poll
    // used to go on every 5 s until the server answered 404.
    for (const phase of ["deprovisioning", "deprovisioned"]) {
      const notReady = agentChatReadiness({ setupState: { phase } });
      expect(notReady.chatReady).toBe(false);
      expect(nextReadinessPollMs({ kind: "status", readiness: notReady }, 0)).toBeNull();
      // It could chat before it was removed, and its files never finished arriving.
      const wasChatting = agentChatReadiness({ agent: { runtime: {} }, setupState: { phase, chatReady: true } });
      expect(wasChatting).toMatchObject({ chatReady: true, catchingUp: true });
      expect(nextReadinessPollMs({ kind: "status", readiness: wasChatting }, 0)).toBeNull();
    }
    expect(nextReadinessPollMs({ kind: "status", readiness: { chatReady: false, catchingUp: false, failed: false, removing: true } }, 0)).toBeNull();
    // Removal wins over a failed setup: that one is not read again.
    expect(nextReadinessPollMs({ kind: "status", readiness: { chatReady: false, catchingUp: false, failed: true, removing: true } }, 0)).toBeNull();
    // A bot that is still setting up is asked about again.
    expect(nextReadinessPollMs({ kind: "status", readiness: agentChatReadiness({ setupState: { phase: "provisioning" } }) }, 0)).toBe(5_000);
  });

  it("stops when the server refuses the read for this person or does not know the bot", () => {
    expect(nextReadinessPollMs({ kind: "denied" }, 1)).toBeNull();
    expect(nextReadinessPollMs({ kind: "denied" }, 9)).toBeNull();
  });

  it("waits longer each time a read fails in a row, and never more than a minute", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 50].map((n) => nextReadinessPollMs({ kind: "failed" }, n));
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(AGENT_READINESS_MAX_BACKOFF_MS).toBe(60_000);
    // A count that makes no sense is the first failure.
    expect(nextReadinessPollMs({ kind: "failed" }, 0)).toBe(10_000);
    expect(nextReadinessPollMs({ kind: "failed" }, Number.NaN)).toBe(10_000);
    // In an hour of failures: about one read a minute, where the fixed timer made 720.
    let elapsed = 0;
    let reads = 0;
    for (let n = 1; elapsed < 3_600_000; n += 1) {
      elapsed += nextReadinessPollMs({ kind: "failed" }, n)!;
      reads += 1;
    }
    expect(reads).toBeLessThan(70);
  });
});

describe("what a read that did not succeed came back with", () => {
  it("reads a 403 or a 404 as final, by status or by code", () => {
    for (const failure of [
      { ok: false, status: 403 },
      { ok: false, status: 404 },
      { ok: false, reason: "error", code: "http-403" },
      { ok: false, reason: "error", code: "HTTP-404 " },
    ]) {
      expect(readinessReadDenied(failure), JSON.stringify(failure)).toBe(true);
      expect(readinessReadSignedOut(failure), JSON.stringify(failure)).toBe(false);
      expect(readinessFailureRead(failure), JSON.stringify(failure)).toEqual({ kind: "denied" });
    }
  });

  it("reads a 401 as a sign-in that may mend, never as final", () => {
    for (const failure of [
      { ok: false, status: 401 },
      { ok: false, reason: "error", code: "http-401" },
      { ok: false, reason: "error", code: " HTTP-401" },
    ]) {
      expect(readinessReadDenied(failure), JSON.stringify(failure)).toBe(false);
      expect(readinessReadSignedOut(failure), JSON.stringify(failure)).toBe(true);
      expect(readinessFailureRead(failure), JSON.stringify(failure)).toEqual({ kind: "signed-out" });
    }
  });

  it("reads anything else as a failed read", () => {
    for (const other of [
      { ok: true, value: {} },
      { ok: false, status: 500 },
      { ok: false, reason: "error", code: "http-502" },
      { ok: false, reason: "unavailable" },
      { ok: false, code: "CREATE_AGENTS_NOT_ALLOWED" },
      null,
      undefined,
      "http-403",
      [],
    ]) {
      expect(readinessReadDenied(other), JSON.stringify(other)).toBe(false);
      expect(readinessReadSignedOut(other), JSON.stringify(other)).toBe(false);
      expect(readinessFailureRead(other), JSON.stringify(other)).toEqual({ kind: "failed" });
    }
  });
});

describe("startReadinessPoll", () => {
  const NOT_READY: ReadinessRead = { kind: "status", readiness: { chatReady: false, catchingUp: false, failed: false } };
  const READY: ReadinessRead = { kind: "status", readiness: { chatReady: true, catchingUp: false, failed: false } };
  const SETUP_FAILED: ReadinessRead = { kind: "status", readiness: { chatReady: false, catchingUp: false, failed: true } };
  const REMOVING: ReadinessRead = { kind: "status", readiness: { chatReady: false, catchingUp: false, failed: false, removing: true } };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the read in flight settle, without moving the clock. */
  async function settled(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  function reads(...answers: Array<ReadinessRead | Error>) {
    const last = answers[answers.length - 1]!;
    let n = 0;
    return vi.fn(async (): Promise<ReadinessRead> => {
      const answer = n < answers.length ? answers[n]! : last;
      n += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }

  it("reads at once, every 5 s while the bot cannot chat, and stops when it can", async () => {
    const readOnce = reads(NOT_READY, NOT_READY, READY);
    startReadinessPoll(readOnce, { onlineTarget: null });
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(readOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readOnce).toHaveBeenCalledTimes(3);

    // Ready: nothing more is read.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(readOnce).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reading a failed setup once a minute, and picks up the bot when a retry gets it going", async () => {
    const readOnce = reads(SETUP_FAILED, SETUP_FAILED, NOT_READY, READY);
    startReadinessPoll(readOnce, { onlineTarget: null });
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(readOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readOnce).toHaveBeenCalledTimes(2);
    // The setup was retried: the next read finds it moving, and the usual timer is back.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readOnce).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readOnce).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reading once a minute after a 401, and goes on as usual when the sign-in is back", async () => {
    const readOnce = reads({ kind: "signed-out" }, NOT_READY, READY);
    startReadinessPoll(readOnce, { onlineTarget: null });
    await settled();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(readOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readOnce).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a read the server refuses for this person or a bot it does not know", { kind: "denied" } as ReadinessRead],
    ["a bot that is being removed", REMOVING],
  ])("stops for good on %s", async (_name, final) => {
    const target = new EventTarget();
    const readOnce = reads(final);
    startReadinessPoll(readOnce, { onlineTarget: target });
    await settled();

    await vi.advanceTimersByTimeAsync(3_600_000);
    target.dispatchEvent(new Event("online"));
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits longer after each failed read, a thrown one included, up to a minute", async () => {
    const readOnce = reads({ kind: "failed" }, new Error("offline"), { kind: "failed" }, { kind: "failed" }, { kind: "failed" });
    startReadinessPoll(readOnce, { onlineTarget: null });
    await settled();

    const gaps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const before = readOnce.mock.calls.length;
      let waited = 0;
      while (readOnce.mock.calls.length === before && waited < 400_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1_000;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it("reads at once when the connection comes back, and starts the back-off over", async () => {
    const target = new EventTarget();
    const readOnce = reads({ kind: "failed" }, { kind: "failed" }, { kind: "failed" }, { kind: "failed" }, NOT_READY);
    startReadinessPoll(readOnce, { onlineTarget: target });
    await settled();
    await vi.advanceTimersByTimeAsync(10_000 + 20_000);
    expect(readOnce).toHaveBeenCalledTimes(3);

    // 40 s to the next read. The connection comes back after 5.
    await vi.advanceTimersByTimeAsync(5_000);
    target.dispatchEvent(new Event("online"));
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(4);

    // That read failed too: it is the first failure again, 10 s and not 60.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(readOnce).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(readOnce).toHaveBeenCalledTimes(5);
    // Only one timer runs at a time.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not read twice when the connection comes back in the middle of a read", async () => {
    const target = new EventTarget();
    let finish!: (read: ReadinessRead) => void;
    const readOnce = vi.fn(() => new Promise<ReadinessRead>((resolve) => { finish = resolve; }));
    startReadinessPoll(readOnce, { onlineTarget: target });

    target.dispatchEvent(new Event("online"));
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(1);
    finish(READY);
    await settled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads nothing more once it is stopped, and stops hearing the connection", async () => {
    const target = new EventTarget();
    const readOnce = reads(NOT_READY);
    const stop = startReadinessPoll(readOnce, { onlineTarget: target });
    await settled();
    expect(readOnce).toHaveBeenCalledTimes(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    target.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(readOnce).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing when it is stopped while a read is out", async () => {
    let finish!: (read: ReadinessRead) => void;
    const readOnce = vi.fn(() => new Promise<ReadinessRead>((resolve) => { finish = resolve; }));
    const stop = startReadinessPoll(readOnce, { onlineTarget: null });
    stop();
    finish(NOT_READY);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(readOnce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
