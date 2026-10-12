// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefHandoffsHost from "./BriefHandoffsHost.svelte";
import {
  HANDOFF_ROWS,
  HANDOFF_ROWS_SHORT,
  ackPrompt,
  ageText,
  handoffHeadline,
  handoffPeek,
  handoffStatus,
  hoursSince,
  landed,
  moreHandoffsPeek,
  needsMyAck,
  nudgePrompt,
  promptFor,
  rankHandoffs,
  receiptHot,
  receiptLines,
  receiptState,
} from "./brief-handoffs.js";
import type { BriefHandoff, BriefOrigin } from "./brief-types.js";

const NOW = "2026-10-11T15:00:00.000Z";
const hoursAgo = (h: number): string => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const origin = (companyUid: string, repo: string | null, product: string): BriefOrigin => ({ companyUid, repo, product });

/** The real instance: Yousuf handed Pluto to Corey, live and dark for LiveRecover Supply, 30h ago, access unknown. */
const pluto: BriefHandoff = {
  id: "h-pluto",
  object: "Pluto",
  from: "Yousuf",
  to: "Corey",
  me: true,
  production: true,
  since: hoursAgo(30),
  receipts: { access: null, ack: false, active: false },
  note: "Live in production for LiveRecover Supply, dark flag.",
  origin: origin("liverecover", "liverecover/pluto", "LiveRecover Supply"),
};
const memo: BriefHandoff = {
  id: "h-memo",
  object: "Investor memo folder",
  from: "Izzy",
  to: "Jacob",
  me: false,
  production: false,
  since: hoursAgo(6),
  receipts: { access: true, ack: false, active: false },
  note: "Jacob now owns it and needs to acknowledge.",
  origin: origin("indigo", null, "Vault"),
};
const liveops: BriefHandoff = {
  id: "h-liveops",
  object: "Liveops",
  from: "Hassaan",
  to: "Stefan",
  me: false,
  production: false,
  since: hoursAgo(20),
  receipts: { access: true, ack: true, active: true },
  origin: origin("indigo", "indigoai-us/hq-core", "HQ core"),
};
const billing: BriefHandoff = {
  id: "h-billing",
  object: "Billing fix",
  from: "Corey",
  to: "Hassaan",
  me: false,
  production: true,
  since: hoursAgo(3),
  receipts: { access: true, ack: false, active: null },
  origin: origin("indigo", "indigoai-us/hq-pro", "HQ Pro"),
};
const three = [liveops, memo, pluto];

const many = (n: number): BriefHandoff[] =>
  Array.from({ length: n }, (_, i) => ({
    ...memo,
    id: `h-${i}`,
    object: `Thing ${i}`,
    since: hoursAgo(1 + i),
  }));

describe("receipts", () => {
  it("true is done, false is missing, null is unknown and never done", () => {
    expect(receiptState(true)).toBe("done");
    expect(receiptState(false)).toBe("missing");
    expect(receiptState(null)).toBe("unknown");
    expect(landed(liveops)).toBe(true);
    expect(landed({ ...liveops, receipts: { access: true, ack: true, active: null } })).toBe(false);
    expect(needsMyAck(pluto)).toBe(true);
    expect(needsMyAck({ ...pluto, receipts: { ...pluto.receipts, ack: true } })).toBe(false);
    expect(needsMyAck(memo)).toBe(false);
  });

  it("turns amber only when not done and the row is overdue (> 24h) or in production", () => {
    expect(receiptHot(pluto, "access", NOW)).toBe(true); // production, unknown
    expect(receiptHot(pluto, "ack", NOW)).toBe(true); // production, missing
    expect(receiptHot(memo, "ack", NOW)).toBe(false); // 6h, not production
    expect(receiptHot({ ...memo, since: hoursAgo(25) }, "ack", NOW)).toBe(true); // overdue
    expect(receiptHot({ ...memo, since: hoursAgo(25) }, "access", NOW)).toBe(false); // done is never hot
    expect(receiptHot(billing, "active", NOW)).toBe(true); // production, unknown
    expect(receiptLines(pluto, NOW)).toEqual([
      { label: "Access", state: "UNKNOWN", tone: "warn" },
      { label: "Ack", state: "MISSING", tone: "warn" },
      { label: "Active", state: "MISSING", tone: "warn" },
    ]);
    expect(receiptLines(liveops, NOW).every((l) => l.state === "DONE" && l.tone === "ok")).toBe(true);
  });
});

describe("rank and words", () => {
  it("me and production first, then production, then the rest oldest first, landed last; stable across input order", () => {
    const expected = ["h-pluto", "h-billing", "h-memo", "h-liveops"];
    expect(rankHandoffs([liveops, memo, billing, pluto], NOW).map((h) => h.id)).toEqual(expected);
    expect(rankHandoffs([pluto, billing, memo, liveops], NOW).map((h) => h.id)).toEqual(expected);
    const older = { ...memo, id: "h-older", since: hoursAgo(10) };
    expect(rankHandoffs([memo, older], NOW).map((h) => h.id)).toEqual(["h-older", "h-memo"]);
    const mineLater = { ...pluto, id: "h-mine-2", production: false };
    expect(rankHandoffs([billing, mineLater], NOW).map((h) => h.id)).toEqual(["h-mine-2", "h-billing"]);
  });

  it("headline: yours to acknowledge, N handoffs · M landed, or All N landed", () => {
    expect(handoffHeadline(three)).toBe("1 handoff is yours to acknowledge");
    expect(handoffHeadline([pluto, { ...pluto, id: "p2" }])).toBe("2 handoffs are yours to acknowledge");
    expect(handoffHeadline([liveops, memo, billing])).toBe("3 handoffs · 1 landed");
    expect(handoffHeadline([liveops, { ...liveops, id: "l2" }, { ...liveops, id: "l3" }])).toBe("All 3 handoffs landed");
    expect(handoffHeadline([liveops])).toBe("1 handoff landed");
    expect(handoffHeadline([])).toBe("");
  });

  it("ages and statuses are plain words with no locale formatting", () => {
    expect(hoursSince(hoursAgo(6), NOW)).toBe(6);
    expect(hoursSince("nope", NOW)).toBeNull();
    expect(ageText(0.4)).toBe("under an hour");
    expect(ageText(6)).toBe("6h");
    expect(ageText(50)).toBe("2 days");
    expect(ageText(null)).toBe("");
    expect(handoffStatus(liveops, NOW)).toEqual({ text: "Landed", tone: "ok" });
    expect(handoffStatus(pluto, NOW)).toEqual({ text: "Yours to acknowledge", tone: "warn" });
    expect(handoffStatus(memo, NOW)).toEqual({ text: "In the air · 6h", tone: "neutral" });
    expect(handoffStatus(billing, NOW)).toEqual({ text: "In the air · 3h", tone: "warn" });
  });

  it("prompts: the run's prompt wins, then the item's, then a built-in; landed rows have none; nudges never send", () => {
    expect(promptFor(pluto, { "h-pluto": "Run prompt" })).toBe("Run prompt");
    expect(promptFor({ ...pluto, prompt: "Own prompt" }, {})).toBe("Own prompt");
    expect(promptFor(pluto, {})).toBe(ackPrompt(pluto));
    expect(promptFor(memo, {})).toBe(nudgePrompt(memo));
    expect(promptFor(liveops, { "h-liveops": "x" })).toBeUndefined();
    expect(ackPrompt(pluto)).toContain("Pluto from Yousuf");
    expect(ackPrompt(pluto)).toContain("live in production");
    expect(nudgePrompt(memo)).toContain("DM to Jacob");
    expect(nudgePrompt(memo)).toContain("Do not send it");
  });

  it("peek: giver → receiver, product origin, receipts, production flag, note, and an Acknowledge prompt on your rows", () => {
    const p = handoffPeek(pluto, "Run prompt", NOW);
    expect(p.eyebrow).toBe("Handoff · Yousuf → Corey · 30h ago");
    expect(p.origin).toEqual({ companyUid: "liverecover", label: "LiveRecover Supply" });
    expect(p.title).toBe("Pluto");
    expect(p.status).toBe("Yours to acknowledge");
    expect(p.sections.map((s) => s.label)).toEqual(["Receipts", "Production", "From Yousuf"]);
    expect(p.sections[1]).toMatchObject({ tone: "warn", text: "Pluto is live in production." });
    expect(p.sections[2]!.text).toBe(pluto.note);
    expect(p.prompt).toEqual({ id: "h-pluto", text: "Run prompt", verb: "Acknowledge" });
    const q = handoffPeek(liveops, undefined, NOW);
    expect(q.sections.map((s) => s.label)).toEqual(["Receipts"]);
    expect(q.prompt).toBeUndefined();
    expect(handoffPeek(memo, "n", NOW).prompt?.verb).toBe("Start");
    const more = moreHandoffsPeek([memo, liveops], NOW);
    expect(more.title).toBe("2 more handoffs");
    expect(more.sections[0]!.lines!.map((l) => l.label)).toEqual(["Investor memo folder · Izzy → Jacob", "Liveops · Hassaan → Stefan"]);
    expect(more.sections[0]!.lines![1]).toMatchObject({ state: "LANDED", tone: "ok" });
  });
});

describe("BriefHandoffs card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefHandoffsHost, { target, props: { now: NOW, rows: 2, prompts: {}, handoffs: three, ...props } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  const row = (id: string) => q(`[data-handoff="${id}"]`)!;
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

  it("eyebrow, headline, and rows in rank order; the row that is yours comes first with the amber receiving ring", () => {
    render({});
    expect(q(".eyebrow")!.textContent!.trim()).toBe("Ownership moved");
    expect(q('[data-testid="brief-handoffs-title"]')!.textContent).toBe("1 handoff is yours to acknowledge");
    expect(qa('[data-testid="brief-handoff"]').map((el) => el.dataset.handoff)).toEqual(["h-pluto", "h-memo", "h-liveops"]);
    const first = row("h-pluto");
    expect(first.classList.contains("me")).toBe(true);
    expect(first.querySelector(".ar .ring.hot")).not.toBeNull();
    expect(row("h-memo").querySelector(".ar .ring.hot")).toBeNull();
    expect(row("h-memo").querySelector(".ar .ring")).not.toBeNull();
    expect(first.querySelector('[data-testid="brief-handoff-from"]')!.textContent).toBe("Y");
    expect(first.querySelector('[data-testid="brief-handoff-to"]')!.textContent).toBe("C");
    expect(q('[data-testid="brief-handoffs-foot"]')!.textContent).toContain("1 of 3 landed");
  });

  it("dashed arrow with a travelling baton until acked, then solid with an arrowhead", () => {
    render({});
    const inAir = row("h-memo").querySelector('[data-testid="brief-handoff-arrow"]')!;
    expect(inAir.getAttribute("data-acked")).toBe("false");
    expect(inAir.querySelector(".track")!.getAttribute("stroke-dasharray")).toBe("3 3");
    expect(inAir.querySelector(".baton")).not.toBeNull();
    expect(inAir.querySelector(".head")).toBeNull();
    const done = row("h-liveops").querySelector('[data-testid="brief-handoff-arrow"]')!;
    expect(done.getAttribute("data-acked")).toBe("true");
    expect(done.querySelector(".track")!.hasAttribute("stroke-dasharray")).toBe(false);
    expect(done.querySelector(".head")).not.toBeNull();
    expect(done.querySelector(".baton")).toBeNull();
  });

  it("receipt dots: unknown renders '?' and is never green; missing ones on a production row ring amber", () => {
    render({});
    const dots = [...row("h-pluto").querySelectorAll<HTMLElement>('[data-testid="brief-receipt"]')];
    expect(dots.map((d) => d.dataset.receipt)).toEqual(["access", "ack", "active"]);
    expect(dots[0]!.dataset.state).toBe("unknown");
    expect(dots[0]!.classList.contains("unknown")).toBe(true);
    expect(dots[0]!.classList.contains("done")).toBe(false);
    expect(dots[0]!.getAttribute("aria-label")).toBe("Access unknown");
    expect(dots.every((d) => d.classList.contains("hot"))).toBe(true);
    const memoDots = [...row("h-memo").querySelectorAll<HTMLElement>('[data-testid="brief-receipt"]')];
    expect(memoDots[0]!.classList.contains("done")).toBe(true);
    expect(memoDots.some((d) => d.classList.contains("hot"))).toBe(false);
    const landedDots = [...row("h-liveops").querySelectorAll<HTMLElement>('[data-testid="brief-receipt"]')];
    expect(landedDots.every((d) => d.classList.contains("done"))).toBe(true);
  });

  it("five rows then '+N more' whose peek lists the rest; three rows on a one-row card", async () => {
    render({ handoffs: many(8) });
    expect(qa('[data-testid="brief-handoff"]')).toHaveLength(HANDOFF_ROWS);
    const more = q('[data-testid="brief-handoffs-more"]')!;
    expect(more.textContent!.trim()).toBe("+3 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("3 more handoffs");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(3);
    // Oldest first: the three newest rows are the ones left over.
    expect(peek.textContent).toContain("Thing 0");
    expect(peek.textContent).toContain("Thing 2");
    expect(peek.textContent).not.toContain("Thing 7");
    expect(q('[data-testid="brief-handoffs-foot"]')!.textContent).toContain("0 of 8 landed");

    if (app) unmount(app);
    render({ handoffs: many(8), rows: 1 });
    expect(qa('[data-testid="brief-handoff"]')).toHaveLength(HANDOFF_ROWS_SHORT);
    expect(q('[data-testid="brief-handoffs-more"]')!.textContent!.trim()).toBe("+5 more");
    expect(q('[data-testid="brief-handoffs-foot"]')).toBeNull();
  });

  it("the object carries its company logo and product name via BriefLogo / BriefOrigin", () => {
    render({ companies: [{ uid: "liverecover", label: "LiveRecover", iconUrl: null }] });
    const first = row("h-pluto");
    expect(first.querySelector('[data-testid="brief-handoff-object"]')!.textContent).toBe("Pluto");
    expect(first.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    expect(first.querySelector('[data-testid="brief-origin-label"]')!.textContent).toBe("LiveRecover Supply");
    // No company list: the logo still shows as a monogram, never nothing.
    if (app) unmount(app);
    render({});
    expect(row("h-pluto").querySelector('[data-testid="brief-logo-monogram"]')).not.toBeNull();
  });

  it("Acknowledge starts your row in the engine with its prompt and marks it done; Nudge copies a DM draft and launches nothing; landed rows have no action", async () => {
    const launch = vi.fn(async () => null);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render({ launch, prompts: { "h-pluto": "Acknowledge Pluto now." } });
    const mine = row("h-pluto");
    expect(mine.querySelector('[data-testid="brief-handoff-ack"]')!.textContent).toBe("Acknowledge");
    expect(mine.querySelector('[data-testid="brief-handoff-nudge"]')).toBeNull();
    (mine.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(launch).toHaveBeenCalledWith("claude", "Acknowledge Pluto now.");
    expect(mine.classList.contains("done")).toBe(true);
    expect(mine.textContent).toContain("Done");

    const theirs = row("h-memo");
    expect(theirs.querySelector('[data-testid="brief-start"]')).toBeNull();
    const nudge = theirs.querySelector('[data-testid="brief-handoff-nudge"]') as HTMLButtonElement;
    expect(nudge.textContent!.trim()).toBe("Nudge");
    nudge.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(writeText).toHaveBeenCalledWith(nudgePrompt(memo));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(nudge.textContent!.trim()).toBe("Copied");

    const landedRow = row("h-liveops");
    expect(landedRow.querySelector(".acts")).toBeNull();
  });

  it("a row's peek shows the giver's note, the receipts, the production flag and the prompt", async () => {
    render({ prompts: { "h-pluto": "Acknowledge Pluto now." } });
    await hover(row("h-pluto"));
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.querySelector('[data-testid="brief-peek-eyebrow"]')!.textContent).toBe("Handoff · Yousuf → Corey · 30h ago");
    expect(peek.querySelector(".ttl")!.textContent).toBe("Pluto");
    expect(peek.textContent).toContain("Receipts");
    expect(peek.textContent).toContain("UNKNOWN");
    expect(peek.textContent).toContain("Production");
    expect(peek.textContent).toContain("From Yousuf");
    expect(peek.textContent).toContain(pluto.note!);
    expect(peek.querySelector('[data-testid="brief-peek-prompt"]')!.textContent).toBe("Acknowledge Pluto now.");
  });

  it("quiet state when everything landed, and nothing at all when there are no handoffs", () => {
    render({ handoffs: [liveops, { ...liveops, id: "l2", object: "Docs site" }] });
    expect(q('[data-testid="brief-handoffs-title"]')!.textContent).toBe("All 2 handoffs landed");
    expect(qa(".acts")).toHaveLength(0);
    expect(q('[data-testid="brief-handoffs-more"]')).toBeNull();
    if (app) unmount(app);
    render({ handoffs: [] });
    expect(q('[data-testid="brief-handoffs"]')).toBeNull();
  });
});
