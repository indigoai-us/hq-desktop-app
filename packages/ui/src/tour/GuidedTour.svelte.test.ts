// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import GuidedTour from "./GuidedTour.svelte";
import { TOUR_TARGET_TIMEOUT_MS, tourSteps } from "./guided-tour.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

function mountTour(index: number, ctx: Parameters<typeof tourSteps>[0] = { hasCompanyVault: true, hasCompany: true }) {
  const steps = tourSteps(ctx);
  const handlers = { onnext: vi.fn(), onback: vi.fn(), onskip: vi.fn() };
  const props = $state({ step: steps[index], index, count: steps.length, ...handlers });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(GuidedTour, { target: host, props });
  return { props, steps, ...handlers };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("GuidedTour", () => {
  it("renders an accessible card with progress, title, body and Skip/Next on step 1", async () => {
    mountTour(0);
    await tick();
    const card = q("guided-tour-card");
    expect(card?.getAttribute("role")).toBe("dialog");
    const titleId = card?.getAttribute("aria-labelledby");
    expect(titleId && document.getElementById(titleId)?.textContent).toBe("Talk to your setup bot");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("1 of 8");
    expect(q("guided-tour-skip")).toBeTruthy();
    expect(q("guided-tour-back")).toBeNull();
    expect(q("guided-tour-next")?.textContent?.trim()).toBe("Next");
    expect(document.querySelector("[data-hq-tour]")).toBeTruthy();
  });

  it("offers Back from step 2 and says Done on the last step", async () => {
    const { props, steps } = mountTour(1);
    await tick();
    expect(q("guided-tour-back")).toBeTruthy();
    props.step = steps[7];
    props.index = 7;
    flushSync();
    expect(q("guided-tour-next")?.textContent?.trim()).toBe("Done");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("8 of 8");
  });

  it("routes the buttons and Escape to the host", async () => {
    const { onnext, onback, onskip } = mountTour(2);
    await tick();
    q("guided-tour-next")?.click();
    q("guided-tour-back")?.click();
    q("guided-tour-skip")?.click();
    expect(onnext).toHaveBeenCalledTimes(1);
    expect(onback).toHaveBeenCalledTimes(1);
    expect(onskip).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onskip).toHaveBeenCalledTimes(2);
  });

  it("focuses Next on each step", async () => {
    const { props, steps } = mountTour(0);
    await tick();
    await tick();
    expect(document.activeElement).toBe(q("guided-tour-next"));
    q("guided-tour-skip")?.focus();
    props.step = steps[1];
    props.index = 1;
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(q("guided-tour-next"));
  });

  it("centers a step with no target straight away (invite before a company exists)", async () => {
    mountTour(3, { hasCompany: false });
    await tick();
    flushSync();
    const card = q("guided-tour-card");
    expect(card?.classList.contains("is-ready")).toBe(true);
    expect(card?.dataset.placement).toBe("center");
    expect(card?.textContent).toContain("once setup creates your company");
    expect(q("guided-tour-cutout")).toBeNull();
  });

  it("keeps Tab inside the card and stops later window listeners from seeing it", async () => {
    const { onskip } = mountTour(2);
    await tick();
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    q("guided-tour-next")!.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(q("guided-tour-skip"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onskip).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later, true);
  });

  it("shows the card centered with no cutout when the target never appears", async () => {
    vi.useFakeTimers();
    mountTour(2);
    await tick();
    expect(q("guided-tour-card")?.classList.contains("is-ready")).toBe(false);
    vi.advanceTimersByTime(TOUR_TARGET_TIMEOUT_MS + 50);
    flushSync();
    const card = q("guided-tour-card");
    expect(card?.classList.contains("is-ready")).toBe(true);
    expect(card?.dataset.placement).toBe("center");
    expect(q("guided-tour-cutout")).toBeNull();
  });
});
