// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefFocusHost from "./fixtures/BriefFocusHost.svelte";
import {
  FOCUS_CAP,
  FOCUS_ONE_ROW_CAP,
  contextSwitches,
  focusGroups,
  focusHeadline,
  focusSessions,
  focusSummary,
  hasFocus,
  productKey,
  sessionLabel,
  tileLayout,
} from "./brief-focus.js";
import { clockLabel } from "./brief-time.js";
import type { BriefSession } from "./brief-types.js";

const NOW = "2026-10-11T22:30:00.000Z";
const INDIGO = "cmp_indigo";
const COMPANIES = [INDIGO, "liverecover"];
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

let seq = 0;
const session = (product: string, hoursBack: number, over: Partial<BriefSession> = {}): BriefSession => {
  seq += 1;
  return { id: `s${seq}`, title: `Work on ${product} ${seq}`, startedAt: hoursAgo(hoursBack), workstream: "Work", company: INDIGO, product, ...over };
};

/**
 * A Sunday: seven own sessions across three products, oldest first
 * Desktop, Cloud, Desktop, core, Desktop, Cloud, Desktop (six switches), plus
 * noise the card must drop: another company's session, an agent session, and
 * a session older than the window.
 */
function day(): BriefSession[] {
  seq = 0;
  return [
    session("Desktop app", 20, { title: "hq-desktop-app #412: feat(brief): focus card treemap" }),
    session("HQ Cloud", 18),
    session("Desktop app", 15),
    session("HQ core", 12),
    session("Desktop app", 9),
    session("HQ Cloud", 6),
    session("Desktop app", 2, { title: "" }),
    session("Ramen Bae", 10, { company: "cmp_other", title: "SECRET other-company work" }),
    session("Desktop app", 5, { kind: "agent", title: "AGENT lane run" }),
    session("CLI", 30, { title: "STALE yesterday morning" }),
  ];
}

describe("focus helpers", () => {
  it("keys a session by product, then project, then workstream, like the picker", () => {
    const base = session("Desktop app", 1);
    expect(productKey(base)).toBe("Desktop app");
    expect(productKey({ ...base, product: null, project: " hq-pro " })).toBe("hq-pro");
    expect(productKey({ ...base, product: undefined, project: undefined, workstream: "Work" })).toBe("Work");
  });

  it("keeps only your own sessions inside the brief's companies and the window, oldest first", () => {
    const own = focusSessions(day(), COMPANIES, NOW);
    expect(own).toHaveLength(7);
    expect(own.map((s) => s.product)).toEqual(["Desktop app", "HQ Cloud", "Desktop app", "HQ core", "Desktop app", "HQ Cloud", "Desktop app"]);
    expect(own.some((s) => s.company === "cmp_other")).toBe(false);
    expect(own.some((s) => s.kind === "agent")).toBe(false);
    expect(own.some((s) => s.product === "CLI")).toBe(false);
    // A session with no company is yours; company matching ignores case.
    expect(focusSessions([session("X", 1, { company: null })], COMPANIES, NOW)).toHaveLength(1);
    expect(focusSessions([session("X", 1, { company: "CMP_INDIGO" })], COMPANIES, NOW)).toHaveLength(1);
  });

  it("groups by product, busiest first then by name, with share and the group's company", () => {
    const groups = focusGroups(focusSessions(day(), COMPANIES, NOW));
    expect(groups.map((g) => [g.name, g.count])).toEqual([
      ["Desktop app", 4],
      ["HQ Cloud", 2],
      ["HQ core", 1],
    ]);
    expect(groups[0]!.share).toBeCloseTo(4 / 7);
    expect(groups[0]!.company).toBe(INDIGO);
    expect(groups[0]!.sessions.map((s) => s.startedAt)).toEqual([hoursAgo(20), hoursAgo(15), hoursAgo(9), hoursAgo(2)]);
  });

  it("counts context switches as product transitions in time order", () => {
    expect(contextSwitches(focusSessions(day(), COMPANIES, NOW))).toBe(6);
    expect(contextSwitches([session("A", 3), session("A", 2), session("A", 1)])).toBe(0);
    // Order of the input does not matter; time does: A (3h ago), B (2h), A (1h) is two switches.
    expect(contextSwitches([session("A", 1), session("B", 2), session("A", 3)])).toBe(2);
    // B (3h ago), A (2h), A (1h) is one.
    expect(contextSwitches([session("A", 1), session("B", 3), session("A", 2)])).toBe(1);
  });

  it("headline: mostly the busiest product, or a split when the top two tie", () => {
    const groups = focusGroups(focusSessions(day(), COMPANIES, NOW));
    expect(focusHeadline(groups)).toBe("Mostly Desktop app");
    expect(focusHeadline(focusGroups([session("A", 1), session("B", 2)]))).toBe("Split between A and B");
    expect(focusHeadline([])).toBe("");
  });

  it("summary carries total, switches, first and last; the gate is 3 sessions across 2 products", () => {
    const sum = focusSummary(day(), COMPANIES, NOW);
    expect(sum.total).toBe(7);
    expect(sum.switches).toBe(6);
    expect(sum.first).toBe(hoursAgo(20));
    expect(sum.last).toBe(hoursAgo(2));
    expect(hasFocus(sum)).toBe(true);
    expect(hasFocus(focusSummary([session("A", 1), session("B", 2)], COMPANIES, NOW))).toBe(false);
    expect(hasFocus(focusSummary([session("A", 1), session("A", 2), session("A", 3)], COMPANIES, NOW))).toBe(false);
    expect(hasFocus(focusSummary([session("A", 1), session("A", 2), session("B", 3)], COMPANIES, NOW))).toBe(true);
  });

  it("session labels are plain to-dos: no repo, PR number or commit prefix", () => {
    expect(sessionLabel("hq-core #1217: feat(conduct): on by default in v16")).toBe("On by default in v16");
    expect(sessionLabel("Weekend fix")).toBe("Weekend fix");
    expect(sessionLabel("   ")).toBe("Untitled session");
  });

  it("treemap layouts never leave an empty cell", () => {
    const cells = (n: number) => {
      const l = tileLayout(n);
      const cols = l.columns.split(" ").length;
      return cols * l.rows - (l.spanFirst ? 1 : 0) - (l.spanLast ? 1 : 0);
    };
    for (const n of [2, 3, 4, 5, 6]) expect(cells(n)).toBe(n);
    expect(tileLayout(5)).toEqual({ columns: "2fr 1fr 1fr", rows: 2, spanFirst: true, spanLast: false });
    expect(tileLayout(6).spanFirst).toBe(false);
  });
});

describe("BriefFocus", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(sessions: BriefSession[], props: Record<string, unknown> = {}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFocusHost, {
      target,
      props: { sessions, companies: COMPANIES, now: NOW, cols: 2, rows: 2, logos: [{ uid: INDIGO, label: "Indigo", iconUrl: null }], ...props },
    });
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

  it("renders the eyebrow, headline, tiles by count with the ice bar on the busiest, and the footer", () => {
    render(day());
    const card = q('[data-testid="brief-focus"]')!;
    expect(card.querySelector(".eyebrow")!.textContent!.replace(/\s+/g, " ").trim()).toBe("Where your day went · 7 sessions");
    expect(q('[data-testid="brief-focus-head"]')!.textContent).toBe("Mostly Desktop app");
    const tiles = qa('[data-testid="brief-focus-tile"]');
    expect(tiles.map((t) => t.dataset.product)).toEqual(["Desktop app", "HQ Cloud", "HQ core"]);
    expect(tiles.map((t) => t.querySelector(".n")!.textContent)).toEqual(["4 sessions", "2 sessions", "1 session"]);
    // The lead tile says its share of the day in words (no unlabelled bar).
    expect(tiles[0]!.querySelector('[data-testid="brief-focus-share"]')!.textContent).toBe("57% of your day");
    expect(tiles[1]!.querySelector('[data-testid="brief-focus-share"]')).toBeNull();
    // ...and as a bar under it, filled to the same share.
    expect(tiles[0]!.querySelector('[data-testid="brief-focus-bar"]')!.getAttribute("style")).toMatch(/width:\s*57%/);
    expect(tiles[1]!.querySelector('[data-testid="brief-focus-bar"]')).toBeNull();
    expect(tiles[0]!.querySelectorAll('[data-testid="brief-logo"]')).toHaveLength(1);
    const foot = q('[data-testid="brief-focus-foot"]')!.textContent!.replace(/\s+/g, " ").trim();
    expect(foot).toBe(`6 context switches first ${clockLabel(hoursAgo(20))} · last ${clockLabel(hoursAgo(2))}`);
    expect(q('[data-testid="brief-focus-more"]')).toBeNull();
  });

  it("never names another company's session, an agent's, or one outside the window", () => {
    render(day());
    const text = target.textContent ?? "";
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("Ramen Bae");
    expect(text).not.toContain("AGENT");
    expect(text).not.toContain("STALE");
    expect(text).not.toContain("CLI");
  });

  it("hover titles are plain and peek into the session card with Resume and Copy prompt", async () => {
    render(day());
    const lead = qa('[data-testid="brief-focus-tile"]')[0]!;
    const titles = [...lead.querySelectorAll<HTMLElement>('[data-testid="brief-focus-session"]')].map((b) => b.textContent);
    expect(titles[0]).toBe("Focus card treemap");
    expect(titles).not.toContain("hq-desktop-app #412: feat(brief): focus card treemap");
    expect(titles[3]).toBe("Untitled session");
    await hover(lead.querySelector('[data-testid="brief-focus-session"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek).not.toBeNull();
    expect(peek.querySelector(".ttl")!.textContent).toBe("Focus card treemap");
    expect(peek.querySelector('[data-testid="brief-peek-resume"]')!.textContent).toBe("Resume in Claude");
    expect(peek.querySelector('[data-testid="brief-peek-copy"]')!.textContent).toBe("Copy prompt");
    expect(peek.querySelector('[data-testid="brief-peek-origin"]')!.textContent).toContain("Indigo");
  });

  it("caps products at five then a '+N more' tile whose peek lists the rest", async () => {
    seq = 0;
    const many = [
      ...Array.from({ length: 3 }, (_, i) => session("Desktop app", 20 - i)),
      ...Array.from({ length: 2 }, (_, i) => session("HQ Cloud", 16 - i)),
      session("HQ core", 13),
      session("CLI", 12),
      session("Fleet", 11),
      session("Finance dashboard", 10),
      session("Packs", 9),
    ];
    render(many);
    const tiles = qa('[data-testid="brief-focus-tile"]');
    expect(tiles).toHaveLength(FOCUS_CAP);
    // Single-session products tie on count and sort by name; the last two fall off the face.
    expect(tiles.map((t) => t.dataset.product)).toEqual(["Desktop app", "HQ Cloud", "CLI", "Finance dashboard", "Fleet"]);
    const more = q('[data-testid="brief-focus-more"]')!;
    expect(more.textContent!.replace(/\s+/g, " ").trim()).toBe("+2 more 2 sessions");
    expect(target.textContent).not.toContain("HQ core");
    expect(target.textContent).not.toContain("Packs");
    await hover(more);
    const lines = qa('[data-testid="brief-peek-line"]').map((l) => `${l.firstElementChild!.textContent!.trim()} · ${l.lastElementChild!.textContent!.trim()}`);
    expect(lines).toEqual(["HQ core · 1 session", "Packs · 1 session"]);
  });

  it("caps one product's hover titles at five then a '+N more' row whose peek lists the rest", async () => {
    seq = 0;
    const busy = [...Array.from({ length: 7 }, (_, i) => session("Desktop app", 20 - i * 2)), session("HQ Cloud", 1, { title: "Cloud check" })];
    render(busy);
    const lead = qa('[data-testid="brief-focus-tile"]')[0]!;
    expect(lead.querySelectorAll('[data-testid="brief-focus-session"]')).toHaveLength(FOCUS_CAP);
    const more = lead.querySelector<HTMLElement>('[data-testid="brief-focus-session-more"]')!;
    expect(more.textContent).toBe("+2 more");
    expect(lead.textContent).not.toContain("Work on Desktop app 6");
    await hover(more);
    expect(q('[data-testid="brief-peek"] .ttl')!.textContent).toBe("2 more in Desktop app");
    expect(qa('[data-testid="brief-peek-line"]').map((l) => l.textContent!.trim().startsWith("Work on Desktop app"))).toEqual([true, true]);
  });

  it("renders nothing under the gate: two sessions, or three in one product", () => {
    render([session("Desktop app", 3), session("HQ Cloud", 2)]);
    expect(q('[data-testid="brief-focus"]')).toBeNull();
    unmount(app!);
    app = null;
    render([session("Desktop app", 3), session("Desktop app", 2), session("Desktop app", 1)]);
    expect(q('[data-testid="brief-focus"]')).toBeNull();
  });

  it("a tie at the top reads as a split; a single-row slot still renders the same tiles", () => {
    // Time order: Desktop (5h ago), Cloud (3h), Desktop (2h), Cloud (1h): three switches, two each.
    render([session("Desktop app", 5), session("HQ Cloud", 3), session("Desktop app", 2), session("HQ Cloud", 1)], { rows: 1 });
    expect(q('[data-testid="brief-focus-head"]')!.textContent).toBe("Split between Desktop app and HQ Cloud");
    expect(q('[data-testid="brief-focus"]')!.classList.contains("tall")).toBe(false);
    expect(qa('[data-testid="brief-focus-tile"]')).toHaveLength(2);
    expect(q('[data-testid="brief-focus-foot"]')!.textContent).toContain("3 context switches");
  });

  it("in a one-row slot keeps the tiles on one line: three products and a slim '+N more', or four when there is no fifth", () => {
    expect(tileLayout(4, true, true)).toEqual({ columns: "2fr 1fr 1fr 76px", rows: 1, spanFirst: false, spanLast: false });
    expect(tileLayout(4, true, false)).toEqual({ columns: "2fr 1fr 1fr 1fr", rows: 1, spanFirst: false, spanLast: false });
    seq = 0;
    const five = [session("Desktop app", 20), session("Desktop app", 19), session("HQ Cloud", 18), session("HQ core", 17), session("CLI", 16), session("Fleet", 15)];
    render(five, { cols: 3, rows: 1 });
    expect(qa('[data-testid="brief-focus-tile"]')).toHaveLength(FOCUS_ONE_ROW_CAP);
    expect(q('[data-testid="brief-focus-more"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("+2 more 2 sessions");
    if (app) unmount(app);
    target.remove();
    seq = 0;
    render(five.slice(0, 5), { cols: 3, rows: 1 });
    expect(qa('[data-testid="brief-focus-tile"]')).toHaveLength(FOCUS_ONE_ROW_CAP + 1);
    expect(q('[data-testid="brief-focus-more"]')).toBeNull();
  });
});
