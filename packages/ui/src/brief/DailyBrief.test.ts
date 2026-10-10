// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { decisionPrompt } from "./brief-prompts.js";

const NOW = new Date(2026, 9, 8, 7, 42);
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(props: Record<string, unknown>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input: octoberEightBrief(NOW), ...props } });
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

describe("DailyBrief", () => {
  it("Shift+A toggles review mode: every card with data, labelled, then back to the plan", () => {
    render({});
    const planned = target.querySelectorAll("[data-widget]").length;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    expect(target.querySelector('[data-testid="brief-review"]')).not.toBeNull();
    expect(target.querySelectorAll("[data-widget]").length).toBeGreaterThanOrEqual(planned);
    expect(target.querySelector(".kind-tag")?.textContent).toContain("sunrise");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    expect(target.querySelector('[data-testid="brief-review"]')).toBeNull();
  });

  it("renders the generated plan: lead, widgets, today strip, logos and repos", () => {
    render({ companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] });
    const root = target.querySelector('[data-testid="daily-brief"]')!;
    expect(root.getAttribute("data-lead")).toBe("decisions");
    expect(root.getAttribute("data-density")).toBe("8");
    expect([...target.querySelectorAll("[data-widget]")].map((el) => el.getAttribute("data-widget"))).toEqual([
      "sunrise",
      "needs",
      "incident",
      "waiting",
      "meetings",
      "risk",
      "team",
      "shipped",
    ]);
    expect(target.querySelector('[data-testid="brief-today"]')?.textContent).toContain("HQ Founder Office Hours");
    expect(target.querySelectorAll('[data-testid="brief-need"]')).toHaveLength(4);
    const origins = [...target.querySelectorAll('[data-testid="brief-origin"]')].map((el) => el.textContent?.trim());
    expect(origins.some((t) => /^IN\s*HQ core$/.test(t ?? ""))).toBe(true);
  });

  it("starts a decision in the chosen engine with its prompt and marks it done locally", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    const first = target.querySelector('[data-testid="brief-need"]')!;
    (first.querySelector('[aria-pressed="false"][title="Codex"]') as HTMLButtonElement).click();
    flushSync();
    (first.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    const day = octoberEightBrief(NOW);
    expect(onlaunch).toHaveBeenCalledWith("codex", decisionPrompt(day.decisions[0]!));
    expect(first.classList.contains("done")).toBe(true);
    expect(target.querySelector('[data-testid="brief-sunrise"]')?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("copies a prompt without launching anything", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    (target.querySelector('[data-testid="brief-copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(decisionPrompt(octoberEightBrief(NOW).decisions[0]!));
    expect(onlaunch).not.toHaveBeenCalled();
  });
});
