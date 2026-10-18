// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sunrisePalette, sunriseTone } from "./brief-sunrise-tone.js";

const css = readFileSync(resolve(process.cwd(), "src/brief/brief.css"), "utf8");
const strip = readFileSync(resolve(process.cwd(), "src/brief/BriefTodayStrip.svelte"), "utf8");

describe("sunrise card and today strip follow the light theme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-force-theme");
    document.body.innerHTML = "";
  });

  it("reads light from a themed ancestor or the forced app theme, dark otherwise", () => {
    document.body.innerHTML = `<div data-theme="light"><div class="daily-brief"><div id="a"></div></div></div><div data-theme="dark"><div id="b"></div></div><div id="c"></div>`;
    expect(sunriseTone(document.getElementById("a"))).toBe("light");
    expect(sunriseTone(document.getElementById("b"))).toBe("dark");
    expect(sunriseTone(document.getElementById("c"))).toBe("dark");
    expect(sunriseTone(null)).toBe("dark");
    document.documentElement.setAttribute("data-force-theme", "light");
    expect(sunriseTone(document.getElementById("c"))).toBe("light");
  });

  it("paints the light sky warm with a cream ground and dark ink, no stars", () => {
    const light = sunrisePalette("light");
    expect(light.skyTop).toBe("rgb(255,247,231)");
    expect(light.ground).toBe("#fffaf3");
    expect(light.cell).toEqual([42, 28, 22]);
    expect(light.stars).toBe(false);
    const dark = sunrisePalette("dark");
    expect(dark.ground).toBe("#121216");
    expect(dark.cell).toEqual([255, 255, 255]);
    expect(dark.stars).toBe(true);
  });

  it("gives the today strip a light card and dark ink in the light theme", () => {
    const rule = css.slice(css.indexOf('[data-theme="light"] .daily-brief [data-testid="brief-today"]'));
    expect(rule).toMatch(/--strip-bg: #fffaf3/);
    expect(rule).toMatch(/--strip-ink: 42, 28, 22/);
    expect(strip).toMatch(/background: var\(--strip-bg, #1d1d20\)/);
    // No label in the strip keeps a hard-coded white that would vanish on the light card.
    const labelRules = strip.match(/\.(lbl|hr|hl|more|sum)[^{]*\{[^}]*\}/g) ?? [];
    expect(labelRules.length).toBeGreaterThan(4);
    for (const r of labelRules) expect(r).not.toMatch(/rgba\(255, 255, 255/);
  });

  it("stops forcing the sunrise card dark once it is marked light", () => {
    expect(css).toMatch(/\.daily-brief \.dawn:not\(\[data-tone="light"\]\)/);
  });
});
