// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import { decisionPrompt } from "./brief-prompts.js";
import type { BriefInput } from "./brief-types.js";

const NOW = new Date(2026, 9, 8, 7, 42);
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

const day = (): BriefInput => ({ ...octoberEightBrief(NOW), today: "2026-10-08" });

function render(props: Record<string, unknown>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input: day(), ...props } });
  flushSync();
}
const q = (sel: string) => target.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("mouseenter"));
  await new Promise((r) => setTimeout(r, 260));
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

describe("DailyBrief", () => {
  it("Shift+A toggles review mode: the catalogue by group, not-built cards as placeholders, then back to the plan", () => {
    render({});
    const planned = qa("[data-widget]").length;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    expect(q('[data-testid="brief-review"]')).not.toBeNull();
    expect(qa("[data-widget]").length).toBeGreaterThanOrEqual(planned);
    const groups = qa('[data-testid="brief-review-group"]').map((el) => el.textContent?.trim());
    expect(groups[0]).toBe("Hero");
    expect(groups).toContain("Your day");
    expect(q(".kind-tag")?.textContent).toMatch(/^sunrise · XL · T1 · \d+$/);
    // A card that is not built yet still shows what it would have said.
    const placeholders = qa('[data-testid="brief-placeholder"]');
    expect(placeholders.length).toBeGreaterThan(0);
    for (const p of placeholders) expect(p.textContent).toContain("No card yet");
    expect(placeholders.map((p) => p.closest("[data-widget]")!.getAttribute("data-widget"))).toContain("runway");
    expect(q('[data-widget="runway"]')!.textContent).toMatch(/clear (after|before) /);
    // Entries with no evidence join the strip in review mode.
    expect(q('[data-testid="brief-dropped"]')!.textContent).toContain("Not shown today");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    expect(q('[data-testid="brief-review"]')).toBeNull();
  });

  it("renders the generated plan: lead chip with priority 1, seven widgets in template 7, today strip, logos and repos", () => {
    render({ companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] });
    const root = q('[data-testid="daily-brief"]')!;
    expect(root.getAttribute("data-lead")).toBe("decisions");
    expect(root.getAttribute("data-density")).toBe("7");
    expect(root.getAttribute("data-template")).toBe("7");
    expect(qa("[data-widget]").map((el) => el.getAttribute("data-widget"))).toEqual([
      "sunrise",
      "needs",
      "incident",
      "waiting",
      "shipped",
      "meetings",
      "agenda",
    ]);
    const chip = q('[data-testid="brief-lead"]')!;
    expect(chip.textContent!.replace(/\s+/g, " ").trim()).toBe('Lead Decisions · 7 widgets · "Cut the hq-core release" leads · 4 calls and a live incident');
    expect(q('[data-testid="brief-today"]')?.textContent).toContain("HQ Founder Office Hours");
    expect(qa('[data-testid="brief-need"]')).toHaveLength(4);
    const origins = qa('[data-testid="brief-origin"]').map((el) => el.textContent?.trim());
    expect(origins.some((t) => /^IN\s*HQ core$/.test(t ?? ""))).toBe(true);
    expect(q('[data-testid="brief-fleet"]')).toBeNull();
    expect(q('[data-testid="brief-other-work"]')).toBeNull();
  });

  it("every slot carries its reason as title and data-reason; the hero names priority 1", () => {
    render({});
    const plan = generateBrief(day());
    for (const w of plan.widgets) {
      const slot = q(`[data-widget="${w.kind}"]`)!;
      expect(slot.getAttribute("title")).toBe(w.reason);
      expect(slot.getAttribute("data-reason")).toBe(w.reason);
    }
    expect(q('[data-widget="needs"]')!.getAttribute("title")).toBe('Shown for priority 1, "Cut the hq-core release": it and 3 more calls wait on you.');
    expect(q('[data-testid="brief-sunrise-first"]')!.textContent).toMatch(/^First: Cut the hq-core release\. /);
  });

  it("the lead chip's peek explains every card and lists what is not shown; the strip caps at five with +N more", async () => {
    render({});
    await hover(q('[data-testid="brief-lead"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Why these cards");
    expect(peek.textContent).toContain("Sunrise — Always first:");
    expect(peek.textContent).toContain("Not shown today");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]').length).toBeLessThanOrEqual(10);
    expect(peek.textContent).toMatch(/\+\d+ more/);
    const strip = q('[data-testid="brief-dropped"]')!;
    expect(qa('[data-testid="brief-dropped-row"]').length).toBeLessThanOrEqual(5);
    expect(strip.textContent).toContain("risk");
  });

  it("starts a decision in the chosen engine with its prompt and marks it done locally", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    const first = q('[data-testid="brief-need"]')!;
    (first.querySelector('[aria-pressed="false"][title="Codex"]') as HTMLButtonElement).click();
    flushSync();
    (first.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledWith("codex", decisionPrompt(day().decisions[0]!));
    expect(first.classList.contains("done")).toBe(true);
    expect(q('[data-testid="brief-sunrise"]')?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("copies a prompt without launching anything", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    (q('[data-testid="brief-copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(decisionPrompt(day().decisions[0]!));
    expect(onlaunch).not.toHaveBeenCalled();
  });
});
