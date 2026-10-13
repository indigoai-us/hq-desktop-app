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

/** Four days away with an incident, three calls, a fix, a handoff and two products shipped: six tiles. */
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
    ],
    shipped: [
      { id: "ship:hq-pro", title: "hq-pro", status: "4 merged", note: "", origin: origin("indigoai-us/hq-pro", "HQ Pro"), lines: [] },
      { id: "ship:desktop", title: "hq-desktop-app", status: "7 merged", note: "", origin: origin("indigoai-us/hq-desktop-app"), lines: [] },
    ],
    merged: 11,
  };
}

describe("Welcome back", () => {
  it("leads the catch-up page, greets with priority 1 and its because, and shows five tiles then +1 more", () => {
    render(awayDay());
    const card = q("brief-catchup")!;
    expect(card.closest("[data-widget]")!.getAttribute("data-widget")).toBe("catchup");
    expect(card.textContent).toContain("Welcome back · 4 days at a glance");
    expect(q("brief-catchup-greet")!.textContent).toBe('Here\'s what changed, starting with "Approve the Q4 plan".');
    expect(q("brief-catchup-first")!.textContent).toBe("The team plans around it.");
    const tiles = qa("brief-catchup-tile");
    expect(tiles).toHaveLength(5);
    expect(tiles.map((t) => t.getAttribute("data-tone"))).toEqual(["red", "decision", "decision", "ok", "decision"]);
    expect(tiles.map((t) => t.querySelector(".tag")!.textContent!.split(" · ").pop())).toEqual(["INCIDENT", "WAITING ON YOU", "WAITING ON YOU", "FIXED", "NOW YOURS"]);
    // The two calls are the ones the catalogue ranked first; the third stays off the face.
    expect(tiles[1]!.textContent).toContain("Approve the Q4 plan");
    expect(tiles[2]!.textContent).toContain("Pick the launch date");
    expect(card.textContent).not.toContain("A third call");
    expect(q("brief-catchup-more")!.textContent!.trim()).toBe("+1 more");
    expect(card.textContent).toContain("Everything else can wait for a normal brief tomorrow.");
  });

  it("tiles carry company logos and product names, never a repo slug", () => {
    render(awayDay());
    const card = q("brief-catchup")!;
    expect(card.textContent).not.toContain("indigoai-us");
    const labels = [...card.querySelectorAll('[data-testid="brief-origin-label"]')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["HQ Cloud", "Desktop app", "HQ core", "HQ Pro"]));
    expect(card.querySelectorAll('[data-testid="brief-logo"]').length).toBeGreaterThanOrEqual(5);
  });

  it("a call's tile peeks to the decision with its prompt and starts it in the chosen engine", async () => {
    const onlaunch = vi.fn(async () => null);
    render(awayDay(), { onlaunch });
    await hover(qa("brief-catchup-tile")[1]!);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Approve the Q4 plan");
    expect(q("brief-peek-prompt")).not.toBeNull();
    const start = peek.querySelector<HTMLButtonElement>('[data-testid="brief-start"]')!;
    expect(start.textContent).toContain("Start in Claude");
    start.click();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("claude", expect.stringContaining("Approve the Q4 plan"));
  });

  it("the handoff tile peeks to its receipts and the +N more tile lists what did not fit", async () => {
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
    expect(peek.textContent).toContain("11 merged");
    expect(peek.textContent).toContain("SHIPPED");
  });

  it("stays honest on a catch-up day with nothing behind it", () => {
    render({ ...catchUpThursday(), decisions: [], priorities: [], shipped: [], merged: null });
    expect(q("brief-catchup-greet")!.textContent).toBe("Here's what changed.");
    expect(q("brief-catchup-first")).toBeNull();
    expect(qa("brief-catchup-tile")).toHaveLength(0);
    expect(q("brief-catchup-quiet")).not.toBeNull();
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
