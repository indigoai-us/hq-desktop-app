// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";
import type { TelemetrySnapshot } from "./telemetry-model.js";

describe("Telemetry Sessions never silently truncate (QA-001)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  it("counts the real rows and pages 128 sessions by 50 with Show more", async () => {
    const base = TELEMETRY_SMOKE.sessionsRows[1] ?? TELEMETRY_SMOKE.sessionsRows[0]!;
    const rows = Array.from({ length: 128 }, (_, i) => ({
      ...base,
      id: `s-${i}`,
      day: `Day ${Math.floor(i / 9)}`,
      project: `project-${i}`,
      actor: "you" as const,
      failed: false,
    }));
    const snapshot: TelemetrySnapshot = { ...TELEMETRY_SMOKE, sessions: 128, sessionsRows: rows };
    const cache = createTelemetryCache({ fallback: snapshot, fetcher: async () => snapshot });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(target.querySelector("[data-testid='telemetry-sessions-count']")?.textContent).toBe("128");
    const showAll = [...target.querySelectorAll("button.lnk")].find((b) => b.textContent?.startsWith("Show all"));
    expect(showAll?.textContent).toBe("Show all 128");
    (showAll as HTMLButtonElement).click();
    flushSync();

    const sessionRows = () => target.querySelectorAll(".canvas.sessions .scroll button.srow");
    expect(sessionRows()).toHaveLength(50);
    const more = () => target.querySelector("[data-testid='telemetry-sessions-show-more']") as HTMLButtonElement | null;
    expect(more()?.textContent).toContain("Show 50 more");
    more()!.click();
    flushSync();
    expect(sessionRows()).toHaveLength(100);
    more()!.click();
    flushSync();
    expect(sessionRows()).toHaveLength(128);
    expect(more()).toBeNull();
  });
});
