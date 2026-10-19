import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), "src/brief", file), "utf8");
const report = read("WelcomeReport.svelte");
const connect = read("BriefConnectApps.svelte");
const rise = read("BriefRise.svelte");

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("}", start));
}

describe("sunrise layout (US-019 round 4 frame review)", () => {
  it("lets the sunrise stage run behind the open bar, so no plain strip shows under the sky", () => {
    const hold = rule(report, ".welcome.rising .rise-hold");
    expect(hold).toMatch(/position: absolute;/);
    expect(hold).toMatch(/inset: 0;/);
    // The bar keeps its place under the 780 px stage and paints above the sky.
    const bar = rule(report, ".welcome.rising .after-rise");
    expect(bar).toMatch(/margin-top: 780px;/);
    expect(bar).toMatch(/z-index: 4;/);
  });

  it("gives the light connect strip the sunrise's warm card ground, not a flat grey box", () => {
    const card = rule(rise, '.stage[data-theme="light"] .failed');
    const warm = card.match(/background: (#[0-9a-f]+);/)?.[1];
    const edge = card.match(/border-color: (rgba\([^)]+\));/)?.[1];
    expect(warm).toBe("#fffaf0");
    const strip = rule(connect, '.connect.quiet[data-theme="light"]');
    expect(strip).toContain(warm!);
    expect(strip).toContain(edge!);
    expect(strip).not.toMatch(/#f3f1ef/);
  });
});
