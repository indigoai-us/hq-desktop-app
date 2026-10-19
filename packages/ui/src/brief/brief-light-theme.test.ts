import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/brief/brief.css"), "utf8");
const strip = readFileSync(resolve(process.cwd(), "src/brief/BriefTodayStrip.svelte"), "utf8");

describe("today strip and action cards follow the light theme", () => {
  it("keeps every strip label on the brief's ink, so none vanishes on the light card", () => {
    const labelRules = strip.match(/\.(lbl|hr|hl|more|sum)[^{]*\{[^}]*\}/g) ?? [];
    expect(labelRules.length).toBeGreaterThan(4);
    for (const r of labelRules) expect(r).not.toMatch(/rgba\(255, 255, 255/);
  });

  it("gives the strip's more pill a light ground in both light forms", () => {
    expect(strip).toMatch(/background: var\(--strip-more, #2a2a2f\)/);
    for (const sel of [
      ':root:not([data-force-theme="dark"]) .daily-brief [data-testid="brief-today"]',
      ':root[data-force-theme="light"] .daily-brief [data-testid="brief-today"]',
    ]) {
      const rule = css.slice(css.indexOf(sel));
      expect(css.indexOf(sel)).toBeGreaterThan(-1);
      expect(rule.slice(0, rule.indexOf("}"))).toMatch(/--strip-more: #efe6da/);
    }
  });

  it("draws action card text in dark ink in both light forms", () => {
    for (const sel of [
      ':root:not([data-force-theme="dark"]) .daily-brief .action-card .why',
      ':root[data-force-theme="light"] .daily-brief .action-card .why',
    ]) {
      expect(css.indexOf(sel)).toBeGreaterThan(-1);
      const rule = css.slice(css.indexOf(sel));
      expect(rule.slice(0, rule.indexOf("}"))).toMatch(/color: rgba\(42, 28, 22, 0\.82\)/);
    }
  });
});
