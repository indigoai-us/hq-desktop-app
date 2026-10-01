import { describe, expect, it } from "vitest";

import {
  applyWakingStatus,
  beginWakingSession,
  recordWakingCheckFailure,
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
});
