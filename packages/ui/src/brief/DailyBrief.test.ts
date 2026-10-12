// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import { CATALOGUE, entryOf } from "./brief-catalogue.js";
import { everything, octoberEleven } from "./brief-catalogue-fixtures.js";
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
  it("Shift+A toggles review mode: the catalogue by group, every scored card rendered, then back to the plan", () => {
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
    // Every kind has a card now: nothing renders as a placeholder, and the review page carries the cards the plan left out.
    expect(qa('[data-testid="brief-placeholder"]')).toHaveLength(0);
    const shown = qa("[data-widget]").map((el) => el.getAttribute("data-widget"));
    expect(shown).toEqual(expect.arrayContaining(["agenda", "runway", "blockedByMe", "team"]));
    expect(q('[data-widget="runway"]')!.textContent).toMatch(/clear (after|before) /);
    // Entries with no evidence join the strip in review mode.
    expect(q('[data-testid="brief-dropped"]')!.textContent).toContain("Not shown today");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    expect(q('[data-testid="brief-review"]')).toBeNull();
  });

  it("review mode renders a not-built entry as a placeholder that says what the card would have said", () => {
    const runway = entryOf("runway") as { ready: boolean };
    runway.ready = false;
    try {
      render({});
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
      flushSync();
      const placeholders = qa('[data-testid="brief-placeholder"]');
      expect(placeholders).toHaveLength(1);
      expect(placeholders[0]!.closest("[data-widget]")!.getAttribute("data-widget")).toBe("runway");
      expect(placeholders[0]!.textContent).toContain("Focus time");
      expect(placeholders[0]!.textContent).toContain("No card yet");
      expect(placeholders[0]!.textContent).toMatch(/clear (after|before) /);
      // The live plan takes Today's calls instead, and the strip says why runway is missing.
      expect(q('[data-testid="brief-dropped"]')!.textContent).toContain("no card yet");
    } finally {
      runway.ready = true;
    }
  });

  it("every ready kind renders a real card with evidence in review mode on a day when everything has data", () => {
    const input = everything();
    const plan = generateBrief(input);
    render({ input, companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    const scoredKinds = plan.scored.map((s) => s.kind);
    // The catch-up hero and oneThing measure null on this day (not a catch-up; six calls); every other kind is scored.
    expect(scoredKinds.sort()).toEqual(
      CATALOGUE.map((e) => e.id)
        .filter((k) => k !== "catchup" && k !== "oneThing")
        .sort(),
    );
    expect(qa('[data-testid="brief-placeholder"]')).toHaveLength(0);
    for (const kind of scoredKinds) {
      const slot = q(`[data-widget="${kind}"]`);
      expect(slot, kind).not.toBeNull();
      const card = slot!.querySelector(".w");
      expect(card, `${kind} renders its card`).not.toBeNull();
      expect(card!.textContent!.trim().length, `${kind} has content`).toBeGreaterThan(10);
      expect(slot!.getAttribute("title")).toMatch(/^(Always first|Shown)\b.*\.$/);
    }
    // Owner rules on the page: no repo slug, PR number or conventional prefix on any card face.
    const faces = qa("[data-widget] .w").map((el) => el.textContent ?? "").join("\n");
    expect(faces).not.toMatch(/indigoai-us\//);
    expect(faces).not.toMatch(/#\d{2,}/);
    expect(faces).not.toMatch(/\b(feat|fix|chore)\(/);
    // Handoffs is on the page, so the Waiting card hands handoff rows to it.
    expect(q('[data-widget="handoffs"]')!.textContent).toContain("Ownership moved");
    expect(q('[data-widget="waiting"]')!.textContent).toContain("Jacob");
  });

  it("renders the generated plan: lead chip with priority 1, eight widgets in template 8, today strip, logos and repos", () => {
    render({ companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] });
    const root = q('[data-testid="daily-brief"]')!;
    expect(root.getAttribute("data-lead")).toBe("decisions");
    expect(root.getAttribute("data-density")).toBe("8");
    expect(root.getAttribute("data-template")).toBe("8");
    expect(qa("[data-widget]").map((el) => el.getAttribute("data-widget"))).toEqual([
      "sunrise",
      "needs",
      "incident",
      "waiting",
      "meetings",
      "risk",
      "shipped",
      "runway",
    ]);
    const chip = q('[data-testid="brief-lead"]')!;
    expect(chip.textContent!.replace(/\s+/g, " ").trim()).toBe('Lead Decisions · 8 widgets · "Cut the hq-core release" leads · 4 calls and a live incident');
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
    // Template 8 puts the hero at M, where the "First:" line is hidden by design.
    expect(plan.widgets[0]).toMatchObject({ kind: "sunrise", size: "M" });
    expect(q('[data-testid="brief-sunrise-first"]')).toBeNull();
    // No call carries an effort size on this day, so there is no time-to-clear estimate either.
    expect(q('[data-testid="brief-sunrise-eta"]')).toBeNull();
  });

  it("shows the time to clear beside the meter once a call carries an effort size, and in the Needs you footer", () => {
    const input = day();
    input.decisions[0]!.effort = "medium";
    render({ input });
    expect(q('[data-testid="brief-sunrise-eta"]')?.textContent).toMatch(/^~\d+ min$/);
    expect(q('[data-testid="brief-need-time"]')?.textContent).toMatch(/^~\d+ min$/);
  });

  it("the hero names priority 1 at L: the Oct 11 Sunday reads First: ... with its because", () => {
    const sunday = octoberEleven();
    render({ input: sunday });
    const plan = generateBrief(sunday);
    expect(plan.widgets[0]!.size).toBe("L");
    expect(q('[data-testid="brief-sunrise-first"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "First: Close out the $20-cap SAFE allotment. Investors and the round close wait on it.",
    );
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
    expect(strip.textContent).toContain("team");
    expect(strip.textContent).toContain("agenda");
    // Hovering a dropped kind shows the score parts behind it.
    const team = qa('[data-testid="brief-dropped-row"]').find((el) => el.textContent?.startsWith("team"))!;
    expect(team.getAttribute("title")).toMatch(/^value \d+ · priority \d+ · day \d+ · pref -?\d+ · rotation -\d+$/);
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
