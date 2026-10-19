import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/brief/BriefWelcomeEdition.svelte"), "utf8");

describe("welcome edition layout (r11b frame)", () => {
  it("sizes the lead card to its content, so it does not stretch to the watch list's height", () => {
    const rule = source.slice(source.indexOf(".welcome .card.lead {"));
    expect(source.indexOf(".welcome .card.lead {")).toBeGreaterThan(-1);
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/align-self: start;/);
  });
});
