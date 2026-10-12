// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefFirstsProbe from "./BriefFirstsProbe.test.svelte";
import {
  CAPTION_WORDS,
  FIRSTS_TILE_MAX,
  GLINT_DELAY_MS,
  GLINT_MS,
  firstCaption,
  firstNotePrompt,
  firstPeek,
  firstProduct,
  firstSub,
  firstsHeadline,
  firstsMorePeek,
  firstsOf,
  tileCount,
} from "./brief-firsts.js";
import type { BriefShipped } from "./brief-types.js";

const INDIGO = "cmp_indigo";

function ship(id: string, title: string, extra: Partial<BriefShipped> = {}): BriefShipped {
  return {
    id,
    title,
    status: "MERGED",
    note: "",
    origin: { companyUid: INDIGO, repo: "indigoai-us/hq-pro" },
    lines: [],
    ...extra,
  };
}

/** The real 2026-10-11 firsts plus one plain merge that is not a first. */
const DAY: BriefShipped[] = [
  ship("s1", "hq-pro #4890: feat(api): API keys now stay inside their company", { why: "A key can no longer fetch another company's data; the fix shipped in HQ Pro and the command line.", first: true }),
  ship("s2", "HQ Storage shipped", { why: "Backups, cloud file history and the Storage settings page are merged across core, command line, cloud and desktop.", first: true, origin: { companyUid: INDIGO, repo: "indigoai-us/hq-desktop-app" } }),
  ship("s3", "Finance dashboard is live", { why: "Geoff's CFO budget dashboard merged and deployed.", first: true, origin: { companyUid: INDIGO, repo: "indigoai-us/hq-finance" }, status: "1 merged" }),
  ship("s4", "Desktop app", { status: "13 merged", note: "nothing open" }),
];
const FOUR: BriefShipped[] = [...DAY, ship("s5", "Ran the first customer onboarding call", { first: true, origin: { companyUid: INDIGO, repo: "Calendar", product: "Onboarding" } })];

describe("brief-firsts helpers", () => {
  it("counts the same rows as the catalogue: shipped rows the writer marked first, in the writer's order", () => {
    expect(firstsOf(DAY).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(firstsOf([ship("x", "Plain merge")])).toEqual([]);
    expect(firstsOf([])).toEqual([]);
  });

  it("headline says how many, in words", () => {
    expect(firstsHeadline(1)).toBe("One first yesterday.");
    expect(firstsHeadline(2)).toBe("Two firsts yesterday.");
    expect(firstsHeadline(3)).toBe("Three firsts yesterday.");
    expect(firstsHeadline(12)).toBe("12 firsts yesterday.");
  });

  it("captions are plain: no repo slug, no PR number, no conventional prefix, at most eight words", () => {
    expect(firstCaption("hq-pro #4890: feat(api): API keys now stay inside their company")).toBe("API keys now stay inside their company");
    expect(firstCaption("Finance dashboard is live (#1).")).toBe("Finance dashboard is live");
    expect(firstCaption("fix: one two three four five six seven eight nine ten")).toBe("One two three four five six seven eight…");
    for (const s of FOUR) {
      const cap = firstCaption(s.title);
      expect(cap).not.toMatch(/#\d+/);
      expect(cap).not.toMatch(/[\w.-]+\/[\w.-]+/);
      expect(cap).not.toMatch(/^(feat|fix|chore|docs?)\b/i);
      expect(cap.replace(/…$/, "").split(" ").length).toBeLessThanOrEqual(CAPTION_WORDS);
    }
  });

  it("product and sub come from the origin and the writer's why, by human names", () => {
    expect(firstProduct(DAY[0]!)).toBe("HQ Pro");
    expect(firstProduct(DAY[2]!)).toBe("Finance dashboard");
    expect(firstProduct(FOUR[4]!)).toBe("Onboarding");
    expect(firstSub(DAY[2]!)).toBe("Geoff's CFO budget dashboard merged and deployed.");
    expect(firstSub(ship("n", "t", { note: "  two   spaces " }))).toBe("two spaces");
    expect(firstSub(ship("n", "t"))).toBe("");
  });

  it("tiles per slot: one at S, two at W, three at W3 or taller, never more than the firsts", () => {
    expect(tileCount(1, 1, 5)).toBe(1);
    expect(tileCount(2, 1, 5)).toBe(2);
    expect(tileCount(3, 1, 5)).toBe(FIRSTS_TILE_MAX);
    expect(tileCount(2, 2, 5)).toBe(FIRSTS_TILE_MAX);
    expect(tileCount(3, 1, 2)).toBe(2);
    expect(tileCount(3, 1, 0)).toBe(0);
  });

  it("the note prompt names the product, carries the why, and sends nothing", () => {
    const p = firstNotePrompt(DAY[0]!);
    expect(p).toContain("HQ Pro");
    expect(p).toContain("API keys now stay inside their company");
    expect(p).toContain("Why it counts: A key can no longer fetch another company's data");
    expect(p).toMatch(/do not send or post anything\.$/);
    expect(p).not.toMatch(/#\d+/);
    expect(firstNotePrompt(ship("n", "Shipped a thing"))).not.toContain("Why it counts");
  });

  it("the medal peek shows why, evidence by product, and a Draft prompt; the more-peek lists the rest", () => {
    const pk = firstPeek(DAY[0]!, "PROMPT");
    expect(pk.title).toBe("API keys now stay inside their company");
    expect(pk.status).toBe("HQ Pro · a first");
    expect(pk.sections.map((s) => s.label)).toEqual(["Why it counts", "Evidence"]);
    expect(pk.sections[1]!.lines!.map((l) => [l.label, l.state])).toEqual([
      ["Product", "HQ Pro"],
      ["Shipped", "MERGED"],
      ["Reference", "hq-pro #4890"],
    ]);
    expect(pk.prompt).toEqual({ id: "first:s1", text: "PROMPT", verb: "Draft" });
    const more = firstsMorePeek(firstsOf(FOUR).slice(3));
    expect(more.title).toBe("1 more first");
    expect(more.status).toBe("Also yesterday");
    expect(more.sections[0]!.lines!.map((l) => [l.label, l.state])).toEqual([["Ran the first customer onboarding call", "Onboarding"]]);
    expect(firstsMorePeek(firstsOf(FOUR).slice(1)).title).toBe("3 more firsts");
  });
});

describe("BriefFirsts", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFirstsProbe, { target, props: { shipped: DAY, cols: 3, rows: 1, ...props } });
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
    vi.useRealTimers();
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("renders nothing when no shipped row is a first", () => {
    render({ shipped: [ship("x", "Plain merge"), ship("y", "Another", { first: false })] });
    expect(q('[data-testid="brief-firsts"]')).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  it("three firsts at W3 render three medal tiles under the headline, with no more pill", () => {
    render({});
    expect(q('[data-testid="brief-firsts-title"]')!.textContent).toBe("Three firsts yesterday.");
    expect(q(".eyebrow")!.textContent!.trim()).toBe("Firsts");
    const tiles = qa('[data-testid="brief-first"]');
    expect(tiles).toHaveLength(3);
    expect(qa('[data-testid="brief-first-caption"]').map((el) => el.textContent)).toEqual([
      "API keys now stay inside their company",
      "HQ Storage shipped",
      "Finance dashboard is live",
    ]);
    expect(q('[data-testid="brief-first-sub"]')!.textContent).toContain("A key can no longer fetch another company's data");
    expect(q('[data-testid="brief-firsts-more"]')).toBeNull();
    expect(q('[data-testid="brief-firsts"]')!.classList.contains("w")).toBe(true);
    expect(q('[data-testid="brief-firsts"]')!.className).not.toMatch(/\bc-/);
  });

  it("four firsts cap at three tiles; the +1 more pill's peek lists the fourth", async () => {
    render({ shipped: FOUR });
    expect(qa('[data-testid="brief-first"]')).toHaveLength(3);
    expect(q('[data-testid="brief-firsts-title"]')!.textContent).toBe("Four firsts yesterday.");
    const more = q('[data-testid="brief-firsts-more"]')!;
    expect(more.textContent!.trim()).toBe("+1 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("1 more first");
    expect(peek.textContent).toContain("Ran the first customer onboarding call");
    expect(peek.textContent).toContain("Onboarding");
    expect(peek.textContent).not.toContain("API keys now stay");
  });

  it("S renders exactly one tile and sends the rest to +N more; W renders two", () => {
    render({ cols: 1 });
    expect(qa('[data-testid="brief-first"]')).toHaveLength(1);
    expect(q('[data-testid="brief-firsts-more"]')!.textContent!.trim()).toBe("+2 more");
    unmount(app!);
    app = null;
    target.remove();
    render({ cols: 2 });
    expect(qa('[data-testid="brief-first"]')).toHaveLength(2);
    expect(q('[data-testid="brief-firsts-more"]')!.textContent!.trim()).toBe("+1 more");
  });

  it("captions on the card carry no repo slug or PR number", () => {
    render({ shipped: FOUR });
    for (const el of qa('[data-testid="brief-first-caption"]')) {
      expect(el.textContent).not.toMatch(/#\d+/);
      expect(el.textContent).not.toMatch(/[\w.-]+\/[\w.-]+/);
    }
  });

  it("the disc shows the company logo when the brief knows the company, else a mono 1st", () => {
    render({ companies: [{ uid: INDIGO, label: "Indigo", iconUrl: null }] });
    expect(qa('[data-testid="brief-logo"]')).toHaveLength(3);
    expect(q('[data-testid="brief-first-figure"]')).toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    render({});
    expect(qa('[data-testid="brief-first-figure"]').map((el) => el.textContent)).toEqual(["1st", "1st", "1st"]);
  });

  it("a medal's peek names the product and offers the team-note draft; starting it launches the prompt and nothing else", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    const tile = qa('[data-testid="brief-first"]')[2]!;
    await hover(tile);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Finance dashboard is live");
    expect(peek.textContent).toContain("Finance dashboard · a first");
    expect(peek.textContent).toContain("Geoff's CFO budget dashboard merged and deployed.");
    expect(peek.textContent).toContain("Draft a short note to the team about a first for Finance dashboard");
    expect(peek.textContent).toContain("do not send or post anything");
    (peek.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    expect(onlaunch).toHaveBeenCalledWith("claude", firstNotePrompt(DAY[2]!));
  });

  it("a prompt written by the brief run replaces the built-in draft", async () => {
    render({ prompts: { s1: "Writer's own prompt for s1" } });
    await hover(qa('[data-testid="brief-first"]')[0]!);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Writer's own prompt for s1");
    expect(q('[data-testid="brief-peek"]')!.textContent).not.toContain("Draft a short note");
  });

  it("the foil glints once after load for 700ms, then rests", () => {
    vi.useFakeTimers();
    render({ reducedMotion: false });
    const root = () => q('[data-testid="brief-firsts"]')!;
    expect(root().dataset.glint).toBe("off");
    vi.advanceTimersByTime(GLINT_DELAY_MS - 1);
    flushSync();
    expect(root().dataset.glint).toBe("off");
    vi.advanceTimersByTime(1);
    flushSync();
    expect(root().dataset.glint).toBe("on");
    expect(qa('[data-testid="brief-first"]').every((el) => el.classList.contains("glint"))).toBe(true);
    vi.advanceTimersByTime(GLINT_MS);
    flushSync();
    expect(root().dataset.glint).toBe("off");
    expect(qa(".glint")).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    flushSync();
    expect(root().dataset.glint).toBe("off");
    expect(GLINT_MS).toBe(700);
  });

  it("no glint under reduced motion", () => {
    vi.useFakeTimers();
    render({ reducedMotion: true });
    vi.advanceTimersByTime(GLINT_DELAY_MS + GLINT_MS + 1000);
    flushSync();
    expect(q('[data-testid="brief-firsts"]')!.dataset.glint).toBe("off");
    expect(qa(".glint")).toHaveLength(0);
  });
});
