// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { palettePaintedProbe } from "./perf/palette-probe.mjs";

const ROWS = '[data-testid="command-palette"] [role="option"]';

afterEach(() => {
  document.body.innerHTML = "";
});

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
});
