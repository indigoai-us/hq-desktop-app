import { describe, expect, it } from "vitest";

import {
  AGENT_CATCHING_UP_POLL_MS,
  AGENT_CHAT_READY_POLL_MS,
  AGENT_READINESS_MAX_BACKOFF_MS,
  nextReadinessPollMs,
  readinessReadDenied,
} from "./agent-readiness-poll.js";

/** B-10: the readiness poll asked every 5 s for ever, whatever came back. */

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

  it("stops when the setup failed", () => {
    expect(nextReadinessPollMs(status(false, false, true), 0)).toBeNull();
    expect(nextReadinessPollMs(status(false, true, true), 0)).toBeNull();
  });

  it("stops when the server refuses the read or does not know the bot", () => {
    expect(nextReadinessPollMs({ kind: "denied" }, 1)).toBeNull();
    expect(nextReadinessPollMs({ kind: "denied" }, 9)).toBeNull();
  });

  it("waits longer each time a read fails in a row, up to five minutes", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 50].map((n) => nextReadinessPollMs({ kind: "failed" }, n));
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(AGENT_READINESS_MAX_BACKOFF_MS).toBe(300_000);
    // A count that makes no sense is the first failure.
    expect(nextReadinessPollMs({ kind: "failed" }, 0)).toBe(10_000);
    expect(nextReadinessPollMs({ kind: "failed" }, Number.NaN)).toBe(10_000);
    // In an hour of failures: under 20 reads, where the fixed timer made 720.
    let elapsed = 0;
    let reads = 0;
    for (let n = 1; elapsed < 3_600_000; n += 1) {
      elapsed += nextReadinessPollMs({ kind: "failed" }, n)!;
      reads += 1;
    }
    expect(reads).toBeLessThan(20);
  });
});

describe("readinessReadDenied", () => {
  it("is true for a 401, 403 or 404, by status or by code", () => {
    for (const failure of [
      { ok: false, status: 403 },
      { ok: false, status: 404 },
      { ok: false, status: 401 },
      { ok: false, reason: "error", code: "http-403" },
      { ok: false, reason: "error", code: "HTTP-404 " },
      { ok: false, reason: "error", code: "http-401" },
    ]) {
      expect(readinessReadDenied(failure), JSON.stringify(failure)).toBe(true);
    }
  });

  it("is false for anything else", () => {
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
    }
  });
});
