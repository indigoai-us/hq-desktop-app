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
  it("never counts down from US-001's median, which was mostly waiting", () => {
    // Regression (owner walkthrough 2026-10-02): the screen opened with
    // "About 21 minutes left."
    expect(US001_MEDIAN_WAKING_ESTIMATE_MS).toBe(1_244_000);
    expect(WAKING_ESTIMATE_MS).toBeLessThanOrEqual(180_000);
    expect(wakingStatusLine(session(), STARTED)).toBe("Starting up. About 3 minutes left.");
    expect(wakingStatusLine(session(), STARTED + 130_000)).toBe("Starting up. About a minute left.");
  });

  const CODEX_PAIRING = { url: "https://auth.openai.com/codex/device", code: "TEST-CODE" };
  const signInStep = (status: string) => ({ phase: "waiting", steps: [{ name: "runtime", status: "done" }, { name: "codex-auth", status }] });

  it("keeps the approval on screen when a status read comes back without the code", () => {
    // Regression (owner walkthrough 2026-10-02): the approval left the screen
    // before the sign-in was finished. The server reads the code on a
    // best-effort basis and answers pairing: null when that read fails.
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 150_000);
    const emptyRead = applyWakingStatus(asked, { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: null }, STARTED + 153_000);
    expect(emptyRead.approval).toMatchObject({ provider: "codex", code: "TEST-CODE" });
    expect(wakingStatusLine(emptyRead, STARTED + 153_000)).toBe("One thing from you.");
    expect(emptyRead.signedInAt ?? null).toBeNull();
  });

  it("says the sign-in worked and starts a fresh estimate for the rest", () => {
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 150_000);
    // Ten minutes of the person being away moves nothing.
    const stillAsked = applyWakingStatus(asked, { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 750_000);
    expect(stillAsked.progress).toBe(asked.progress);

    const signedIn = applyWakingStatus(stillAsked, { setupState: signInStep("done"), pairing: null }, STARTED + 760_000);
    expect(signedIn.approval).toBeNull();
    expect(signedIn.signedInAt).toBe(STARTED + 760_000);
    expect(wakingStatusLine(signedIn, STARTED + 760_000)).toBe("You're signed in. Finishing up. About 2 minutes left.");
    expect(wakingStatusLine(signedIn, STARTED + 830_000)).toBe("You're signed in. Finishing up. About a minute left.");
    expect(wakingStatusLine(signedIn, STARTED + 760_000)).not.toMatch(/taking longer/i);
    expect(signedIn.progress).toBeGreaterThan(stillAsked.progress);
    expect(signedIn.progress).toBeLessThan(100);
  });

  it("does not claim a sign-in the person never did", () => {
    const signedIn = applyWakingStatus(session(), { setupState: signInStep("done") }, STARTED + 140_000);
    expect(wakingStatusLine(signedIn, STARTED + 140_000)).toBe("Finishing up. About 2 minutes left.");
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
