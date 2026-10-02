// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewBotDawn, { dawnNoise, dawnSunRow } from "./NewBotDawn.svelte";

let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.replaceChildren();
});

describe("NewBotDawn", () => {
  it("stands in for a progress bar and survives a host with no canvas support", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NewBotDawn, {
      target: host,
      props: { progress: 140, mode: "waiting", label: "Waking up Polar" },
    });
    await tick();
    const bar = host.querySelector("[role='progressbar']")!;
    expect(bar.getAttribute("aria-label")).toBe("Waking up Polar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("data-mode")).toBe("waiting");
    expect(bar.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("raises the sun with progress and never past its resting place", () => {
    const horizon = 14;
    const radius = 7;
    const low = dawnSunRow(0, horizon, radius);
    const mid = dawnSunRow(0.5, horizon, radius);
    const high = dawnSunRow(1, horizon, radius);
    // Smaller row = higher on screen.
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
    // At the start the crown already clears the horizon; at the end the whole disc does.
    expect(low - radius).toBeLessThan(horizon);
    expect(high + radius).toBeLessThan(horizon);
    expect(dawnSunRow(5, horizon, radius)).toBe(high);
    expect(dawnSunRow(-1, horizon, radius)).toBe(low);
  });

  it("gives every cell stable noise in [0, 1)", () => {
    for (let x = 0; x < 40; x += 7) {
      for (let y = 0; y < 20; y += 3) {
        const n = dawnNoise(x, y);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1);
        expect(dawnNoise(x, y)).toBe(n);
      }
    }
  });
});
