import { describe, expect, it } from "vitest";

import {
  applyWakingStatus,
  beginWakingSession,
  recordWakingCheckFailure,
  resumeWakingSession,
  US001_MEDIAN_WAKING_ESTIMATE_MS,
  WAKING_ESTIMATE_MS,
  wakingStatusLine,
} from "./waking-model";

const STARTED = 1_700_000_000_000;

function session() {
  return beginWakingSession({
    agentUid: "agt_nova",
    channelId: "chn_nova",
    companyUid: "cmp_acme",
    name: "Nova",
    now: STARTED,
  });
}

describe("waking model", () => {
  it("never counts down from US-001's median, which was mostly people waiting", () => {
    // Regression (owner walkthrough 2026-10-02): a bot that reached its
    // approval step in 49 seconds showed "About 21 minutes left."
    expect(US001_MEDIAN_WAKING_ESTIMATE_MS).toBe(1_244_000);
    expect(WAKING_ESTIMATE_MS).toBeLessThanOrEqual(180_000);
    expect(wakingStatusLine(session(), STARTED)).toBe("About 2 minutes left.");
    expect(wakingStatusLine(session(), STARTED + 70_000)).toBe("About a minute left.");
  });

  it("stops the clock while the bot waits on the person's approval", () => {
    const pairing = { url: "https://auth.openai.com/codex/device", code: "TEST-CODE" };
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: { phase: "waiting" }, pairing }, STARTED + 50_000);
    const stillAsked = applyWakingStatus(asked, { agent: { provider: "codex" }, setupState: { phase: "waiting" }, pairing }, STARTED + 650_000);
    // Ten minutes of the person being away moves nothing.
    expect(stillAsked.progress).toBe(asked.progress);
    expect(wakingStatusLine(stillAsked, STARTED + 650_000)).toBe("One thing from you.");

    const approved = applyWakingStatus(stillAsked, { setupState: { phase: "sync" } }, STARTED + 660_000);
    expect(approved.approval).toBeNull();
    expect(approved.approvalSince).toBeNull();
    // 50 seconds of machine work before the ask; the 610-second wait is removed.
    expect(wakingStatusLine(approved, STARTED + 660_000)).toBe("About 2 minutes left.");
    expect(wakingStatusLine(approved, STARTED + 680_000)).toBe("About a minute left.");
    expect(wakingStatusLine(approved, STARTED + 660_000)).not.toMatch(/taking longer/i);
    expect(approved.progress).toBeGreaterThanOrEqual(asked.progress);
  });

  it("lets fixtures set their own estimate", () => {
    const fixture = beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova", now: STARTED, estimateMs: 10_000 });
    expect(wakingStatusLine(fixture, STARTED + 9_999)).not.toMatch(/taking longer/i);
    expect(wakingStatusLine(fixture, STARTED + 10_001)).toMatch(/taking longer/i);
  });

  it("keeps server setup labels out of the person-facing estimate", () => {
    const next = applyWakingStatus(session(), { setupState: { phase: "runtime" } }, STARTED + 10_000);
    expect(wakingStatusLine(next, STARTED + 10_000)).toMatch(/about/i);
    expect(wakingStatusLine(next, STARTED + 10_000)).not.toMatch(/identity|membership|vault|runtime|sync|channels|audit/i);
  });

  it("shows reconnecting only after three consecutive status failures", () => {
    const once = recordWakingCheckFailure(session(), STARTED + 1_000);
    const twice = recordWakingCheckFailure(once, STARTED + 2_000);
    const three = recordWakingCheckFailure(twice, STARTED + 3_000);
    expect(wakingStatusLine(twice, STARTED + 3_000)).not.toMatch(/reconnecting/i);
    expect(wakingStatusLine(three, STARTED + 3_000)).toMatch(/reconnecting/i);
  });

  it("uses the long-running and failure copy without exposing a server reason", () => {
    expect(wakingStatusLine(session(), STARTED + WAKING_ESTIMATE_MS + 1)).toMatch(/taking longer than usual/i);
    const failed = applyWakingStatus(session(), { setupState: { phase: "failed", reason: "audit failed" } });
    expect(wakingStatusLine(failed)).toBe("We couldn't start this bot.");
  });

  it("marks the ring complete only after the status says ready", () => {
    const waiting = applyWakingStatus(session(), { setupState: { phase: "creating" } }, STARTED + 20_000);
    const ready = applyWakingStatus(waiting, { setupState: { phase: "ready" } }, STARTED + 30_000);
    expect(waiting.progress).toBeLessThan(100);
    expect(ready.progress).toBe(100);
  });

  it("shows an approval only while the server returns a current pairing", () => {
    const pending = applyWakingStatus(session(), {
      agent: { provider: "grok" },
      setupState: { phase: "creating" },
      pairing: { url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(wakingStatusLine(pending)).toBe("One thing from you.");
    expect(pending.approval).toMatchObject({ provider: "grok" });

    const complete = applyWakingStatus(pending, { setupState: { phase: "ready" } });
    expect(complete.approval).toBeNull();
  });

  it("resumes the exact same bot after retrying", () => {
    const retried = resumeWakingSession({ ...session(), phase: "failed" }, STARTED + 10_000);
    expect(retried).toMatchObject({ agentUid: "agt_nova", channelId: "chn_nova", phase: "waking", consecutiveCheckFailures: 0 });
  });
});
