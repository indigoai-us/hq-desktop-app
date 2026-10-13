// The priorities card takes the hero's slot; the sunrise takes the priorities card's slot.
import { describe, expect, it } from "vitest";
import { inLabel, nextCall, peekTop, placePeek, promoteMain, withLine } from "./brief-layout.js";
import type { BriefWidget } from "./brief-generate.js";

const w = (kind: string, cols: number, rows: number, size = "M"): BriefWidget =>
  ({ kind, slot: kind, size, cols, rows, tier: 1, score: 1, reason: `${kind} reason`, serves: [] }) as unknown as BriefWidget;

describe("promoteMain", () => {
  const areas = ["sunrise sunrise sunrise needs needs incident", "sunrise sunrise sunrise needs needs waiting", "team team shipped shipped focus focus"];
  const widgets = [w("sunrise", 3, 2, "L"), w("needs", 2, 2, "M"), w("incident", 1, 1, "S"), w("waiting", 1, 1, "S"), w("team", 2, 1, "W")];

  it("gives the priorities card the hero's size and puts the sunrise first, to its left", () => {
    const out = promoteMain(areas, widgets);
    expect(out.areas).toEqual([
      "sunrise sunrise needs needs needs incident",
      "sunrise sunrise needs needs needs waiting",
      "team team shipped shipped focus focus",
    ]);
    expect(out.widgets.map((x) => [x.kind, x.size, x.cols, x.rows])).toEqual([
      ["sunrise", "M", 2, 2],
      ["needs", "L", 3, 2],
      ["incident", "S", 1, 1],
      ["waiting", "S", 1, 1],
      ["team", "W", 2, 1],
    ]);
    // Reasons travel with their cards.
    expect(out.widgets[1]!.reason).toBe("needs reason");
  });

  it("keeps the swap but not the reorder when the two cards do not share their rows", () => {
    const tall = ["sunrise sunrise sunrise needs needs c", "sunrise sunrise sunrise needs needs d", "sunrise sunrise sunrise e e e"];
    const ws = [w("sunrise", 3, 3, "XL"), w("needs", 2, 2), w("c", 1, 1), w("d", 1, 1), w("e", 3, 1)];
    const out = promoteMain(tall, ws);
    expect(out.areas).toEqual(["needs needs needs sunrise sunrise c", "needs needs needs sunrise sunrise d", "needs needs needs e e e"]);
    expect(out.widgets[0]!.kind).toBe("needs");
  });

  it("leaves the inputs untouched", () => {
    const before = JSON.stringify([areas, widgets]);
    promoteMain(areas, widgets);
    expect(JSON.stringify([areas, widgets])).toBe(before);
  });

  it("keeps the plan when there is no priorities card, when it is already as big, or when the hero is a catch-up", () => {
    const quiet = [w("sunrise", 6, 2, "XL")];
    expect(promoteMain(["sunrise sunrise sunrise sunrise sunrise sunrise"], quiet).widgets).toEqual(quiet);
    const even = [w("sunrise", 2, 2), w("needs", 2, 2)];
    expect(promoteMain(["sunrise sunrise needs needs"], even).areas).toEqual(["sunrise sunrise needs needs"]);
    const away = [w("catchup", 3, 2, "L"), w("needs", 2, 2)];
    expect(promoteMain(["catchup catchup catchup needs needs"], away).widgets.map((x) => x.kind)).toEqual(["catchup", "needs"]);
  });
});

describe("nextCall", () => {
  const ev = (id: string, start: string, end: string | null = null, busy = false) => ({ id, start, end, busy });
  const NOW = "2026-10-08T09:00:00";
  it("picks the call in progress, else the next one, and skips busy holds and past calls", () => {
    const events = [ev("past", "2026-10-08T07:00:00", "2026-10-08T08:00:00"), ev("hold", "2026-10-08T09:30:00", null, true), ev("b", "2026-10-08T10:30:00"), ev("a", "2026-10-08T09:45:00")];
    expect(nextCall(events, NOW)).toMatchObject({ event: { id: "a" }, inMin: 45, live: false });
    const live = [ev("now", "2026-10-08T08:45:00", "2026-10-08T09:15:00")];
    expect(nextCall(live, NOW)).toMatchObject({ event: { id: "now" }, inMin: 0, live: true });
    expect(nextCall([ev("done", "2026-10-08T08:00:00")], NOW)).toBeNull();
  });
  it("says when in plain words", () => {
    expect(inLabel(0, true)).toBe("now");
    expect(inLabel(45, false)).toBe("in 45 min");
    expect(inLabel(120, false)).toBe("in 2h");
    expect(inLabel(130, false)).toBe("in 2h 10m");
  });
});

describe("placePeek / peekTop", () => {
  const view = { w: 1440, h: 900 };
  const box = (left: number, right: number, top = 100, bottom = 130) => ({ left, right, top, bottom });
  it("opens right beside the hovered content, level with it", () => {
    expect(placePeek(box(691, 760, 480, 500), view)).toEqual({ x: 770, anchorTop: 480, side: "r" });
    expect(placePeek(box(40, 114, 156, 200), view)).toEqual({ x: 124, anchorTop: 156, side: "r" });
  });
  it("goes left when the right side has no room, and stays inside the window when neither fits", () => {
    expect(placePeek(box(1182, 1266), view)).toMatchObject({ x: 1182 - 10 - 340, side: "l" });
    const wide = placePeek(box(100, 1300), view);
    expect(wide.x).toBeGreaterThanOrEqual(8);
    expect(wide.x).toBeLessThanOrEqual(1440 - 340 - 8);
  });
  it("sits level with the hovered thing and only moves up to stay on screen", () => {
    expect(peekTop(300, 200, 900)).toBe(294);
    expect(peekTop(800, 300, 900)).toBe(584);
    expect(peekTop(4, 100, 900)).toBe(16);
  });
});

describe("participants on the Next call panel", () => {
  it("names them in a few words", () => {
    expect(withLine([])).toBe("");
    expect(withLine(["Lizzie"])).toBe("with Lizzie");
    expect(withLine(["Jacob", "Corey"])).toBe("with Jacob and Corey");
    expect(withLine(["Jacob", "Corey", "Izzy", "Hassaan"])).toBe("with Jacob, Corey +2");
  });
});
