// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefResolvedHarness.test-support.svelte";
import {
  RESOLVED_ROWS,
  RESOLVED_ROWS_SHORT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_UNKNOWN,
  TIMELINE_MAX,
  agoLabel,
  durationLabel,
  durationParts,
  moreRecoveredPeek,
  orderRecovered,
  plainTitle,
  postIncidentNotePrompt,
  recoveredPeek,
  recoverySpan,
  resolvedCap,
  resolvedHeadline,
  timelineOf,
  utcClock,
  utcHm,
} from "./brief-resolved.js";
import type { BriefOrigin, BriefRecovered } from "./brief-types.js";

const NOW = "2026-10-11T14:54:00.000Z";
const origin = (repo: string, product?: string): BriefOrigin => ({ companyUid: "cmp_indigo", repo, ...(product ? { product } : {}) });
const hoursAgo = (h: number): string => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const SYNC: BriefRecovered = {
  id: "r-sync",
  title: "The nightly sync check is green again",
  what: "The retry fix landed and the 06:00 run passed",
  at: hoursAgo(5),
  source: "main_health",
  origin: origin("indigoai-us/hq-cloud"),
  timeline: [
    { at: "2026-10-11T01:36:00Z", text: "Nightly sync went red on the vault step" },
    { at: "2026-10-11T01:51:00Z", text: "Route cap blocked the retry; fix opened" },
    { at: "2026-10-11T06:27:00Z", text: "Fix merged and the sync passed" },
  ],
};

/** Seven recoveries across products, oldest first in the input so the card has to order them. */
function seven(): BriefRecovered[] {
  const products = ["hq-cloud", "hq-core-staging", "hq-desktop-app", "hq-pro-agents", "hq-cli", "hq-deploy", "hq-finance"];
  return products.map((repo, i) => ({
    id: `r${i + 1}`,
    title: `indigoai-us/${repo} #${400 + i}: fix(ci): check ${i + 1} is green again`,
    what: `Fix ${i + 1} merged`,
    at: hoursAgo(20 - i * 2),
    source: i % 3 === 0 ? "main_health" : i % 3 === 1 ? "fleet" : "session",
    origin: origin(`indigoai-us/${repo}`),
  }));
}

describe("brief-resolved helpers", () => {
  it("titles read as the owner's words: no repo slug, PR number or commit prefix", () => {
    expect(plainTitle("indigoai-us/hq-cloud #412: fix(ci): nightly sync green again")).toBe("Nightly sync green again");
    expect(plainTitle("feat(pack): restore the fleet census")).toBe("Restore the fleet census");
    expect(plainTitle("The nightly sync check is green again")).toBe("The nightly sync check is green again");
  });

  it("headline: one recovery is its title as a sentence; several are a count", () => {
    expect(resolvedHeadline([SYNC])).toBe("The nightly sync check is green again.");
    expect(resolvedHeadline(seven())).toBe("7 things recovered");
  });

  it("orders newest first with unknown times last and ties by id", () => {
    const rows = seven();
    const unknown: BriefRecovered = { ...rows[0]!, id: "r0", at: null };
    expect(orderRecovered([unknown, ...rows]).map((r) => r.id)).toEqual(["r7", "r6", "r5", "r4", "r3", "r2", "r1", "r0"]);
    const a = { ...rows[0]!, id: "b", at: hoursAgo(1) };
    const b = { ...rows[0]!, id: "a", at: hoursAgo(1) };
    expect(orderRecovered([a, b]).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("caps rows by slot height: five in a tall slot, three in a one-row slot", () => {
    expect(resolvedCap(2)).toBe(RESOLVED_ROWS);
    expect(resolvedCap(1)).toBe(RESOLVED_ROWS_SHORT);
    expect(RESOLVED_ROWS).toBe(5);
  });

  it("when labels come from `now`, never the clock, and the timeline clock is UTC", () => {
    expect(agoLabel(hoursAgo(0.5), NOW)).toBe("just now");
    expect(agoLabel(hoursAgo(5), NOW)).toBe("5h ago");
    expect(agoLabel(hoursAgo(60), NOW)).toBe("2 days ago");
    expect(agoLabel(null, NOW)).toBeNull();
    expect(agoLabel("not a time", NOW)).toBeNull();
    expect(utcClock("2026-10-11T01:36:00Z")).toBe("01:36 UTC");
    expect(utcClock("2026-10-11T06:27:00+02:00")).toBe("04:27 UTC");
    expect(utcClock(null)).toBeNull();
  });

  it("timeline: oldest first, five shown, the rest kept for the +N more peek", () => {
    const many: BriefRecovered = {
      ...SYNC,
      timeline: Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-11T0${6 - i}:00:00Z`, text: `step ${7 - i}` })),
    };
    const tl = timelineOf(many);
    expect(tl.shown).toHaveLength(TIMELINE_MAX);
    expect(tl.shown.map((e) => e.text)).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
    expect(tl.rest.map((e) => e.text)).toEqual(["step 6", "step 7"]);
    expect(timelineOf({ ...SYNC, timeline: undefined })).toEqual({ shown: [], rest: [] });
  });

  it("the row peek carries the timeline, the evidence, the writer's three lines and the note prompt", () => {
    const withNote: BriefRecovered = { ...SYNC, postIncident: { broke: "The vault route cap", did: "Removed the fleet route", changes: "Deploys retry once" } };
    const p = recoveredPeek(withNote, undefined, NOW);
    expect(p.title).toBe("The nightly sync check is green again");
    expect(p.status).toBe("HQ Cloud · main CI · fixed 5h ago");
    expect(p.sections.map((s) => s.label)).toEqual(["Timeline", "Evidence", "What broke", "What we did", "What changes"]);
    expect(p.sections[0]!.lines!.map((l) => l.state)).toEqual(["01:36 UTC", "01:51 UTC", "06:27 UTC"]);
    expect(p.sections[0]!.lines!.at(-1)!.tone).toBe("ok");
    expect(p.prompt!.id).toBe("r-sync");
    expect(p.prompt!.text).toBe(postIncidentNotePrompt(withNote));
    expect(recoveredPeek(SYNC, "Custom prompt", NOW).prompt!.text).toBe("Custom prompt");
  });

  it("the post-incident prompt names the product, the timeline and the three questions, and only drafts", () => {
    const text = postIncidentNotePrompt(SYNC);
    expect(text).toMatch(/^Write the post-incident note for: The nightly sync check is green again\. /);
    expect(text).toContain("Product: HQ Cloud.");
    expect(text).toContain("01:36 UTC Nightly sync went red on the vault step; 01:51 UTC");
    expect(text).toContain("what broke, what we did, and what changes");
    expect(text).toMatch(/Show me the draft; do not post or send it\.$/);
    expect(text).not.toContain("indigoai-us/");
  });

  it("durations read as a big number with small units: minutes, hours and minutes, then days and hours", () => {
    const m = 60_000;
    expect(durationParts(38 * m)).toEqual([{ n: "38", u: "m" }]);
    expect(durationParts(0)).toEqual([{ n: "0", u: "m" }]);
    expect(durationParts((4 * 60 + 51) * m)).toEqual([{ n: "4", u: "h" }, { n: "51", u: "m" }]);
    expect(durationParts(5 * 60 * m)).toEqual([{ n: "5", u: "h" }]);
    expect(durationParts((51 * 60 + 20) * m)).toEqual([{ n: "2", u: "d" }, { n: "3", u: "h" }]);
    expect(durationParts(72 * 60 * m)).toEqual([{ n: "3", u: "d" }]);
    expect(durationLabel((4 * 60 + 51) * m)).toBe("4h 51m");
    expect(utcHm("2026-10-11T06:27:00Z")).toBe("06:27");
    expect(utcHm(null)).toBeNull();
  });

  it("the recovery span: down from the first timeline entry to the last, green from the fix to now", () => {
    const span = recoverySpan(SYNC, NOW);
    expect(span.brokeAt).toBe("2026-10-11T01:36:00Z");
    expect(span.fixedAt).toBe("2026-10-11T06:27:00Z");
    expect(durationLabel(span.downMs!)).toBe("4h 51m");
    expect(durationLabel(span.upMs!)).toBe("8h 27m");
    // 4h51m of 13h18m: in proportion, inside the clamp.
    expect(span.split).toBeCloseTo(291 / 798, 3);
    // The middle entry (01:51) sits on the red stretch, 15 minutes into it.
    expect(span.marks).toEqual([Math.round((15 / 291) * span.split * 1000) / 1000]);
  });

  it("the recovery span without a timeline: start unknown, fixed at the item's time, green since", () => {
    const span = recoverySpan({ ...SYNC, timeline: undefined }, NOW);
    expect(span.brokeAt).toBeNull();
    expect(span.downMs).toBeNull();
    expect(span.fixedAt).toBe(SYNC.at);
    expect(durationLabel(span.upMs!)).toBe("5h");
    expect(span.split).toBe(SPLIT_UNKNOWN);
    expect(span.marks).toEqual([]);
    // One timed entry is not a span: it cannot say when it broke.
    expect(recoverySpan({ ...SYNC, timeline: [SYNC.timeline![0]!] }, NOW).downMs).toBeNull();
    // No time at all: no fix to draw.
    const blind = recoverySpan({ ...SYNC, at: null, timeline: undefined }, NOW);
    expect(blind.fixedAt).toBeNull();
    expect(blind.upMs).toBeNull();
  });

  it("the recovery span keeps both stretches readable: the split is clamped", () => {
    const long: BriefRecovered = { ...SYNC, timeline: [{ at: "2026-10-09T00:00:00Z", text: "Broke" }, { at: "2026-10-11T14:00:00Z", text: "Fixed" }] };
    expect(recoverySpan(long, NOW).split).toBe(SPLIT_MAX);
    const blip: BriefRecovered = { ...SYNC, timeline: [{ at: "2026-10-11T00:00:00Z", text: "Broke" }, { at: "2026-10-11T00:05:00Z", text: "Fixed" }] };
    expect(recoverySpan(blip, NOW).split).toBe(SPLIT_MIN);
    // A fix after `now` (clock skew) has no green stretch yet.
    expect(recoverySpan({ ...SYNC, timeline: undefined, at: "2026-10-11T15:30:00Z" }, NOW).upMs).toBeNull();
  });

  it("the +N more peek lists every row past the cap by plain title", () => {
    const rest = orderRecovered(seven()).slice(5);
    const p = moreRecoveredPeek(rest, NOW);
    expect(p.title).toBe("2 more recovered");
    expect(p.sections[0]!.lines!.map((l) => l.label)).toEqual(["Check 2 is green again", "Check 1 is green again"]);
    expect(p.sections[0]!.lines!.map((l) => l.state)).toEqual(["18h ago", "20h ago"]);
  });
});

describe("BriefResolved", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: { recovered: BriefRecovered[]; rows: number; prompts?: Record<string, string>; onlaunch?: (engine: string, prompt: string) => Promise<string | null> }) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { now: NOW, companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }], ...props } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  /** The big number and its two caption lines. */
  const stat = () => {
    const el = q('[data-testid="brief-resolved-stat"]');
    return el ? [el.querySelector(".dur-n")!.textContent, ...[...el.querySelectorAll(".dur-c > span")].map((s) => s.textContent)] : null;
  };
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

  it("renders nothing when nothing recovered: never an all-green filler", () => {
    render({ recovered: [], rows: 2 });
    expect(q('[data-testid="brief-resolved"]')).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  it("several recoveries: the green tile, the eyebrow, a count headline, five rows newest first, then +N more", async () => {
    render({ recovered: seven(), rows: 2 });
    const card = q('[data-testid="brief-resolved"]')!;
    expect(card.classList.contains("w")).toBe(true);
    expect(card.classList.contains("c-green")).toBe(true);
    expect(card.querySelector(".eyebrow")!.textContent!.trim()).toBe("Fixed since your last brief");
    expect(q('[data-testid="brief-resolved-headline"]')!.textContent).toBe("7 things recovered");
    // The count leads as its own big number.
    expect(q('[data-testid="brief-resolved-headline"] .count-n')!.textContent).toBe("7");
    const rows = qa('[data-testid="brief-resolved-row"]');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Check 7 is green again",
      "Check 6 is green again",
      "Check 5 is green again",
      "Check 4 is green again",
      "Check 3 is green again",
    ]);
    const more = q('[data-testid="brief-resolved-more"]')!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("2 more recovered");
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Check 2 is green again");
    expect(lines[1]).toContain("Check 1 is green again");
  });

  it("rows use product names and company logos, never a repo slug, PR number or commit prefix", () => {
    render({ recovered: seven(), rows: 2 });
    const text = q('[data-testid="brief-resolved"]')!.textContent!;
    expect(text).not.toContain("indigoai-us");
    expect(text).not.toMatch(/#\d+/);
    expect(text).not.toContain("fix(ci)");
    const products = qa('[data-testid="brief-resolved-product"]').map((el) => el.textContent);
    expect(products).toEqual(["Finance dashboard", "Sharing and deploys", "HQ command line", "Fleet", "Desktop app"]);
    expect(qa('[data-testid="brief-logo"]')).toHaveLength(5);
    expect(qa(".when").map((el) => el.textContent)).toEqual(["8h ago", "10h ago", "12h ago", "14h ago", "16h ago"]);
  });

  it("a one-row slot shows three rows then +N more", () => {
    render({ recovered: seven().slice(0, 5), rows: 1 });
    expect(qa('[data-testid="brief-resolved-row"]')).toHaveLength(3);
    expect(q('[data-testid="brief-resolved-more"]')!.textContent!.trim()).toBe("+2 more");
  });

  it("exactly five rows need no +N more", () => {
    render({ recovered: seven().slice(0, 5), rows: 2 });
    expect(qa('[data-testid="brief-resolved-row"]')).toHaveLength(5);
    expect(q('[data-testid="brief-resolved-more"]')).toBeNull();
  });

  it("one recovery in a tall slot: the title as the headline, its timeline capped at five with +N more, and the note prompt", async () => {
    const many: BriefRecovered = {
      ...SYNC,
      timeline: Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-11T0${i}:10:00Z`, text: `Step ${i + 1}` })),
    };
    const onlaunch = vi.fn(async () => null);
    render({ recovered: [many], rows: 2, onlaunch });
    expect(q('[data-testid="brief-resolved-headline"]')!.textContent).toBe("The nightly sync check is green again.");
    expect(q('[data-testid="brief-resolved-product"]')!.textContent).toBe("HQ Cloud");
    expect(q(".what")!.textContent).toBe("The retry fix landed and the 06:00 run passed");
    expect(qa('[data-testid="brief-resolved-row"]')).toHaveLength(0);
    const entries = qa('[data-testid="brief-resolved-timeline-entry"]');
    expect(entries).toHaveLength(5);
    expect(entries[0]!.textContent).toContain("00:10 UTC");
    expect(entries[0]!.textContent).toContain("Step 1");
    const moreTl = q('[data-testid="brief-resolved-timeline-more"]')!;
    expect(moreTl.textContent!.trim()).toBe("+2 more");
    await hover(moreTl);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("2 more in the timeline");
    expect([...q('[data-testid="brief-peek"]')!.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Step 6"), expect.stringContaining("Step 7")]),
    );

    // The row peek: the full timeline (the card scrolls rather than folding), evidence, and the prompt.
    await hover(q('[data-testid="brief-resolved-one"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Timeline");
    expect(peek.textContent).toContain("Evidence");
    expect(peek.textContent).toContain("Step 7");
    expect(peek.textContent).not.toMatch(/\+\d+ more/);
    expect(q('[data-testid="brief-peek-prompt"]')!.textContent).toMatch(/^Write the post-incident note for: /);

    // The one action says what it does; the engine it runs in is in its title and the switch.
    const start = q('[data-testid="brief-start"]') as HTMLButtonElement;
    expect(start.textContent!.trim()).toBe("Write post-incident note");
    expect(start.title).toBe("Write post-incident note in Claude");
    start.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledWith("claude", postIncidentNotePrompt(many));
  });

  it("post-incident variant: the writer's three lines replace the timeline, and a written prompt wins", async () => {
    const withNote: BriefRecovered = { ...SYNC, postIncident: { broke: "The vault route cap blocked deploys", did: "Removed the fleet route", changes: "Deploys retry once before paging" } };
    const onlaunch = vi.fn(async () => null);
    render({ recovered: [withNote], rows: 2, prompts: { "r-sync": "Draft the note for the sync outage." }, onlaunch });
    const pi = q('[data-testid="brief-resolved-post-incident"]')!;
    const lines = [...pi.children].map((el) => el.textContent);
    expect(lines).toEqual([
      "What brokeThe vault route cap blocked deploys",
      "What we didRemoved the fleet route",
      "What changesDeploys retry once before paging",
    ]);
    expect(q('[data-testid="brief-resolved-timeline"]')).toBeNull();
    (q('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("claude", "Draft the note for the sync outage.");
  });

  it("one recovery in a one-row slot keeps the headline, source line and the outage, with no timeline list or launch", () => {
    render({ recovered: [SYNC], rows: 1 });
    expect(q('[data-testid="brief-resolved-headline"]')!.textContent).toBe("The nightly sync check is green again.");
    expect(q('[data-testid="brief-resolved-product"]')!.textContent).toBe("HQ Cloud");
    expect(q(".when")!.textContent).toBe("5h ago");
    expect(q('[data-testid="brief-resolved-timeline"]')).toBeNull();
    expect(q('[data-testid="brief-launch"]')).toBeNull();
    // How long it was down still reads, as the number over the track.
    expect(q('[data-testid="brief-resolved-track"]')!.dataset.down).toBe("4h 51m");
    expect(stat()).toEqual(["4h51m", "down", "then fixed"]);
  });

  it("the track: how long it was down, red from the first entry, fixed at the last, then now", () => {
    render({ recovered: [SYNC], rows: 2 });
    const track = q('[data-testid="brief-resolved-track"]')!;
    expect(track.dataset.down).toBe("4h 51m");
    expect(stat()).toEqual(["4h51m", "down", "fixed 5h ago"]);
    expect(q('[data-testid="brief-resolved-broke"]')!.textContent).toBe("Red01:36");
    expect(q('[data-testid="brief-resolved-fixed"]')!.textContent).toBe("Fixed06:27 UTC");
    expect(track.querySelector(".red")!.classList.contains("fade")).toBe(false);
    expect(track.querySelectorAll(".mark")).toHaveLength(1);
    // The big number already says when it was fixed, so the source line does not repeat "5h ago".
    expect(q(".src .when")).toBeNull();
    expect(q(".src .via")!.textContent).toBe("main CI");
  });

  it("without a timeline the track fades in from an unknown start and the number is how long it has been green", () => {
    const gate: BriefRecovered = { id: "r1", title: "Staging main is green again", what: "The release gate passed", at: hoursAgo(5), source: "main_health", origin: origin("indigoai-us/hq-core-staging", "HQ core") };
    render({ recovered: [gate], rows: 2 });
    const track = q('[data-testid="brief-resolved-track"]')!;
    expect(track.dataset.down).toBeUndefined();
    expect(track.querySelector(".red")!.classList.contains("fade")).toBe(true);
    expect(stat()).toEqual(["5h", "green", "since the fix"]);
    expect(q('[data-testid="brief-resolved-broke"]')!.textContent).toBe("Red");
    expect(q('[data-testid="brief-resolved-fixed"]')!.textContent).toBe("Fixed09:54 UTC");
    expect(q('[data-testid="brief-resolved-timeline"]')).toBeNull();
    // In a one-row slot "5h ago" stays on the source line and there is no number to repeat it.
    unmount(app!);
    target.remove();
    render({ recovered: [gate], rows: 1 });
    expect(q('[data-testid="brief-resolved-stat"]')).toBeNull();
    expect(q(".when")!.textContent).toBe("5h ago");
    expect(q('[data-testid="brief-resolved-track"]')).not.toBeNull();
  });

  it("with no time at all there is no track to draw", () => {
    render({ recovered: [{ ...SYNC, at: null, timeline: undefined }], rows: 2 });
    expect(q('[data-testid="brief-resolved-track"]')).toBeNull();
    expect(q('[data-testid="brief-start"]')).not.toBeNull();
  });

  it("the note action follows the engine switch: pick Codex and it writes there", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ recovered: [SYNC], rows: 2, onlaunch });
    (q('[data-testid="brief-launch"] [data-engine="codex"]') as HTMLButtonElement).click();
    flushSync();
    const start = q('[data-testid="brief-start"]') as HTMLButtonElement;
    expect(start.textContent!.trim()).toBe("Write post-incident note");
    expect(start.title).toBe("Write post-incident note in Codex");
    start.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("codex", postIncidentNotePrompt(SYNC));
  });
});
