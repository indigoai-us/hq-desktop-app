// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { palettePaintedProbe } from "./perf/palette-probe.mjs";

const ROWS = '[data-testid="command-palette"] [role="option"]';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/**
 * Drives the probe's key timeout with a fake timer and a scripted
 * `performance.now()`, so the elapsed time the probe reads when the timer
 * fires is exact rather than whatever the host clock gives.
 */
async function keyTimeoutSample(armedAt: number, firedAt: number, keyTimeoutMs: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(armedAt);
  const probe = palettePaintedProbe(ROWS, { readyTimeoutMs: 40, keyTimeoutMs });
  now.mockReturnValue(firedAt);
  vi.advanceTimersByTime(keyTimeoutMs);
  return probe;
}

function pressCmdK() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

describe("palette probe", () => {
  it("counts a palette that never paints as the timeout, not as no sample", async () => {
    const probe = palettePaintedProbe(ROWS, { readyTimeoutMs: 40, keyTimeoutMs: 1000 });
    pressCmdK();
    const ms = await probe;
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(40);
  });

  it("counts a missing keydown as the key timeout, not as no sample", async () => {
    const ms = await palettePaintedProbe(ROWS, { readyTimeoutMs: 40, keyTimeoutMs: 60 });
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(60);
  });

  it("never reports a key timeout below the timeout when the timer fires early", async () => {
    // Node and browsers can run a setTimeout callback a fraction of a
    // millisecond before performance.now() shows the full delay.
    const ms = await keyTimeoutSample(1000, 1059.52, 60);
    expect(ms).toBeGreaterThanOrEqual(60);
  });

  it("reports the measured time when the key timeout fires late", async () => {
    const ms = await keyTimeoutSample(1000, 1075.25, 60);
    expect(ms).toBeCloseTo(75.25, 6);
  });
});
