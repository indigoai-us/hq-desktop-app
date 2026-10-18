// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief, gridStyle } from "./brief-generate.js";
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

  it("the lead chip's peek explains every card and lists what is not shown by card name; the live page has no strip", async () => {
    render({});
    await hover(q('[data-testid="brief-lead"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Why these cards");
    expect(peek.textContent).toContain("Sunrise — Always first:");
    expect(peek.textContent).toContain("Not shown today");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]').length).toBeLessThanOrEqual(10);
    expect(peek.textContent).toMatch(/\+\d+ more/);
    // Dropped kinds read as card names, never camelCase ids.
    const plan = generateBrief(day());
    expect(plan.dropped.map((d) => d.kind)).toContain("team");
    expect(peek.textContent).toContain("Team:");
    expect(peek.textContent).not.toMatch(/\b(blockedByMe|oneThing|fleetRecovery|releaseTrain|weekArc)\b/);
    // The live CEO page ends with the grid: the picker's reasoning stays behind the hover.
    expect(q('[data-testid="brief-dropped"]')).toBeNull();
  });

  it("Shift+A shows the Not shown strip by card name, capped at five with +N more, with the score parts on hover", async () => {
    render({});
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    const strip = q('[data-testid="brief-dropped"]')!;
    const rows = qa('[data-testid="brief-dropped-row"]');
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(strip.textContent).toContain("Team");
    expect(strip.textContent).toContain("Today");
    expect(strip.textContent).not.toMatch(/\b(blockedByMe|oneThing|fleetRecovery|releaseTrain|weekArc)\b/);
    expect(strip.textContent).toMatch(/\+\d+ more/);
    // Hovering a dropped kind shows the score parts behind it.
    const team = rows.find((el) => el.getAttribute("data-kind") === "team")!;
    expect(team.querySelector("b")!.textContent).toBe("Team");
    expect(team.getAttribute("title")).toMatch(/^value \d+ · priority \d+ · day \d+ · pref -?\d+ · rotation -\d+$/);
    await hover(qa(".b-dropped .more")[0]!);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("more not shown");
  });

  it("review mode lays the groups out in source order: no dense packing, and every card follows its own group label", () => {
    render({});
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    const grid = q("main.b-grid")!;
    expect(grid.getAttribute("style")!.replace(/\s+/g, "")).toContain("grid-auto-flow:row;");
    expect(grid.getAttribute("style")).not.toContain("dense");
    expect(gridStyle([], true)).not.toContain("dense");
    // Walk the tiles: a card's group is the last label seen before it.
    let label: string | null = null;
    for (const el of [...grid.children]) {
      if (el.getAttribute("data-testid") === "brief-review-group") label = el.textContent!.trim();
      else {
        const kind = el.getAttribute("data-widget")!;
        const group = CATALOGUE.find((e) => e.id === kind)!.group;
        const want = { hero: "Hero", needs: "Needs you", health: "Health", waiting: "Waiting", momentum: "Momentum", people: "People", self: "Your day" }[group];
        expect(label, kind).toBe(want);
      }
    }
  });

  it("the sunrise sub-line names a sweep-built red main by product, never by its repo slug", () => {
    const input = day();
    input.risks = [
      {
        id: "ci:hq-core-staging",
        title: "hq-core-staging main CI red",
        summary: "Nightly sync failing on main (1 of 6 workflows).",
        severity: "incident",
        links: [],
        origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-core-staging" },
        ci: { repo: "hq-core-staging", workflow: "Nightly sync", job: null, since: null, ageHours: 5, note: null },
      },
    ];
    render({ input });
    const sub = q('[data-testid="brief-sunrise"] .sub')!.textContent!;
    expect(sub).toContain("The one fire: HQ core main is red.");
    expect(sub).not.toContain("hq-core-staging");
  });

  it("a day with open decisions and nothing else to say never reads as a quiet start, and the eyebrow does not claim them cleared", () => {
    const input = day();
    input.merged = undefined as never;
    input.shipped = [];
    input.meetingsYesterday = [];
    input.risks = [];
    render({ input });
    const n = input.decisions.length;
    expect(n).toBeGreaterThan(0);
    const sunrise = q('[data-testid="brief-sunrise"]')!;
    expect(sunrise.querySelector(".sub")!.textContent).toBe(`${n} decision${n === 1 ? "" : "s"} for you today.`);
    expect(sunrise.textContent).not.toContain("A quiet start");
    expect(sunrise.getAttribute("aria-valuenow")).toBe("0");
    expect(sunrise.querySelector(".eyebrow")!.textContent).toBe("Sunrise · decisions today");
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

describe("DailyBrief report action cards", () => {
  const destinations = { assistantName: "Atlas", claudeCode: true, codex: false };

  it("renders one card per open decision with a prompt, and each button does what it says", async () => {
    const onassistant = vi.fn(async () => null);
    const onlaunch = vi.fn(async () => null);
    const onlog = vi.fn();
    const input = { ...day(), runId: "run-1" };
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input, onlaunch, onlog, actions: { destinations, onassistant } } });
    flushSync();
    const withPrompt = input.decisions.filter((d) => d.prompt || generateBrief(input).prompts[d.id]);
    const cards = qa('[data-testid="brief-action-card"]');
    expect(withPrompt.length).toBeGreaterThan(0);
    expect(cards).toHaveLength(withPrompt.length);
    // A tool that is not installed has no button.
    expect(qa('[data-testid="brief-action-codex"]')).toHaveLength(0);

    const first = cards[0]!;
    const title = first.querySelector("h3")!.textContent!;
    const item = input.decisions.find((d) => d.title === title)!;
    const prompt = generateBrief(input).prompts[item.id] ?? item.prompt;
    (first.querySelector('[data-testid="brief-action-assistant"]') as HTMLElement).click();
    // The card is busy until the send resolves; wait for it before the next button.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(onassistant).toHaveBeenCalledWith(prompt, `brief-action:run-1:${item.id}`);
    (first.querySelector('[data-testid="brief-action-claude"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onlaunch).toHaveBeenCalledWith("claude", prompt);
    expect(onlog).toHaveBeenCalledWith({ event: "launch", itemId: item.id, engine: "claude" });
  });

  async function launchFirstCard(onlaunch: (engine: string, prompt: string) => Promise<string | null>) {
    const onlog = vi.fn();
    const input = { ...day(), runId: "run-1" };
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input, onlaunch, onlog, actions: { destinations, onassistant: vi.fn(async () => null) } } });
    flushSync();
    const before = qa('[data-testid="brief-action-card"]').length;
    const first = qa('[data-testid="brief-action-card"]')[0]!;
    const title = first.querySelector("h3")!.textContent!;
    const item = input.decisions.find((d) => d.title === title)!;
    (first.querySelector('[data-testid="brief-action-claude"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    const card = qa('[data-testid="brief-action-card"]').find((c) => c.querySelector("h3")!.textContent === title);
    return { onlog, item, before, card };
  }

  it("a card launch clears the item like Start and leaves the card with the Started note and no buttons", async () => {
    const { onlog, item, before, card } = await launchFirstCard(vi.fn(async () => null));
    expect(onlog).toHaveBeenCalledWith({ event: "launch", itemId: item.id, engine: "claude" });
    expect(qa('[data-testid="brief-action-card"]')).toHaveLength(before);
    expect(card).toBeDefined();
    expect(card!.querySelector('[data-testid="brief-action-launched"]')!.textContent).toBe("Started in Claude.");
    expect(card!.querySelector("button")).toBeNull();
  });

  it("the Prompt copied fallback also clears the item and shows its note", async () => {
    const { onlog, item, card } = await launchFirstCard(vi.fn(async () => "Prompt copied. Paste it into Claude."));
    expect(onlog).toHaveBeenCalledWith({ event: "launch", itemId: item.id, engine: "claude" });
    expect(card!.querySelector('[data-testid="brief-action-launched"]')!.textContent).toBe("Prompt copied. Paste it into Claude.");
    expect(card!.querySelector("button")).toBeNull();
  });

  it("a failed launch keeps the buttons, logs nothing and shows the error", async () => {
    const { onlog, card } = await launchFirstCard(vi.fn(async () => "Could not open Claude."));
    expect(onlog).not.toHaveBeenCalled();
    expect(card!.querySelector('[data-testid="brief-action-launched"]')).toBeNull();
    expect(card!.querySelector('[data-testid="brief-action-claude"]')).not.toBeNull();
    expect(card!.textContent).toContain("Could not open Claude.");
  });

  it("shows no cards when the host passes no destinations", () => {
    render({});
    expect(q('[data-testid="brief-action-cards"]')).toBeNull();
  });
});
