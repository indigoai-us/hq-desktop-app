// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DECO, DECO_OPACITY, decoSvg, decoUrl, hasDeco } from "./brief-deco.js";
import { FIELD } from "./brief-layout.js";

describe("card corner motifs", () => {
  it("every card on a colour field has its own motif, none repeated", () => {
    // Sunrise and catch-up sit on the dusk field, which has no corner motif.
    const kinds = Object.entries(FIELD).filter(([, f]) => f !== "dusk").map(([k]) => k);
    for (const k of kinds) expect(DECO[k], k).toBeTypeOf("string");
    // Cards whose corner holds their action buttons opt out with an empty motif.
    expect(kinds.filter((k) => !hasDeco(k)).sort()).toEqual(["oneThing", "releaseTrain"]);
    expect(decoUrl("releaseTrain")).toBe("none");
    const bodies = kinds.filter(hasDeco).map((k) => DECO[k]);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("each motif is a glass shape plus a dotted line, in the shared style; priorities is only a fading grid", () => {
    for (const [k, body] of Object.entries(DECO)) {
      if (k === "needs" || !body) continue;
      expect(body, k).toContain("fill='url(#o)'");
      expect(body, k).toContain("stroke-dasharray='0 5'");
    }
    expect(DECO.needs).toContain("mask='url(#fade)'");
    expect(DECO.needs).not.toContain("url(#o)");
  });

  it("every motif is drawn muted, at one shared opacity", () => {
    expect(DECO_OPACITY).toBeLessThanOrEqual(0.5);
    for (const k of Object.keys(DECO)) if (hasDeco(k)) expect(decoSvg(k), k).toContain(`<g opacity='${DECO_OPACITY}'>`);
  });

  it("falls back to the orb and encodes as a CSS url", () => {
    expect(decoSvg("nope")).toContain("<circle cx='176' cy='212' r='90'");
    const url = decoUrl("needs");
    expect(url.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url.slice(24, -2))).toBe(decoSvg("needs"));
  });
});
