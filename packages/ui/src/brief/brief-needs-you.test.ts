// @vitest-environment happy-dom
// Needs you: ranked rows with mono age, carried chip, reply waiters, split decide pill, ~N min footer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { EFFORT_MIN, ageLabel, ageTone, carriedLabel, minutesToClear, waitersLine } from "./BriefNeedsYou.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import type { BriefDecision, BriefInput } from "./brief-types.js";

const NOW = new Date(2026, 9, 10, 14, 30);
const COMPANIES = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo", iconUrl: null }];
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(input: BriefInput, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, companies: COMPANIES, ...props } });
  flushSync();
}
const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const row = (title: string) => qa("brief-need").find((el) => el.getAttribute("aria-label") === title)!;
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("mouseenter"));
  await new Promise((r) => setTimeout(r, 260));
  flushSync();
}
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

const decision = (i: number, extra: Partial<BriefDecision> = {}): BriefDecision => ({
  id: `d${i}`,
  title: `Decision number ${i}`,
  summary: `Why ${i}`,
  action: "decide",
  origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
  ...extra,
});

/** Three calls keep Needs you in a two-row slot (the one-thing card measures null past two). */
function day(decisions: BriefDecision[], extra: Partial<BriefInput> = {}): BriefInput {
  return { ...octoberEightBrief(NOW), today: "2026-10-10", decisions, priorities: undefined, ...extra };
}

describe("needs helpers", () => {
  it("ageLabel reads hours under two days and days after, and is null when unknown", () => {
    expect(ageLabel(null)).toBeNull();
    expect(ageLabel(undefined)).toBeNull();
    expect(ageLabel(Number.NaN)).toBeNull();
    expect(ageLabel(0.4)).toBe("<1h");
    expect(ageLabel(5)).toBe("5h");
    expect(ageLabel(44.4)).toBe("44h");
    expect(ageLabel(47.9)).toBe("48h");
    expect(ageLabel(48)).toBe("2d");
    expect(ageLabel(72)).toBe("3d");
  });

  it("ageTone is amber past a day and red past two", () => {
    expect(ageTone(null)).toBeNull();
    expect(ageTone(24)).toBeNull();
    expect(ageTone(24.5)).toBe("warn");
    expect(ageTone(48)).toBe("warn");
    expect(ageTone(49)).toBe("red");
  });

  it("carriedLabel counts the brief this is, from how many carried it", () => {
    expect(carriedLabel(undefined)).toBeNull();
    expect(carriedLabel(0)).toBeNull();
    expect(carriedLabel(1)).toBe("2nd brief");
    expect(carriedLabel(2)).toBe("3rd brief");
    expect(carriedLabel(3)).toBe("4th brief");
    expect(carriedLabel(10)).toBe("11th brief");
    expect(carriedLabel(20)).toBe("21st brief");
  });

  it("waitersLine names people from blocks, else counts peopleWaiting, else nothing", () => {
    expect(waitersLine(decision(1))).toBeNull();
    expect(waitersLine(decision(1, { peopleWaiting: 0 }))).toBeNull();
    expect(waitersLine(decision(1, { peopleWaiting: 3 }))).toBe("3 waiting");
    expect(waitersLine(decision(1, { peopleWaiting: 3, blocks: [{ who: "Geoff", what: "the pricing page", kind: "person" }] }))).toBe("Geoff waits on your reply");
    expect(
      waitersLine(
        decision(1, {
          blocks: [
            { who: "Geoff", what: "x", kind: "person" },
            { who: "Jonathan", what: "y", kind: "person" },
            { who: "Geoff", what: "z", kind: "person" },
            { who: "the release", what: "w", kind: "work" },
          ],
        }),
      ),
    ).toBe("Geoff and Jonathan wait on your reply");
    // Work-only blocks never read as people.
    expect(waitersLine(decision(1, { blocks: [{ who: "the release", what: "w", kind: "work" }] }))).toBeNull();
  });

  it("minutesToClear sums open calls' effort, or trusts the writer's total less what was cleared here", () => {
    const ds = [decision(1, { effort: "quick" }), decision(2, { effort: "medium" }), decision(3, { effort: "large" }), decision(4)];
    expect(EFFORT_MIN).toEqual({ quick: 2, medium: 6, large: 15 });
    expect(minutesToClear(ds, {}, null)).toBe(23);
    expect(minutesToClear(ds, { d3: true }, null)).toBe(8);
    expect(minutesToClear([decision(1), decision(2)], {}, null)).toBeNull();
    expect(minutesToClear(ds, {}, 30)).toBe(30);
    expect(minutesToClear(ds, { d1: true, d4: true }, 30)).toBe(28);
    expect(minutesToClear(ds, { d3: true }, 10)).toBe(0);
  });
});

describe("Needs you rows", () => {
  it("shows a mono age at the row end: neutral under a day, amber past one, red past two; none when unknown", () => {
    render(day([decision(1, { ageHours: 5 }), decision(2, { ageHours: 30 }), decision(3, { ageHours: 72 }), decision(4)]));
    expect(qa("brief-need")).toHaveLength(4);
    const age = (title: string) => row(title).querySelector<HTMLElement>('[data-testid="brief-need-age"]');
    expect(age("Decision number 1")!.textContent).toBe("5h");
    expect(age("Decision number 1")!.className).not.toMatch(/warn|red/);
    expect(age("Decision number 2")!.textContent).toBe("30h");
    expect(age("Decision number 2")!.classList.contains("warn")).toBe(true);
    expect(age("Decision number 3")!.textContent).toBe("3d");
    expect(age("Decision number 3")!.classList.contains("red")).toBe(true);
    expect(age("Decision number 4")).toBeNull();
    // Age is in mono, the chip class the card styles with var(--b-mono).
    expect(age("Decision number 1")!.classList.contains("chip-m")).toBe(true);
  });

  it("marks a call carried from an earlier brief with a '2nd brief' chip", () => {
    render(day([decision(1, { carriedBriefs: 1 }), decision(2, { carriedBriefs: 2 }), decision(3)]));
    const chip = (title: string) => row(title).querySelector<HTMLElement>('[data-testid="brief-need-carried"]');
    expect(chip("Decision number 1")!.textContent).toBe("2nd brief");
    expect(chip("Decision number 2")!.textContent).toBe("3rd brief");
    expect(chip("Decision number 3")).toBeNull();
  });

  it("reply rows say who waits: named people from blocks, else 'N waiting'", () => {
    render(
      day([
        decision(1, { action: "reply", blocks: [{ who: "Geoff", what: "the pricing page", kind: "person" }] }),
        decision(2, { action: "reply", peopleWaiting: 3 }),
        decision(3, { action: "go", peopleWaiting: 2, blocks: [{ who: "Jonathan", what: "the signup fixes", kind: "person" }] }),
      ]),
    );
    const sub = (title: string) => row(title).querySelector<HTMLElement>('[data-testid="brief-need-sub"]')!.textContent;
    expect(sub("Decision number 1")).toBe("Geoff waits on your reply · Why 1");
    expect(sub("Decision number 2")).toBe("3 waiting · Why 2");
    // Only reply rows carry the waiters line; the others keep their summary.
    expect(sub("Decision number 3")).toBe("Why 3");
  });

  it("the row peek adds age, effort and who is waiting on the call", async () => {
    render(day([decision(1, { ageHours: 44, effort: "medium", carriedBriefs: 1, blocks: [{ who: "Jonathan", what: "the round close", kind: "person" }] }), decision(2), decision(3)]));
    await hover(row("Decision number 1"));
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Decision number 1");
    expect(peek.textContent).toContain("44h old · ~6 min · 2nd brief");
    expect(peek.textContent).toContain("Waiting on this");
    expect(peek.textContent).toContain("Jonathan");
    expect(peek.textContent).toContain("the round close");
  });

  it("the footer sums effort into '~N min' and drops as calls are cleared; 'All clear' at the end", async () => {
    const onlaunch = vi.fn(async () => null);
    render(day([decision(1, { effort: "quick" }), decision(2, { effort: "medium" }), decision(3, { effort: "large" })]), { onlaunch });
    expect(q("brief-need-time")!.textContent).toBe("~23 min");
    (row("Decision number 3").querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await settle();
    expect(q("brief-need-time")!.textContent).toBe("~8 min");
    (row("Decision number 1").querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await settle();
    (row("Decision number 2").querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await settle();
    expect(q("brief-need-time")!.textContent).toBe("All clear");
    expect(q("brief-needs")!.textContent).toContain("3 of 3 cleared");
  });

  it("without effort tags the footer keeps its hover hint", () => {
    render(day([decision(1), decision(2), decision(3)]));
    expect(q("brief-need-time")!.textContent).toBe("Hover a row to start it");
  });

  it("a decide row with choices gets the split pill; one without keeps the start button", () => {
    render(day([decision(1, { choices: ["Keep", "Retire"] }), decision(2), decision(3, { action: "go", choices: ["A", "B"] })]));
    const split = row("Decision number 1");
    expect(split.querySelector('[data-testid="brief-start"]')).toBeNull();
    expect([...split.querySelectorAll('[data-testid="brief-choice"]')].map((b) => b.textContent)).toEqual(["Keep", "Retire"]);
    expect(row("Decision number 2").querySelector('[data-testid="brief-start"]')).not.toBeNull();
    // Choices only split a decide; a go with stray choices still starts plainly.
    expect(row("Decision number 3").querySelector('[data-testid="brief-start"]')).not.toBeNull();
    expect(row("Decision number 3").querySelector('[data-testid="brief-choice"]')).toBeNull();
  });

  it("still caps at five rows with a '+N more' row whose peek lists the rest with their ages", async () => {
    render(day(Array.from({ length: 7 }, (_, i) => decision(i + 1, { ageHours: 10 * (i + 1) }))));
    expect(qa("brief-need")).toHaveLength(5);
    // Rows arrive ranked: the three derived priorities first, then the oldest calls.
    expect(qa("brief-need").map((el) => el.getAttribute("aria-label"))).toEqual(["Decision number 1", "Decision number 2", "Decision number 3", "Decision number 7", "Decision number 6"]);
    const more = q("brief-need-more")!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const lines = [...q("brief-peek")!.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent!.replace(/\s+/g, " ").trim());
    expect(lines).toEqual(["Decision number 52d", "Decision number 440h"]);
  });
});
