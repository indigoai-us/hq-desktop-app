import { describe, expect, it } from "vitest";
import { decision, empty, hoursAgo, origin } from "./brief-catalogue-fixtures.js";
import {
  CATCH_UP_TILES,
  catchUpBecause,
  catchUpGreet,
  catchUpTiles,
  dayTag,
  effortMinutes,
  etaLabel,
  firstLine,
  handoffPeek,
  moreTilesPeek,
  recoveredPeek,
  shippedPeek,
} from "./brief-hero.js";
import type { BriefInput } from "./brief-types.js";

// Local midday so day boundaries never straddle the machine's timezone.
const NOW_DATE = new Date(2026, 9, 15, 13, 0);
const NOW = NOW_DATE.toISOString();
const localDaysAgo = (d: number, h = 12) => new Date(2026, 9, 15 - d, h, 0).toISOString();

describe("hero lead lines", () => {
  it("First: names priority 1 and its because as a sentence", () => {
    expect(firstLine({ text: "Cut the hq-core release.", because: "investors wait on it" })).toBe("First: Cut the hq-core release. Investors wait on it.");
    expect(firstLine({ text: "Cut the release", because: "Done by Friday!" })).toBe("First: Cut the release. Done by Friday!");
    expect(firstLine({ text: "Cut the release", because: null })).toBe("First: Cut the release.");
    expect(firstLine({ text: "  ", because: "x" })).toBe("");
    expect(firstLine(null)).toBe("");
  });

  it("the catch-up greeting quotes the lead and keeps the because as its own line", () => {
    const lead = { text: "Acknowledge the Pluto handoff.", because: "Jacob is waiting" };
    expect(catchUpGreet(lead)).toBe('Here\'s what changed, starting with "Acknowledge the Pluto handoff".');
    expect(catchUpBecause(lead)).toBe("Jacob is waiting.");
    expect(catchUpGreet(null)).toBe("Here's what changed.");
    expect(catchUpBecause(null)).toBe("");
  });
});

describe("time to clear", () => {
  it("sums effort sizes, counting unsized decisions as medium once any is sized", () => {
    expect(effortMinutes([])).toBeNull();
    expect(effortMinutes([{}, {}])).toBeNull();
    expect(effortMinutes([{ effort: "quick" }, { effort: "large" }, {}])).toBe(2 + 15 + 6);
  });

  it("~N min scales by what is left and hides when done or unknown", () => {
    expect(etaLabel(23, 3, 3)).toBe("~23 min");
    expect(etaLabel(23, 1, 3)).toBe("~8 min");
    expect(etaLabel(23, 0, 3)).toBe("");
    expect(etaLabel(null, 2, 3)).toBe("");
    expect(etaLabel(0, 2, 3)).toBe("");
    expect(etaLabel(1, 1, 5)).toBe("~1 min");
  });
});

describe("dayTag", () => {
  it("says TODAY, a weekday inside the week, a date beyond it, nothing when unknown", () => {
    expect(dayTag(localDaysAgo(0, 9), NOW)).toBe("TODAY");
    expect(dayTag(localDaysAgo(2), NOW)).toBe("TUE");
    expect(dayTag(localDaysAgo(6), NOW)).toBe("FRI");
    expect(dayTag(localDaysAgo(9), NOW)).toBe("OCT 6");
    expect(dayTag(null, NOW)).toBe("");
    expect(dayTag("nope", NOW)).toBe("");
  });
});

function awayDay(): BriefInput {
  const base = empty(NOW, "2026-10-15");
  return {
    ...base,
    lastBriefAt: hoursAgo(NOW, 4 * 24),
    decisions: [
      decision("d1", "Approve the Q4 plan", { ageHours: 30, summary: "The team plans around it" }),
      decision("d2", "indigoai-us/hq-core #1217: feat(release): pick the launch date", { ageHours: 3 }),
      decision("d3", "A third call that is not a tile"),
    ],
    risks: [
      {
        id: "p1",
        title: "HQ Cloud nightly sync is red",
        summary: "The nightly sync workflow has failed for two days.",
        severity: "incident",
        links: [],
        origin: origin("indigoai-us/hq-cloud", "HQ Cloud"),
        ci: { repo: "indigoai-us/hq-cloud", workflow: "nightly sync", job: null, since: localDaysAgo(2), ageHours: 48, note: null },
      },
      {
        id: "p2",
        title: "Five fleet agents stuck in setup",
        summary: "Disks are full.",
        severity: "incident",
        measure: { healthy: 90, total: 95, unit: "boxes", cause: "FULL DISK" },
        links: [],
        origin: origin("indigoai-us/hq-pro-agents", "Fleet"),
      },
      { id: "w1", title: "A standing risk", summary: "Not a tile.", severity: "watch", links: [], origin: origin("indigoai-us/hq-core", "HQ core") },
    ],
    recovered: [
      {
        id: "r1",
        title: "Staging main is green again",
        what: "The release gate passed",
        at: localDaysAgo(1),
        source: "main_health",
        origin: origin("indigoai-us/hq-core-staging", "HQ core"),
        timeline: [
          { at: localDaysAgo(1, 9), text: "Gate went red" },
          { at: localDaysAgo(1, 11), text: "Fix merged" },
        ],
      },
    ],
    handoffs: [
      {
        id: "h1",
        object: "Pluto, live and dark for LiveRecover Supply",
        from: "Jacob",
        to: "Corey",
        me: true,
        production: true,
        since: localDaysAgo(3),
        receipts: { access: true, ack: false, active: null },
        note: "Needs your ack before Jacob leaves.",
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
        since: localDaysAgo(2),
        receipts: { access: true, ack: true, active: true },
        origin: origin("indigoai-us/indigo-docs", "Docs"),
      },
    ],
    shipped: [
      { id: "ship:hq-pro", title: "hq-pro", status: "4 merged", note: "", origin: origin("indigoai-us/hq-pro", "HQ Pro"), lines: [], highlights: ["#912 feat(billing): annual plans"] },
      { id: "ship:desktop", title: "hq-desktop-app", status: "7 merged", note: "", origin: origin("indigoai-us/hq-desktop-app"), lines: [] },
      { id: "ship:desktop-2", title: "hq-desktop-app", status: "1 merged", note: "", origin: origin("indigoai-us/hq-desktop-app"), lines: [] },
    ],
    merged: 12,
  };
}

const PROMPTS = { d1: "Decide d1.", d2: "Decide d2.", p1: "Fix p1.", p2: "Fix p2." };

describe("catchUpTiles", () => {
  const tiles = catchUpTiles(awayDay(), { decisions: awayDay().decisions, prompts: PROMPTS });

  it("orders tiles as the catalogue counts them: incidents, the two ranked calls, fixed, handed off, then shipped", () => {
    expect(tiles.map((t) => t.id)).toEqual(["p1", "p2", "d1", "d2", "r1", "h1", "h2", "shipped"]);
    expect(tiles.map((t) => t.tag.split(" · ").pop())).toEqual(["INCIDENT", "INCIDENT", "WAITING ON YOU", "WAITING ON YOU", "FIXED", "NOW YOURS", "HANDED OFF", "SHIPPED"]);
    expect(tiles.map((t) => t.tone)).toEqual(["red", "red", "decision", "decision", "ok", "decision", "neutral", "ok"]);
    expect(CATCH_UP_TILES).toBe(5);
  });

  it("speaks in product names and plain titles: no repo slug, PR number or commit prefix on a face", () => {
    for (const t of tiles) {
      for (const s of [t.tag, t.text, t.sub]) {
        expect(s).not.toMatch(/indigoai-us\//);
        expect(s).not.toMatch(/#\d+/);
        expect(s).not.toMatch(/^(feat|fix|chore)\b/);
      }
    }
    expect(tiles[2]!.text).toBe("Approve the Q4 plan");
    expect(tiles[3]!.text).toBe("Pick the launch date");
    expect(tiles[0]!.text).toBe("HQ Cloud: nightly sync is red");
    expect(tiles[0]!.sub).toMatch(/^Red for 2 days\. The nightly sync/);
    expect(tiles[0]!.tag).toBe("TUE · INCIDENT");
    expect(tiles[1]!.sub).toBe("5 of 95 boxes affected. Disks are full.");
    expect(tiles[1]!.tag).toBe("NOW · INCIDENT");
    expect(tiles[2]!.tag).toBe("WED · WAITING ON YOU");
    expect(tiles[3]!.tag).toBe("TODAY · WAITING ON YOU");
    expect(tiles[4]!.tag).toBe("WED · FIXED");
    expect(tiles[5]!.tag).toBe("MON · NOW YOURS");
    expect(tiles[5]!.sub).toBe("From Jacob · production");
    expect(tiles[6]!.sub).toBe("Corey to Stefan");
  });

  it("folds everything shipped into one tile keyed by product, never by repo", () => {
    const ship = tiles.at(-1)!;
    expect(ship.text).toBe("12 merged");
    expect(ship.sub).toBe("HQ Pro, Desktop app");
    expect(ship.origins.map((o) => o.repo)).toEqual(["indigoai-us/hq-pro", "indigoai-us/hq-desktop-app"]);
    expect(ship.peek.title).toBe("12 merged");
    expect(ship.peek.sections[0]!.lines!.map((l) => l.label)).toEqual(["HQ Pro", "Desktop app", "Desktop app"]);
    expect(ship.peek.sections[1]!.lines![0]!.label).toBe("Annual plans");
    const quiet = catchUpTiles({ ...awayDay(), shipped: [], merged: null }, { decisions: [], prompts: {} });
    expect(quiet.map((t) => t.id)).not.toContain("shipped");
    const noShipRows = catchUpTiles({ ...awayDay(), shipped: [], merged: 3 }, { decisions: [], prompts: {} }).at(-1)!;
    expect([noShipRows.text, noShipRows.sub]).toEqual(["3 merged", ""]);
  });

  it("every tile peek is the item's own: decisions and incidents launch, handoffs show receipts, fixed shows the timeline", () => {
    expect(tiles[2]!.peek.prompt).toEqual({ id: "d1", text: "Decide d1." });
    expect(tiles[0]!.peek.prompt).toEqual({ id: "p1", text: "Fix p1." });
    expect(tiles[0]!.peek.title).toBe("nightly sync");
    const h = tiles[5]!.peek;
    expect(h.title).toBe("Pluto, live and dark for LiveRecover Supply");
    expect(h.status).toBe("From Jacob · production · since MON");
    expect(h.sections[0]!.lines!.map((l) => [l.label, l.state, l.tone])).toEqual([
      ["Access granted", "DONE", "ok"],
      ["Acknowledged", "WAITING", "warn"],
      ["Active", "UNKNOWN", "neutral"],
    ]);
    expect(h.sections[1]).toEqual({ label: "Note", text: "Needs your ack before Jacob leaves." });
    expect(h.prompt).toEqual({ id: "h1", text: "Acknowledge the Pluto handoff." });
    expect(tiles[6]!.peek.prompt).toBeUndefined();
    const r = tiles[4]!.peek;
    expect(r.status).toBe("The release gate passed");
    expect(r.sections[0]!.label).toBe("Timeline");
    expect(r.sections[0]!.lines!.map((l) => l.label)).toEqual(["Gate went red", "Fix merged"]);
    expect(r.sections[0]!.lines![0]!.state).toMatch(/^\d{1,2}(:\d{2})? (AM|PM)$/);
  });

  it("only the two decisions handed in become tiles, in the order given", () => {
    const ranked = [awayDay().decisions[2]!, awayDay().decisions[0]!, awayDay().decisions[1]!];
    const t = catchUpTiles(awayDay(), { decisions: ranked, prompts: {} }).filter((x) => x.tone === "decision" && x.tag.includes("WAITING"));
    expect(t.map((x) => x.id)).toEqual(["d3", "d1"]);
    expect(t[0]!.peek.prompt).toBeUndefined();
  });

  it("the +N more peek lists the rest with each tile's kind as its state", () => {
    const rest = tiles.slice(CATCH_UP_TILES);
    const p = moreTilesPeek(rest);
    expect(p.title).toBe("3 more changes");
    expect(p.sections[0]!.lines!.map((l) => [l.label, l.state])).toEqual([
      ["Pluto, live and dark for LiveRecover Supply", "NOW YOURS"],
      ["The docs site", "HANDED OFF"],
      ["12 merged", "SHIPPED"],
    ]);
    expect(moreTilesPeek(rest.slice(0, 1)).title).toBe("1 more change");
  });

  it("peek helpers stand alone: post-incident lines, unknown receipts, products shipped without a total", () => {
    const r = recoveredPeek({
      id: "r2",
      title: "fix: route cap outage closed",
      what: "Deploys flow again",
      at: null,
      source: "fleet",
      origin: origin("indigoai-us/hq-pro"),
      postIncident: { broke: "Route cap", did: "Removed the fleet route", changes: "Cap raised" },
    });
    expect(r.title).toBe("Route cap outage closed");
    expect(r.sections.map((s) => s.label)).toEqual(["What broke", "What we did", "What changed"]);
    const h = handoffPeek(
      { id: "h3", object: "Thing", from: "A", to: "B", me: false, production: false, since: "nope", receipts: { access: null, ack: null, active: null }, origin: origin("x") },
      NOW,
    );
    expect(h.status).toBe("A to B");
    expect(h.sections).toHaveLength(1);
    const s = shippedPeek([{ id: "s", title: "hq-cli", status: "2 merged", note: "", origin: origin("indigoai-us/hq-cli"), lines: [] }], null);
    expect(s.title).toBe("1 product shipped");
    expect(s.sections[0]!.lines![0]!.label).toBe("HQ command line");
    expect(s.sections).toHaveLength(1);
  });
});
