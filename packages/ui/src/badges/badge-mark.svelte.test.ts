// @vitest-environment happy-dom
/**
 * The drawn badge mark (owner pick 2026-10-15, option C "colour icon"): the
 * badge's Phosphor Duotone icon in the badge's own colours, in a solid ring
 * as thick as the icon's line in the tier's colour, the HQ gradient for a
 * Legendary ring and grey when locked. It replaces the ASCII marks at 54px
 * and 108px and the full ASCII badge on the detail page; the holographic
 * card stays ASCII.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./full-badge.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./full-badge.js")>();
  return {
    ...real,
    drawFullBadge: (...args: Parameters<typeof real.drawFullBadge>) => {
      drawn.calls.push(args[1].chars.join("\n"));
      return real.drawFullBadge(...args);
    },
  };
});

import BadgeMark from "./BadgeMark.svelte";
import BadgeCard from "./BadgeCard.svelte";
import BadgeDetailPane from "./BadgeDetailPane.svelte";
import { BADGES, BADGE_BY_ID, HQ_GRADIENT, TIER_RING, type BadgeDef, type BadgeTier } from "./badge-catalog.js";
import { BADGE_DUOTONE, DUOTONE_STROKE, MARK_ICON, MARK_RING_STROKE, badgeTune, markIconTransform } from "./badge-glyph.js";
import { BADGE_ICON_COLOR, LOCKED_MARK, MARK_TINT_OPACITY, TIER_RING_LIGHT, hqStops, markIconColors } from "./badge-mark.js";
import { inkForLight } from "./badge-theme.js";

const mounted: Array<ReturnType<typeof mount>> = [];
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-force-theme");
  drawn.calls.length = 0;
});

function render(props: { badge: BadgeDef; tier?: BadgeTier; size?: "micro" | "small"; locked?: boolean; px?: number }, theme: "dark" | "light" = "dark") {
  document.documentElement.setAttribute("data-force-theme", theme);
  const target = document.createElement("div");
  host.appendChild(target);
  mounted.push(mount(BadgeMark, { target, props }));
  flushSync();
  const svg = target.querySelector("svg")!;
  return {
    wrap: target.querySelector<HTMLElement>('[role="img"]')!,
    svg,
    ring: svg.querySelector("circle")!,
    group: svg.querySelector("g")!,
    tint: svg.querySelector("path.tint")!,
    line: svg.querySelector("path.line")!,
  };
}

describe("the drawn mark", () => {
  it("is an <svg>, not a canvas, at 54px (micro) and 108px (small), on a 54-unit box", () => {
    for (const [size, px] of [["micro", "54"], ["small", "108"]] as const) {
      const { wrap, svg } = render({ badge: BADGE_BY_ID.liftoff, size });
      expect(svg.getAttribute("width")).toBe(px);
      expect(svg.getAttribute("height")).toBe(px);
      expect(svg.getAttribute("viewBox")).toBe("0 0 54 54");
      expect(svg.getAttribute("data-badge")).toBe("liftoff");
      expect(wrap.getAttribute("aria-label")).toBe("Liftoff");
      expect(wrap.querySelector("canvas")).toBeNull();
    }
  });

  it("takes any size with px", () => {
    expect(render({ badge: BADGE_BY_ID.liftoff, px: 270 }).svg.getAttribute("width")).toBe("270");
  });

  it("draws a solid ring at r 20.5, as thick as the icon's line", () => {
    const { ring } = render({ badge: BADGE_BY_ID.liftoff, size: "small" });
    expect([ring.getAttribute("cx"), ring.getAttribute("cy"), ring.getAttribute("r")]).toEqual(["27", "27", "20.5"]);
    expect(ring.getAttribute("fill")).toBe("none");
    expect(ring.hasAttribute("stroke-dasharray")).toBe(false);
    // Phosphor Duotone's 16/256 line, at the icon's 26-unit size.
    expect(MARK_RING_STROKE).toBe((16 / 256) * 26);
    expect(MARK_RING_STROKE).toBe(DUOTONE_STROKE * MARK_ICON);
    expect(Number(ring.getAttribute("stroke-width"))).toBe(1.625);
  });

  it("draws the Duotone icon: the tint at 0.4 on dark and 0.3 on light, the line at full colour", () => {
    const dark = render({ badge: BADGE_BY_ID.og });
    expect(dark.tint.getAttribute("d")).toBe(BADGE_DUOTONE.crown.tint);
    expect(dark.line.getAttribute("d")).toBe(BADGE_DUOTONE.crown.line);
    expect(MARK_TINT_OPACITY).toEqual({ dark: 0.4, light: 0.3 });
    expect(dark.tint.getAttribute("opacity")).toBe("0.4");
    expect(dark.line.hasAttribute("opacity")).toBe(false);
    const light = render({ badge: BADGE_BY_ID.og }, "light");
    expect(light.tint.getAttribute("opacity")).toBe("0.3");
    expect(light.line.hasAttribute("opacity")).toBe(false);
  });

  it("places the icon in a 26-unit box at the centre, with its optical tuning", () => {
    // Crown sits 11 units lower on the 256 grid; Robot is drawn at 93%.
    expect(badgeTune("crown")).toEqual([1, 0, 11]);
    expect(render({ badge: BADGE_BY_ID.og }).group.getAttribute("transform")).toBe(`translate(27 27) scale(${26 / 256}) translate(-128 -117)`);
    const robot = render({ badge: BADGE_BY_ID.fleet }).group.getAttribute("transform")!;
    expect(robot).toBe(markIconTransform("robot"));
    expect(Number(/scale\(([^)]+)\)/.exec(robot)![1])).toBeCloseTo((26 / 256) * 0.93, 10);
    expect(robot).toContain("translate(-128 -128)");
    // An icon without tuning is just centred.
    expect(badgeTune("bug")).toEqual([1, 0, 0]);
    expect(render({ badge: BADGE_BY_ID.bughunter }).group.getAttribute("transform")).toBe(`translate(27 27) scale(${26 / 256}) translate(-128 -128)`);
  });

  // Owner pick 2026-10-15, option C: the icon is in the badge's own colours
  // (as in the ASCII Color art), only the ring is in the tier's.
  it("rings the icon in the tier's metal, deeper on light, and draws the icon in the badge's own colours", () => {
    for (const tier of [1, 2, 3] as const) {
      for (const [theme, metal] of [["dark", TIER_RING[tier]], ["light", TIER_RING_LIGHT[tier]]] as const) {
        const { ring, tint, line, svg } = render({ badge: BADGE_BY_ID.liftoff, tier }, theme);
        expect(ring.getAttribute("stroke"), `${tier} ${theme}`).toBe(metal);
        expect(tint.getAttribute("fill"), `${tier} ${theme}`).not.toBe(metal);
        expect(line.getAttribute("fill"), `${tier} ${theme}`).not.toBe(metal);
        expect(svg.querySelector("linearGradient")).toBeNull();
      }
    }
    expect(TIER_RING_LIGHT).toEqual({ 1: "#8a4522", 2: "#4f566b", 3: "#8f6400" });
  });

  it("draws the icon's line and tint in the badge's colours on dark, and through inkForLight on light", () => {
    // Liftoff is the rocket: a near-white line over a sky-blue tint.
    expect(BADGE_ICON_COLOR.rocket).toEqual({ line: "#ebe7f6", tint: "#8fd6ff" });
    const dark = render({ badge: BADGE_BY_ID.liftoff, tier: 2 });
    expect(dark.line.getAttribute("fill")).toBe("#ebe7f6");
    expect(dark.tint.getAttribute("fill")).toBe("#8fd6ff");
    expect(dark.ring.getAttribute("stroke")).toBe(TIER_RING[2]);
    const light = render({ badge: BADGE_BY_ID.liftoff, tier: 2 }, "light");
    expect(light.line.getAttribute("fill")).toBe(inkForLight("#ebe7f6"));
    expect(light.tint.getAttribute("fill")).toBe(inkForLight("#8fd6ff"));
    expect(light.ring.getAttribute("stroke")).toBe(TIER_RING_LIGHT[2]);
    // inkForLight keeps the hue and caps lightness at 40%, so the light line is no longer near-white.
    expect(inkForLight("#ebe7f6")).not.toBe("#ebe7f6");
    for (const def of BADGES) {
      for (const theme of ["dark", "light"] as const) {
        const { line, tint } = render({ badge: def }, theme);
        const want = markIconColors(def.icon, theme);
        expect([line.getAttribute("fill"), tint.getAttribute("fill")], `${def.id} ${theme}`).toEqual([want.line, want.tint]);
      }
    }
  });

  it("has a colour pair for every badge icon, with the ten retuned from the full-size art", () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const def of BADGES) {
      const pair = BADGE_ICON_COLOR[def.icon];
      expect(pair, def.id).toBeDefined();
      expect(pair.line, def.id).toMatch(hex);
      expect(pair.tint, def.id).toMatch(hex);
    }
    // Retuned from the full-size ASCII Color art (owner review 2026-10-15).
    expect(BADGE_ICON_COLOR.people).toEqual({ line: "#5fd3c0", tint: "#5fd3c0" });
    expect(BADGE_ICON_COLOR.crown).toEqual({ line: "#f0a830", tint: "#ffd23f" });
    // Connector's plug: the blue plug body, not the old grey tint.
    expect(BADGE_ICON_COLOR.plug).toEqual({ line: "#7cc8ff", tint: "#7cc8ff" });
  });

  it("is grey when locked, ring, line and tint, Legendary too, the tint at the same opacity", () => {
    expect(LOCKED_MARK).toEqual({ dark: "#6f6878", light: "#958e9f" });
    for (const theme of ["dark", "light"] as const) {
      for (const badge of [BADGE_BY_ID.liftoff, BADGE_BY_ID.og]) {
        const { ring, tint, line, svg } = render({ badge, locked: true }, theme);
        expect([ring.getAttribute("stroke"), tint.getAttribute("fill"), line.getAttribute("fill")]).toEqual(Array(3).fill(LOCKED_MARK[theme]));
        expect(tint.getAttribute("opacity")).toBe(String(MARK_TINT_OPACITY[theme]));
        expect(svg.querySelector("linearGradient")).toBeNull();
      }
    }
  });

  it("fills a Legendary ring with the HQ gradient, tuned per theme, with ids of its own, and keeps the icon's own colours", () => {
    const a = render({ badge: BADGE_BY_ID.og });
    const b = render({ badge: BADGE_BY_ID.captain });
    const ids = [a, b].flatMap(({ svg }) => [...svg.querySelectorAll("linearGradient")].map((g) => g.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    const [ringGrad] = [...a.svg.querySelectorAll("linearGradient")];
    expect(a.ring.getAttribute("stroke")).toBe(`url(#${ringGrad.id})`);
    // OG is the crown: its own amber line over a yellow tint, not the gradient.
    expect(a.line.getAttribute("fill")).toBe(BADGE_ICON_COLOR.crown.line);
    expect(a.tint.getAttribute("fill")).toBe(BADGE_ICON_COLOR.crown.tint);
    // The ring's sweep runs across the ring.
    const coords = (g: Element) => ["gradientUnits", "x1", "y1", "x2", "y2"].map((k) => g.getAttribute(k));
    expect(coords(ringGrad)).toEqual(["userSpaceOnUse", "6.5", "6.5", "47.5", "47.5"]);

    const stops = (g: Element) => [...g.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"));
    // Warmed toward #fff4dc by 0.15 on dark: indigo #3b22d0 becomes #5842d2.
    expect(stops(ringGrad)).toEqual(hqStops("dark"));
    expect(hqStops("dark")[0]).toBe("#5842d2");
    expect(hqStops("dark")).toHaveLength(HQ_GRADIENT.length);
    // Darkened toward #1c1036 by 0.1 on light.
    const light = render({ badge: BADGE_BY_ID.og }, "light");
    expect(stops(light.svg.querySelector("linearGradient")!)).toEqual(hqStops("light"));
    expect(light.line.getAttribute("fill")).toBe(inkForLight(BADGE_ICON_COLOR.crown.line));
    expect(light.tint.getAttribute("fill")).toBe(inkForLight(BADGE_ICON_COLOR.crown.tint));
    expect(hqStops("light")[0]).toBe("#3820c1");
  });

  it("follows the theme as it changes", async () => {
    const { ring } = render({ badge: BADGE_BY_ID.liftoff, tier: 1 });
    expect(ring.getAttribute("stroke")).toBe(TIER_RING[1]);
    document.documentElement.setAttribute("data-force-theme", "light");
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(host.querySelector("circle")?.getAttribute("stroke")).toBe(TIER_RING_LIGHT[1]);
  });

  it("has an icon for every badge", () => {
    for (const def of BADGES) {
      const { tint, line } = render({ badge: def });
      expect(tint.getAttribute("d"), def.id).toBe(BADGE_DUOTONE[def.icon].tint);
      expect(line.getAttribute("d"), def.id).toBe(BADGE_DUOTONE[def.icon].line);
    }
  });
});

describe("the detail page and the card", () => {
  it("shows the drawn mark at 270px on the detail page, not a canvas", async () => {
    mounted.push(mount(BadgeDetailPane, { target: host, props: { badge: { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" } } }));
    flushSync();
    await tick();
    const hero = host.querySelector(".hero")!;
    const mark = hero.querySelector('[role="img"]')!;
    expect(mark.getAttribute("aria-label")).toBe("Liftoff, Silver");
    expect(mark.querySelector('svg[data-badge="liftoff"]')?.getAttribute("width")).toBe("270");
    expect(hero.querySelector("canvas")).toBeNull();
  });

  it("still draws the holographic card's front in ASCII from the full art", async () => {
    mounted.push(mount(BadgeCard, { target: host, props: { badge: { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" }, foil: false, interactive: false } }));
    for (let i = 0; i < 20 && !drawn.calls.length; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      flushSync();
    }
    expect(host.querySelector('canvas[data-card-art="liftoff"]')).not.toBeNull();
    expect(host.querySelector("svg[data-badge]")).toBeNull();
    const { FULL_ASCII } = await import("./full-ascii-data.js");
    expect(drawn.calls).toContain(FULL_ASCII["liftoff:2"].chars.join("\n"));
  });
});
