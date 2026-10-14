// @vitest-environment happy-dom
// The two hero cards on the page: Welcome back on a catch-up day (tiles, +N
// more, lead line, peeks with a launch) and Sunrise's meter.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { catchUpThursday, decision, hoursAgo, origin } from "./brief-catalogue-fixtures.js";
import type { BriefInput } from "./brief-types.js";

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

/** Four days away with an incident, three calls, a fix, two handoffs and two products shipped: six items, and the merged number. */
function awayDay(): BriefInput {
  const base = catchUpThursday();
  const now = base.now;
  return {
    ...base,
    decisions: [...base.decisions, decision("d3", "A third call that stays off the face")],
    risks: [
      {
        id: "p1",
        title: "HQ Cloud nightly sync is red",
        summary: "The nightly sync workflow has failed for two days.",
        severity: "incident",
        links: [],
        origin: origin("indigoai-us/hq-cloud", "HQ Cloud"),
        ci: { repo: "indigoai-us/hq-cloud", workflow: "nightly sync", job: null, since: hoursAgo(now, 48), ageHours: 48, note: null },
      },
    ],
    recovered: [
      { id: "r1", title: "Staging main is green again", what: "The release gate passed", at: hoursAgo(now, 5), source: "main_health", origin: origin("indigoai-us/hq-core-staging", "HQ core") },
    ],
    handoffs: [
      {
        id: "h1",
        object: "Pluto, live and dark for LiveRecover Supply",
        from: "Jacob",
        to: "Corey",
        me: true,
        production: true,
        since: hoursAgo(now, 30),
        receipts: { access: true, ack: false, active: null },
        origin: origin("indigoai-us/hq-pro", "HQ Pro"),
        prompt: "Acknowledge the Pluto handoff.",
      },
      {
        id: "h2",
        object: "The docs site",
        from: "Corey",
        to: "Stefan",
        me: false,
        production: false,
        since: hoursAgo(now, 20),
        receipts: { access: true, ack: true, active: true },
        origin: origin("indigoai-us/indigo-docs", "Docs"),
      },
    ],
    shipped: [
      { id: "ship:hq-pro", title: "hq-pro", status: "4 merged", note: "", origin: origin("indigoai-us/hq-pro", "HQ Pro"), lines: [] },
      { id: "ship:desktop", title: "hq-desktop-app", status: "7 merged", note: "", origin: origin("indigoai-us/hq-desktop-app"), lines: [] },
    ],
    merged: 11,
  };
}

/** The local YYYY-MM-DD of a time, the way the orbit reads the away window. */
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("Welcome back", () => {
  it("leads the catch-up page: days away, what moved, priority 1 featured with its because, then four ranked rows and +1 more", () => {
    const input = awayDay();
    render(input);
    const card = q("brief-catchup")!;
    expect(card.closest("[data-widget]")!.getAttribute("data-widget")).toBe("catchup");
    expect(card.textContent).toContain("Welcome back · 4 days at a glance");
    expect(q("brief-catchup-days")!.textContent).toBe("4");
    expect(card.textContent).toContain("4days away");
    // The greeting says since when; it never repeats the lead, which is the featured block.
    expect(q("brief-catchup-greet")!.textContent).toMatch(/^Here's what changed since \w+'s brief\.$/);
    expect(q("brief-catchup-greet")!.textContent).not.toContain("Approve the Q4 plan");
    expect(q("brief-catchup-lead")!.textContent).toBe("Approve the Q4 plan");
    expect(q("brief-catchup-first")!.textContent).toBe("The team plans around it.");
    const tiles = qa("brief-catchup-tile");
    expect(tiles).toHaveLength(5);
    // Priority 1 first and featured (with its start control); the rest keep the catalogue's order.
    expect(tiles[0]!.getAttribute("data-featured")).toBe("true");
    expect(tiles[0]!.contains(q("brief-catchup-lead"))).toBe(true);
    expect(tiles[0]!.querySelector('[data-testid="brief-start"]')).not.toBeNull();
    expect(tiles.slice(1).every((t) => !t.hasAttribute("data-featured"))).toBe(true);
    expect(tiles.map((t) => t.getAttribute("data-tone"))).toEqual(["decision", "red", "decision", "ok", "decision"]);
    expect(tiles.map((t) => t.querySelector(".tag")!.textContent!.split(" · ").pop())).toEqual(["WAITING ON YOU", "INCIDENT", "WAITING ON YOU", "FIXED", "NOW YOURS"]);
    // The tag is read out but not shown; each list row shows its product instead.
    expect(tiles.every((t) => t.querySelector(".tag")!.classList.contains("sr"))).toBe(true);
    expect(tiles.slice(1).filter((t) => t.querySelector(".orgs [data-testid='brief-origin-label']")).length).toBeGreaterThan(0);
    // The two calls are the ones the catalogue ranked first; the third stays off the face.
    expect(tiles[0]!.textContent).toContain("Approve the Q4 plan");
    expect(tiles[2]!.textContent).toContain("Pick the launch date");
    expect(tiles.slice(1).map((t) => t.querySelector(".rk")!.textContent)).toEqual(["02", "03", "04", "05"]);
    expect(card.textContent).not.toContain("A third call");
    expect(q("brief-catchup-more")!.textContent!.trim()).toBe("+1 more");
    expect(card.textContent).toContain("Everything else can wait for a normal brief tomorrow.");
    // What moved: the calls waiting on you (all three, in focus), what merged, then the away window's meetings and sessions.
    const stats = qa("brief-catchup-stat");
    expect(stats.map((s) => s.getAttribute("data-stat"))).toEqual(["waiting", "merged", "meetings", "sessions"]);
    expect(stats.map((s) => s.querySelector(".sv")!.textContent).slice(0, 2)).toEqual(["3", "11"]);
    expect(stats[0]!.classList.contains("focus")).toBe(true);
    expect(stats.slice(1).some((s) => s.classList.contains("focus"))).toBe(false);
    // Shipped is the merged number, not a row.
    expect(tiles.some((t) => t.textContent!.includes("11 merged"))).toBe(false);
    // One orbit dot per away day the brief has stats for, then today.
    const away = (input.days ?? []).filter((d) => d.date >= localDate(input.lastBriefAt!) && d.date < input.today!);
    expect(qa("brief-catchup-day")).toHaveLength(away.length);
    expect(away.length).toBeGreaterThan(0);
    expect(q("brief-catchup-orbit")!.textContent).toContain("Today");
  });

  it("items carry company logos and product names, never a repo slug", () => {
    render(awayDay());
    const card = q("brief-catchup")!;
    expect(card.textContent).not.toContain("indigoai-us");
    const labels = [...card.querySelectorAll('[data-testid="brief-origin-label"]')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["HQ Cloud", "Desktop app", "HQ core", "HQ Pro"]));
    expect(card.querySelectorAll('[data-testid="brief-logo"]').length).toBeGreaterThanOrEqual(5);
  });

  it("the featured call peeks to the decision with its prompt and starts it in the chosen engine", async () => {
    const onlaunch = vi.fn(async () => null);
    render(awayDay(), { onlaunch });
    await hover(qa("brief-catchup-tile")[0]!);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Approve the Q4 plan");
    expect(q("brief-peek-prompt")).not.toBeNull();
    const start = peek.querySelector<HTMLButtonElement>('[data-testid="brief-start"]')!;
    expect(start.textContent).toContain("Start in Claude");
    start.click();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("claude", expect.stringContaining("Approve the Q4 plan"));
  });

  it("the featured call starts straight from the card, then reads as done", async () => {
    const onlaunch = vi.fn(async () => null);
    render(awayDay(), { onlaunch });
    const lead = qa("brief-catchup-tile")[0]!;
    const start = lead.querySelector<HTMLButtonElement>('[data-testid="brief-start"]')!;
    expect(start.textContent).toContain("Start in Claude");
    start.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    expect(onlaunch).toHaveBeenCalledWith("claude", expect.stringContaining("Approve the Q4 plan"));
    expect(lead.classList.contains("done")).toBe(true);
    expect(lead.querySelector('[data-testid="brief-start"]')).toBeNull();
    expect(lead.textContent).toContain("Done");
    expect(lead.textContent).toContain("Started in Claude.");
  });

  it("the handoff row peeks to its receipts and the +N more row lists what did not fit", async () => {
    render(awayDay());
    await hover(qa("brief-catchup-tile")[4]!);
    let peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Pluto, live and dark for LiveRecover Supply");
    expect(peek.textContent).toContain("Acknowledged");
    expect(peek.textContent).toContain("WAITING");
    expect(peek.textContent).toContain("Acknowledge the Pluto handoff.");
    await hover(q("brief-catchup-more")!);
    peek = q("brief-peek")!;
    expect(peek.textContent).toContain("1 more change");
    expect(peek.textContent).toContain("The docs site");
    expect(peek.textContent).toContain("HANDED OFF");
  });

  it("the numbers peek below the row, never beside it, so the next number stays reachable", async () => {
    render(awayDay());
    for (const stat of qa("brief-catchup-stat")) {
      await hover(stat);
      expect(q("brief-peek")!.classList.contains("b")).toBe(true);
    }
  });

  it("the numbers peek: the merged number lists what shipped by product, waiting lists every call", async () => {
    render(awayDay());
    const [waiting, merged] = qa("brief-catchup-stat");
    await hover(merged!);
    let peek = q("brief-peek")!;
    expect(peek.textContent).toContain("11 merged");
    expect(peek.textContent).toContain("HQ Pro");
    expect(peek.textContent).toContain("Desktop app");
    expect(peek.textContent).not.toContain("indigoai-us");
    await hover(waiting!);
    peek = q("brief-peek")!;
    expect(peek.textContent).toContain("3 calls wait on you");
    expect(peek.textContent).toContain("A third call that stays off the face");
  });

  it("an orbit day peeks that day's numbers", async () => {
    render(awayDay());
    const day = qa("brief-catchup-day")[0]!;
    await hover(day);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain(day.getAttribute("aria-label")!);
    expect(peek.textContent).toContain("Sessions");
    expect(peek.textContent).toContain("Merged");
  });

  it("priority 1 with no item on the card still leads, in the writer's words, with no start", () => {
    const base = awayDay();
    render({ ...base, priorities: [{ n: 1, text: "Reply to the auditor", because: "Still open", itemId: "c1" }, ...(base.priorities ?? []).slice(1)] });
    expect(q("brief-catchup-lead")!.textContent).toBe("Reply to the auditor");
    expect(q("brief-catchup-first")!.textContent).toBe("Still open.");
    const tiles = qa("brief-catchup-tile");
    expect(tiles.some((t) => t.hasAttribute("data-featured"))).toBe(false);
    expect(q("brief-catchup-lead")!.closest('[data-featured="true"]')!.querySelector('[data-testid="brief-start"]')).toBeNull();
    // Nothing featured from the items, so five rows fit before +N more.
    expect(tiles).toHaveLength(5);
    expect(tiles[0]!.querySelector(".rk")!.textContent).toBe("02");
  });

  it("asked for a catch-up without being away: no days number, the orbit runs from the last brief to today", () => {
    const base = awayDay();
    render({ ...base, catchUp: true, lastBriefAt: hoursAgo(base.now, 20) });
    expect(q("brief-catchup")).not.toBeNull();
    expect(q("brief-catchup-days")).toBeNull();
    expect(qa("brief-catchup-day")).toHaveLength(0);
    expect(q("brief-catchup-orbit")!.textContent).toContain("Last brief");
    expect(q("brief-catchup-orbit")!.textContent).toContain("Today");
    expect(q("brief-catchup-greet")!.textContent).toMatch(/^Here's what changed since (yesterday's|this morning's) brief\.$/);
    expect(q("brief-catchup-lead")!.textContent).toBe("Approve the Q4 plan");
  });

  it("stays honest on a catch-up day with nothing behind it", () => {
    render({ ...catchUpThursday(), decisions: [], priorities: [], shipped: [], merged: null });
    expect(q("brief-catchup-greet")!.textContent).toMatch(/^Here's what changed since \w+'s brief\.$/);
    expect(q("brief-catchup-lead")).toBeNull();
    expect(q("brief-catchup-first")).toBeNull();
    expect(qa("brief-catchup-tile")).toHaveLength(0);
    expect(q("brief-catchup-quiet")).not.toBeNull();
    // Nothing waits on you: the number says 0 and is not in focus.
    const waiting = qa("brief-catchup-stat")[0]!;
    expect(waiting.querySelector(".sv")!.textContent).toBe("0");
    expect(waiting.classList.contains("focus")).toBe(false);
  });
});

describe("Sunrise meter", () => {
  it("shows no time estimate until the page hands one in", () => {
    const base = catchUpThursday();
    render({ ...base, lastBriefAt: hoursAgo(base.now, 20) });
    expect(q("brief-sunrise")).not.toBeNull();
    expect(q("brief-sunrise-eta")).toBeNull();
    expect(q("brief-sunrise")!.textContent).toContain("2 decisions before sunrise.");
  });
});
