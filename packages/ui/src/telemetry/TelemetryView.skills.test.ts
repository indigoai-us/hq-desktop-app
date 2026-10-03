// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";

describe("Telemetry Skills controls (QA-068)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  async function mountView(): Promise<HTMLElement> {
    const snapshot = { ...TELEMETRY_SMOKE, endDate: undefined };
    const cache = createTelemetryCache({ fallback: snapshot, fetcher: async () => snapshot });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache } });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    return target;
  }

  const button = (root: HTMLElement, match: (text: string) => boolean) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => match(b.textContent?.trim() ?? ""))!;

  it("the sidebar Skills row returns to Overview and focuses the skills breakdown", async () => {
    const target = await mountView();
    button(target, (t) => t === "Tokens").click();
    flushSync();
    expect(target.querySelector("[data-testid='telemetry-top-skills']")).toBeNull();

    button(target, (t) => t.startsWith("Skills")).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const section = target.querySelector<HTMLElement>("[data-testid='telemetry-top-skills']");
    expect(section).toBeTruthy();
    expect(document.activeElement).toBe(section);
  });

  it("the Top skills total link focuses the breakdown", async () => {
    const target = await mountView();
    const section = target.querySelector<HTMLElement>("[data-testid='telemetry-top-skills']")!;
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    button(target, (t) => t.endsWith("total")).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(section);
  });
});
