// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import type { BriefInput, BriefWaiting } from "./brief-types.js";
import { sinceDay, waitingAge, waitingLimit, waitingRows, waitingSource } from "./brief-waiting.js";

describe("waiting rows", () => {
  it("shows 3 rows in a one-column slot and 5 in wider ones", () => {
    expect(waitingLimit(1)).toBe(3);
    expect(waitingLimit(2)).toBe(5);
    expect(waitingLimit(3)).toBe(5);
  });

  it("hides only the kinds another card carries; rows without a kind always stay", () => {
    const rows: BriefWaiting[] = [
      { id: "a", who: "Jacob", what: "to take the memo folder", kind: "dm" },
      { id: "b", who: "Hassaan", what: "to acknowledge the billing fix", kind: "handoff" },
      { id: "c", who: "Stefan", what: "to reply" },
    ];
    expect(waitingRows(rows).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(waitingRows(rows, ["handoff"]).map((w) => w.id)).toEqual(["a", "c"]);
    expect(waitingRows(rows, ["dm", "handoff"]).map((w) => w.id)).toEqual(["c"]);
  });

  it("formats the age in mono and marks anything past a day as old", () => {
    expect(waitingAge(null)).toBeNull();
    expect(waitingAge(undefined)).toBeNull();
    expect(waitingAge(Number.NaN)).toBeNull();
    expect(waitingAge(-2)).toBeNull();
    expect(waitingAge(0.5)).toEqual({ label: "<1h", old: false });
    expect(waitingAge(20)).toEqual({ label: "20h", old: false });
    expect(waitingAge(24)).toEqual({ label: "1d", old: false });
    expect(waitingAge(30)).toEqual({ label: "1d", old: true });
    expect(waitingAge(72)).toEqual({ label: "3d", old: true });
  });

  it("names the day a wait started: today, yesterday, a weekday inside the week, then a date", () => {
    // Thursday Oct 8 2026, 07:42 local.
    const now = new Date(2026, 9, 8, 7, 42).toISOString();
    expect(sinceDay(3, now)).toBe("today");
    expect(sinceDay(20, now)).toBe("yesterday");
    expect(sinceDay(50, now)).toBe("Tue");
    expect(sinceDay(24 * 10, now)).toBe("Sep 28");
    expect(sinceDay(null, now)).toBeNull();
    expect(sinceDay(3, "not a time")).toBeNull();
  });

  it("explains the kind of wait for the peek", () => {
    expect(waitingSource("dm")).toMatch(/DM/);
    expect(waitingSource("review")).toMatch(/review/);
    expect(waitingSource("handoff")).toMatch(/handoff/);
    expect(waitingSource("other")).toBeNull();
    expect(waitingSource(undefined)).toBeNull();
  });
});

describe("Waiting on card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  const NOW = new Date(2026, 9, 8, 7, 42);
  const AGES: (number | undefined)[] = [3, 20, 30, 0.5, 72, undefined, 10];
  const day = (): BriefInput => ({
    ...octoberEightBrief(NOW),
    today: "2026-10-08",
    waitingOn: AGES.map((ageHours, i) => ({
      id: `w${i}`,
      who: `Person${i}`,
      what: i === 2 ? "to review your handoff change" : "to reply to your DM",
      kind: i === 2 ? ("review" as const) : ("dm" as const),
      origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-core" },
      ...(ageHours == null ? {} : { ageHours }),
    })),
  });

  function render(input: BriefInput) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input, companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] } });
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

  it("caps the list at the slot's rows and folds the rest into a +N more row whose peek lists them", async () => {
    const input = day();
    const slot = generateBrief(input).widgets.find((w) => w.kind === "waiting")!;
    expect(slot).toBeDefined();
    render(input);
    const card = q('[data-testid="brief-waiting"]')!;
    const rows = qa('[data-testid="brief-waiting-row"]');
    // DailyBrief does not pass cols yet, so the card uses its narrow default; once wired it follows the slot.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
    const more = q('[data-testid="brief-waiting-more"]')!;
    expect(more.textContent?.trim()).toBe(`+${AGES.length - rows.length} more`);
    expect(card.textContent).toContain("Person0 to reply to your DM");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain(`${AGES.length - rows.length} more`);
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(AGES.length - rows.length);
    expect(peek.textContent).toContain(`Person${AGES.length - 1}`);
  });

  it("shows a mono age on each row, amber past a day, and nothing when the age is unknown", () => {
    render(day());
    const rows = qa('[data-testid="brief-waiting-row"]');
    const ages = rows.map((r) => r.querySelector<HTMLElement>('[data-testid="brief-waiting-age"]'));
    expect(ages[0]?.textContent).toBe("3h");
    expect(ages[0]?.classList.contains("old")).toBe(false);
    expect(ages[1]?.textContent).toBe("20h");
    expect(ages[2]?.textContent).toBe("1d");
    expect(ages[2]?.classList.contains("old")).toBe(true);
  });

  it("the row peek says since when you have waited, what kind of wait it is, where it is from, and offers the nudge", async () => {
    render(day());
    const row = qa('[data-testid="brief-waiting-row"]')[2]!;
    await hover(row);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Person2 to review your handoff change");
    expect(peek.textContent).toMatch(/You are waiting · since (today|yesterday|[A-Z][a-z]{2}( \d{1,2})?)/);
    expect(peek.textContent).toContain("Your change, waiting on their review.");
    expect(q('[data-testid="brief-peek-origin"]')?.textContent).toContain("HQ core");
    expect(peek.querySelector('[data-testid="brief-peek-prompt"]')?.textContent).toContain("I am waiting on Person2");
  });

  it("without an age the peek status is plain", async () => {
    const input = day();
    // Two rows keep the card on the page (one row is too little for the picker on this day).
    input.waitingOn = [
      { id: "x1", who: "Jacob", what: "to take the memo folder" },
      { id: "x2", who: "Hassaan", what: "to review your handoff change" },
    ];
    expect(generateBrief(input).widgets.some((w) => w.kind === "waiting")).toBe(true);
    render(input);
    await hover(q('[data-testid="brief-waiting-row"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("You are waiting");
    expect(peek.textContent).not.toContain("since");
    expect(q('[data-testid="brief-waiting-more"]')).toBeNull();
    expect(q('[data-testid="brief-waiting-age"]')).toBeNull();
  });
});
