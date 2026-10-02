// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";
import { formatTokens, type TelemetrySnapshot } from "./telemetry-model.js";

describe("Telemetry Tokens page (QA-081)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  async function openTokens(snapshot: TelemetrySnapshot): Promise<HTMLElement> {
    const cache = createTelemetryCache({ fallback: snapshot, fetcher: async () => snapshot });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const tab = [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Tokens");
    (tab as HTMLButtonElement).click();
    flushSync();
    return target;
  }

  it("shows an Other / unattributed row and a total that includes it", async () => {
    const familyTokens = TELEMETRY_SMOKE.models.reduce(
      (n, m) => n + m.input + m.output + m.cacheWrite + m.cacheRead,
      0,
    );
    const snapshot: TelemetrySnapshot = {
      ...TELEMETRY_SMOKE,
      endDate: undefined,
      unattributed: { tokens: familyTokens * 3, note: "Other covers non-Claude models (gpt-6-sol)." },
    };
    const target = await openTokens(snapshot);
    const other = target.querySelector("[data-testid='telemetry-model-other']");
    expect(other?.textContent).toContain("Other / unattributed");
    expect(other?.textContent).toContain("75%");
    expect(target.querySelector("[data-testid='telemetry-model-total']")?.textContent).toContain(
      formatTokens(familyTokens * 4),
    );
    expect(target.querySelector("[data-testid='telemetry-model-other-note']")?.textContent).toContain("gpt-6-sol");
  });

  it("Company and Actor tabs show an unavailable state and hide the model chart", async () => {
    const target = await openTokens({ ...TELEMETRY_SMOKE, endDate: undefined });
    expect(target.querySelector("[data-testid='telemetry-bars']")).not.toBeNull();
    for (const name of ["Company", "Actor"]) {
      const tab = [...target.querySelectorAll("[role='tab']")].find((b) => b.textContent === name);
      (tab as HTMLButtonElement).click();
      flushSync();
      expect(target.querySelector("[data-testid='telemetry-bars']")).toBeNull();
      expect(target.querySelector("[data-testid='telemetry-stack-unavailable']")?.textContent).toContain(
        `${name} breakdown isn't available yet`,
      );
      expect(target.textContent).not.toContain("OpusSonnetHaiku");
    }
  });
});
