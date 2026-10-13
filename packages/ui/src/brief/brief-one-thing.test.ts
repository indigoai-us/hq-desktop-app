// @vitest-environment happy-dom
// If you do one thing: the quote (lead hint or the call and its unlock count), up to three chips, the peek and the launch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { oneThingChips, oneThingQuote, unlockCount } from "./BriefOneThing.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import type { BriefDecision, BriefInput } from "./brief-types.js";

const NOW = new Date(2026, 9, 10, 14, 30);
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(input: BriefInput, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, ...props } });
  flushSync();
}
const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
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

const decision = (id: string, title: string, extra: Partial<BriefDecision> = {}): BriefDecision => ({
  id,
  title,
  summary: `Summary of ${id}`,
  action: "go",
  origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
  ...extra,
});

const big = decision("d1", "Close out the SAFE allotment", {
  revenue: true,
  peopleWaiting: 2,
  detail: {
    why: "investors and the round close wait on it",
    unlocks: [
      { label: "The round can close", state: "NEXT" },
      { label: "Jonathan can send the docs", state: "" },
    ],
    source: "Signal · Oct 9",
  },
  blocks: [{ who: "Jonathan", what: "the round close", kind: "person" }],
});

describe("one-thing helpers", () => {
  it("unlockCount is unlock lines plus named blocks, as measure() counts", () => {
    expect(unlockCount(decision("x", "X"))).toBe(0);
    expect(unlockCount(big)).toBe(3);
  });

  it("the quote prefers the writer's lead hint, else the call and how much it unlocks", () => {
    expect(oneThingQuote(big, "Close the round today")).toBe("Close the round today.");
    expect(oneThingQuote(big, "Close the round today!")).toBe("Close the round today!");
    expect(oneThingQuote(big, "   ")).toBe("Close out the SAFE allotment. It unlocks 3 more.");
    expect(oneThingQuote(decision("x", "Keep the no-self-merge rule?"), null)).toBe("Keep the no-self-merge rule?");
    expect(oneThingQuote(decision("x", "Ship it", { detail: { why: "", unlocks: [{ label: "a", state: "" }], source: "" } }), null)).toBe("Ship it. It unlocks 1 more.");
    expect(oneThingQuote(null, null)).toBe("");
    expect(oneThingQuote(null, "Rest today")).toBe("Rest today.");
  });

  it("chips: unlock labels first, then who or what it frees, three at most, no duplicates", () => {
    expect(oneThingChips(null)).toEqual([]);
    expect(oneThingChips(big)).toEqual(["The round can close", "Jonathan can send the docs", "frees Jonathan"]);
    const many = decision("y", "Y", {
      detail: { why: "", unlocks: [{ label: "a", state: "" }, { label: "b", state: "" }, { label: "a", state: "" }, { label: "c", state: "" }], source: "" },
      blocks: [{ who: "the release", what: "the docs merge", kind: "work" }],
    });
    expect(oneThingChips(many)).toEqual(["a", "b", "c"]);
    expect(oneThingChips(decision("z", "Z", { blocks: [{ who: "the release", what: "the docs merge", kind: "work" }] }))).toEqual(["frees the docs merge"]);
  });
});

describe("BriefOneThing on the page", () => {
  const input = (): BriefInput => ({
    ...octoberEightBrief(NOW),
    today: "2026-10-10",
    priorities: undefined,
    decisions: [big, decision("d2", "Answer Geoff on pricing", { action: "reply" })],
  });

  it("renders the catalogue's pick with its unlock count, three chips, a peek and a launch", async () => {
    const plan = generateBrief(input());
    expect(plan.widgets.map((w) => w.kind)).toContain("oneThing");
    const onlaunch = vi.fn(async () => null);
    render(input(), { onlaunch });
    const card = q("brief-one-thing")!;
    expect(card).not.toBeNull();
    expect(q("brief-one-thing-quote")!.textContent).toBe("Close out the SAFE allotment. It unlocks 3 more.");
    expect(qa("brief-one-thing-chip").map((c) => c.textContent)).toEqual(["The round can close", "Jonathan can send the docs", "frees Jonathan"]);
    // Two columns: the because sentence waits for the W3 variant.
    expect(q("brief-one-thing-because")).toBeNull();
    await hover(q("brief-one-thing-quote")!);
    expect(q("brief-peek")!.textContent).toContain("investors and the round close wait on it");
    (card.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledWith("claude", plan.prompts.d1);
    expect(card.querySelector('[data-testid="brief-start"]')).toBeNull();
    expect(card.textContent).toContain("Done");
    expect(q("brief-one-thing-quote")!.classList.contains("cleared")).toBe(true);
  });
});
