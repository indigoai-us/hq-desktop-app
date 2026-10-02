// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import {
  MISSING_SESSION_ROWS,
  createMyTelemetryFetcher,
  modelFamily,
  rangeWindow,
  snapshotFromMe,
} from "./telemetry-me.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function tokens(input: number, output: number, cacheCreation: number, cacheRead: number) {
  return { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheCreation, cacheReadTokens: cacheRead };
}

/** Body shaped like hq-pro GET /v1/telemetry/me. */
function meBody(from: string, to: string, sessions: number) {
  return {
    optedOut: false,
    from,
    to,
    daily: [
      { date: from, events: 10, distinctSessions: 2, skills: {}, commandsBySource: {}, services: {}, outcomes: {},
        tokensByModel: { "claude-opus-5-5": tokens(100, 50, 0, 850) } },
      { date: to, events: 20, distinctSessions: sessions - 2, skills: {}, commandsBySource: {}, services: {}, outcomes: {},
        tokensByModel: { "claude-sonnet-5-5": tokens(1000, 0, 0, 0), "gpt-6-sol": tokens(500, 0, 0, 0) } },
    ],
    totals: {
      events: 30,
      distinctSessions: sessions,
      skills: { review: 3, deploy: 5, "": 9 },
      commandsBySource: {},
      services: {},
      outcomes: { "deploy-succeeded": 4, "story-completed": 6, "pr-merged": 2 },
      tokensByModel: {
        "claude-opus-5-5": tokens(100, 50, 0, 850),
        "claude-sonnet-5-5": tokens(1000, 0, 0, 0),
        "gpt-6-sol": tokens(500, 0, 0, 0),
      },
      tokens: tokens(1600, 50, 0, 850),
    },
  };
}

describe("My Telemetry from /v1/telemetry/me", () => {
  it("builds the request window from the range control", () => {
    expect(rangeWindow("7d", NOW)).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(rangeWindow("30d", NOW)).toEqual({ from: "2026-09-03", to: "2026-10-02" });
    expect(rangeWindow("90d", NOW).from).toBe("2026-07-05");
  });

  it("maps real totals and leaves unknown parts empty instead of inventing them", () => {
    const snap = snapshotFromMe(meBody("2026-09-03", "2026-10-02", 42), "30d");
    expect(snap.sessions).toBe(42);
    expect(snap.tokensLabel).toBe("3k");
    expect(snap.deploys).toBe(4);
    expect(snap.storiesShipped).toBe(6);
    expect(snap.distinctSkills).toBe(2);
    expect(snap.skills).toEqual([{ name: "deploy", count: 5 }, { name: "review", count: 3 }]);
    expect(snap.models.map((m) => m.model)).toEqual(["opus", "sonnet"]);
    expect(snap.modelMix).toBe("Opus 40% · Sonnet 40% · other 20%");
    expect(snap.days.map((d) => [d.opus, d.sonnet, d.haiku])).toEqual([[1000, 0, 0], [0, 1000, 0]]);
    expect(snap.rangeLabel).toBe("Sep 3 – Oct 2");
    expect(snap.cacheReadShare).toBe("34%");
    expect(snap.sessionsRows).toEqual([]);
    expect(snap.bots).toEqual([]);
    expect(snap.byCompany).toEqual([]);
    expect(snap.notice).toBe(MISSING_SESSION_ROWS);
  });

  it("prices only Claude models at list rate", () => {
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("grok-4.7-build")).toBeNull();
  });

  it("asks the transport for the selected range and reports a plain reason on failure", async () => {
    const getMyTelemetry = vi.fn(async (from: string, to: string) => ({ ok: true as const, value: meBody(from, to, 9) }));
    const fetcher = createMyTelemetryFetcher({ getMyTelemetry }, () => NOW);
    await expect(fetcher("7d")).resolves.toMatchObject({ range: "7d", sessions: 9 });
    expect(getMyTelemetry).toHaveBeenCalledWith("2026-09-26", "2026-10-02");

    const failing = createMyTelemetryFetcher(
      { getMyTelemetry: async () => ({ ok: false as const, reason: "error" as const, code: "http-402", message: "personal-plan-required" }) },
      () => NOW,
    );
    await expect(failing("30d")).rejects.toMatchObject({ reason: expect.stringContaining("Individual plan") });
  });
});

describe("TelemetryView on the real source", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
  }

  it("paints a skeleton, then real numbers, and refetches when the range changes", async () => {
    const getMyTelemetry = vi.fn(async (from: string, to: string) => ({
      ok: true as const,
      value: meBody(from, to, from === "2026-09-26" ? 7 : 42),
    }));
    const cache = createTelemetryCache({ fetcher: createMyTelemetryFetcher({ getMyTelemetry }, () => NOW) });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    expect(target.querySelector("[data-testid='telemetry-skeleton']")).not.toBeNull();
    await settle();
    expect(target.querySelector(".stat .n")?.textContent).toContain("42");
    expect(target.textContent).not.toContain("128");
    expect(target.textContent).not.toContain("LiveRecover");
    expect(target.querySelector("[data-testid='telemetry-notice']")?.textContent).toContain("per-session telemetry endpoint");

    const seven = [...target.querySelectorAll("button.tab")].find((b) => b.textContent === "7d") as HTMLButtonElement;
    seven.click();
    await settle();
    expect(getMyTelemetry).toHaveBeenLastCalledWith("2026-09-26", "2026-10-02");
    expect(target.querySelector(".stat .n")?.textContent).toContain("7");
    expect(seven.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the reason and a Retry that loads when the source fails, never the fixture", async () => {
    const getMyTelemetry = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "error", code: "http-401", message: "Unauthorized" })
      .mockImplementationOnce(async (from: string, to: string) => ({ ok: true, value: meBody(from, to, 5) }));
    const cache = createTelemetryCache({ fetcher: createMyTelemetryFetcher({ getMyTelemetry }, () => NOW) });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    await settle();
    const error = target.querySelector("[data-testid='telemetry-error']");
    expect(error?.textContent).toContain("Sign in again");
    expect(error?.textContent).not.toContain("Unauthorized");
    expect(target.textContent).not.toContain("128");
    (target.querySelector("[data-testid='telemetry-retry']") as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector("[data-testid='telemetry-error']")).toBeNull();
    expect(target.querySelector(".stat .n")?.textContent).toContain("5");
  });
});
