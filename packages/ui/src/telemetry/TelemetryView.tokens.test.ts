// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";
import { snapshotFromMe } from "./telemetry-me.js";
import { type TelemetrySnapshot } from "./telemetry-model.js";
import { compactNumber as formatTokens } from "../common/compact-number.js";

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
      unattributed: { tokens: familyTokens * 3, note: "Includes 1 model not shown above: gpt-6-sol." },
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

  it("renders Fable, System and unknown models as rows with an honest note (QA-085)", async () => {
    const t = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    const snapshot = snapshotFromMe(
      {
        from: "2026-09-03",
        to: "2026-10-02",
        daily: [],
        totals: {
          distinctSessions: 3,
          tokensByModel: { "claude-fable-5-1": t(3000), "claude-opus-5-5": t(1000), "<synthetic>": t(200), "mystery-9": t(100) },
          tokens: t(4500),
        },
      },
      "30d",
    );
    const target = await openTokens({ ...snapshot, endDate: undefined });
    const names = [...target.querySelectorAll(".trow .nm")].map((el) => el.textContent ?? "");
    expect(names[0]).toContain("Fable");
    expect(names[1]).toContain("Opus");
    expect(names[2]).toContain("System");
    expect(names[2]).toContain("Tokens from HQ's own background tasks");
    expect(names[3]).toContain("mystery-9");
    expect(target.querySelector("[data-testid='telemetry-model-other']")?.textContent).toContain(formatTokens(200));
    const note = target.querySelector("[data-testid='telemetry-model-other-note']")?.textContent ?? "";
    expect(note).toBe("200 tokens were recorded without a model.");
    expect(target.textContent).not.toContain("non-Claude");
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

describe("Telemetry daily chart stacks every By-model row (QA-086)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  it("draws Fable, System, unknown and Other bands that add up to the headline", async () => {
    const t = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    const snapshot = snapshotFromMe(
      {
        from: "2026-10-01",
        to: "2026-10-02",
        daily: [
          { date: "2026-10-01", tokensByModel: { "claude-fable-5-1": t(2000), "<synthetic>": t(100) }, tokens: t(2150) },
          { date: "2026-10-02", tokensByModel: { "claude-fable-5-1": t(1000), "claude-opus-5-5": t(1000), "mystery-9": t(100), "<synthetic>": t(100) }, tokens: t(2350) },
        ],
        totals: {
          distinctSessions: 2,
          tokensByModel: { "claude-fable-5-1": t(3000), "claude-opus-5-5": t(1000), "<synthetic>": t(200), "mystery-9": t(100) },
          tokens: t(4500),
        },
      },
      "7d",
    );
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

    const legend = target.querySelector("[data-testid='telemetry-legend']")?.textContent;
    expect(legend).toBe("FableOpusSystemmystery-9Other");
    const bands = [...target.querySelectorAll("[data-testid='telemetry-bars'] [data-band]")];
    const sum = bands.reduce((n, el) => n + Number(el.getAttribute("data-tokens")), 0);
    expect(sum).toBe(4500);
    const byBand = (name: string) =>
      bands.filter((el) => el.getAttribute("data-band") === name).reduce((n, el) => n + Number(el.getAttribute("data-tokens")), 0);
    expect(byBand("Fable")).toBe(3000);
    expect(byBand("System")).toBe(200);
    expect(byBand("mystery-9")).toBe(100);
    expect(byBand("Other")).toBe(200);
    const days = [...target.querySelectorAll("[data-testid='telemetry-bars'] .d")];
    expect(days[0]?.getAttribute("title")).toMatch(/^Oct 1: 2.15K tokens · Fable 2K · System 100 · Other 50$/);
  });
});
