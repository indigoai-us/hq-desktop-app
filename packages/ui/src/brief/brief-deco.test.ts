// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DECO, decoSvg, decoUrl } from "./brief-deco.js";
import { FIELD } from "./brief-layout.js";

describe("card corner motifs", () => {
  it("every card on a colour field has its own motif, none repeated", () => {
    // Sunrise and catch-up sit on the dusk field, which has no corner motif.
    const kinds = Object.entries(FIELD).filter(([, f]) => f !== "dusk").map(([k]) => k);
    for (const k of kinds) expect(DECO[k], k).toBeTruthy();
    const bodies = kinds.map((k) => DECO[k]);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("each motif is one glass shape family plus a dotted line, in the shared style", () => {
    for (const [k, body] of Object.entries(DECO)) {
      expect(body, k).toContain("fill='url(#o)'");
      expect(body, k).toContain("stroke-dasharray='0 5'");
    }
  });

  it("falls back to the orb and encodes as a CSS url", () => {
    expect(decoSvg("nope")).toContain("<circle cx='176' cy='212' r='90'");
    const url = decoUrl("needs");
    expect(url.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url.slice(24, -2))).toBe(decoSvg("needs"));
  });
});
