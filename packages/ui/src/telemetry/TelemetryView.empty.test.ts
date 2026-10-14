// @vitest-environment happy-dom
// OWNER-D 3: with no activity yet, Telemetry shows one sentence that says what
// it shows and when numbers appear, in place of a dashboard of zeros.
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { createMyTelemetryFetcher } from "./telemetry-me.js";
import { TELEMETRY_EMPTY_COPY } from "./telemetry-model.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const zero = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

/** hq-pro GET /v1/telemetry/me for an account with nothing recorded yet. */
const EMPTY_ME = {
  optedOut: false,
  from: "2026-09-03",
  to: "2026-10-02",
  daily: [],
  totals: {
    events: 0,
    distinctSessions: 0,
    skills: {},
    commandsBySource: {},
    services: {},
    outcomes: {},
    tokensByModel: {},
    tokens: zero,
  },
};

describe("OWNER-D 3 Telemetry with no activity", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  async function mountWith(body: unknown): Promise<HTMLElement> {
    const fetcher = createMyTelemetryFetcher({ getMyTelemetry: async () => ok(body as never) }, () => NOW);
    const cache = createTelemetryCache({ fetcher });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
    return target;
  }

  it("shows one sentence and no zero tiles", async () => {
    const target = await mountWith(EMPTY_ME);
    expect(target.querySelector("[data-testid='telemetry-empty']")?.textContent).toBe(TELEMETRY_EMPTY_COPY);
    expect(target.querySelector(".statline")).toBeNull();
    expect(target.querySelector(".chart")).toBeNull();
    expect(TELEMETRY_EMPTY_COPY.split(/[.!?](\s|$)/).filter((s) => s.trim()).length).toBe(1);
  });

  it("keeps the dashboard once there is activity", async () => {
    const snapshot = { ...TELEMETRY_SMOKE, endDate: undefined };
    const cache = createTelemetryCache({ fallback: snapshot, fetcher: async () => snapshot });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(target.querySelector("[data-testid='telemetry-empty']")).toBeNull();
    expect(target.querySelector(".statline")).toBeTruthy();
  });
});
