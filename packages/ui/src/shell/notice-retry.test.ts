import { describe, expect, it } from "vitest";

import {
  NOTICE_MAX_ATTEMPTS,
  NOTICE_RETRY_BASE_MS,
  noteNoticeFailure,
  noteNoticeSent,
  noticeFailurePermanent,
  noticeMaySend,
  type NoticeLedger,
} from "./notice-retry.js";

/** B-12: a notice that failed to send was retried on every recompute, for ever. */

describe("the retry ledger for hidden notices to a bot", () => {
  it("lets a notice that never failed go at once", () => {
    const ledger: NoticeLedger = new Map();
    expect(noticeMaySend(ledger, "agt_nova:acct_linear", 1_000)).toBe(true);
  });

  it("never repeats a send the server refused for good", () => {
    const ledger: NoticeLedger = new Map();
    expect(noteNoticeFailure(ledger, "k", 1_000, true)).toEqual({ attempts: 1, nextAt: null });
    expect(noticeMaySend(ledger, "k", 1_001)).toBe(false);
    expect(noticeMaySend(ledger, "k", 1_000 + 86_400_000)).toBe(false);
    // Another notice is not held back by it.
    expect(noticeMaySend(ledger, "other", 1_001)).toBe(true);
  });

  it("retries other failures further apart each time, then stops", () => {
    expect(NOTICE_MAX_ATTEMPTS).toBe(4);
    expect(NOTICE_RETRY_BASE_MS).toBe(30_000);
    const ledger: NoticeLedger = new Map();
    let now = 0;
    const waits: Array<number | null> = [];
    for (let i = 0; i < NOTICE_MAX_ATTEMPTS; i += 1) {
      expect(noticeMaySend(ledger, "k", now), `attempt ${i + 1}`).toBe(true);
      const entry = noteNoticeFailure(ledger, "k", now, false);
      waits.push(entry.nextAt === null ? null : entry.nextAt - now);
      if (entry.nextAt !== null) {
        // Not a moment before its wait is over.
        expect(noticeMaySend(ledger, "k", entry.nextAt - 1)).toBe(false);
        now = entry.nextAt;
      }
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, null]);
    expect(noticeMaySend(ledger, "k", now + 86_400_000)).toBe(false);
  });

  it("forgets the failures once the notice went out", () => {
    const ledger: NoticeLedger = new Map();
    noteNoticeFailure(ledger, "k", 0, false);
    noteNoticeSent(ledger, "k");
    expect(ledger.size).toBe(0);
    expect(noticeMaySend(ledger, "k", 1)).toBe(true);
  });

  it("reads a 4xx as permanent, except a timeout and a rate limit", () => {
    for (const failure of [
      { ok: false, status: 400 },
      { ok: false, status: 403 },
      { ok: false, status: 404 },
      { ok: false, status: 422 },
      { ok: false, reason: "error", code: "http-403" },
      { ok: false, reason: "error", code: " HTTP-410 " },
    ]) {
      expect(noticeFailurePermanent(failure), JSON.stringify(failure)).toBe(true);
    }
    for (const other of [
      { ok: false, status: 408 },
      { ok: false, status: 429 },
      { ok: false, status: 500 },
      { ok: false, status: 503 },
      { ok: false, reason: "error", code: "http-502" },
      { ok: false, reason: "error", code: "http-429" },
      { ok: false, reason: "unavailable" },
      { ok: false, code: "SOMETHING_ELSE" },
      { ok: true, value: {} },
      null,
      undefined,
      "http-403",
    ]) {
      expect(noticeFailurePermanent(other), JSON.stringify(other)).toBe(false);
    }
  });
});
