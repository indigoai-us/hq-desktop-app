// @vitest-environment happy-dom
/**
 * The holographic light on the card's back (designer report 2026-10-16: "the
 * holographic effect on the back of the badge card doesn't render well").
 * It was CSS: a 300% rainbow under `mix-blend-mode: screen` and a radial
 * `mask-image`, so only a third of the rainbow ever showed (a flat teal-olive
 * haze), with plain circles for rings, spread across the story. Now it is the
 * face's foil model (etched contours in the pearl rainbow) drawn into a
 * canvas as plain alpha, kept soft under the words.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeCardModal from "./BadgeCardModal.svelte";
import { BADGE_BY_ID, type ResolvedBadge } from "./badge-catalog.js";
import { cardHover } from "./card-hover.js";
import { FOIL_WGSL } from "./foil-gpu.js";
import { BACK_LINES, BACK_WASH, MAP_H, MAP_W, clearContourCache, createBackHolo, etchedCoverage, etchedPhase, lightMaps, pearlColor, type BackLight, type QuietBox } from "./back-holo.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
const liftoff: ResolvedBadge = { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" };
const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
  clearContourCache();
});

/** The light full on, where the old haze sat (60%, 37%), with a little tilt. */
const ON: BackLight = { x: 0.2, y: -0.26, hover: 1, tiltX: 0.05, tiltY: -0.04 };

// sRGB relative luminance and WCAG contrast.
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const over = (top: number[], alpha: number, under: number[]) => under.map((u, i) => top[i] * alpha + u * (1 - alpha));

function hue([r, g, b]: number[]): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 1e-6) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("the back's light is drawn, not blended", () => {
  const src = read("BadgeCardBack.svelte");
  const css = src.slice(src.indexOf("<style>"));

  it("has no blend mode, no mask and no CSS rings on its light", () => {
    // The old light: `mix-blend-mode: screen` over a repeating-radial-gradient, masked to the pointer.
    expect(css).not.toMatch(/mix-blend-mode/);
    expect(css).not.toMatch(/repeating-radial-gradient/);
    const holoRules = css.match(/\.holo[^{]*\{[^}]*\}/g) ?? [];
    expect(holoRules.length).toBeGreaterThan(0);
    for (const rule of holoRules) expect(rule).not.toMatch(/mask|gradient|blend/);
  });

  it("draws into a canvas with the face's foil model, fed by the hover", () => {
    expect(src).toMatch(/<canvas class="holo" bind:this=\{holoEl\} aria-hidden="true"><\/canvas>/);
    expect(src).toContain("use:cardHover={{ enabled: interactive, onlight: (l) => holo?.draw(l) }}");
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, onclose: () => {} } }));
    flushSync();
    const back = document.querySelector('[data-testid="badge-card-back"]') as HTMLElement;
    const holo = back.querySelector(".holo");
    expect(holo?.tagName).toBe("CANVAS");
    expect(holo?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses the shader's own pearl rainbow and etched contours", () => {
    expect(FOIL_WGSL).toContain("return vec3f(0.55, 0.52, 0.64) + vec3f(0.43, 0.40, 0.34) * cos(6.2831853 * (phase + vec3f(0.05, 0.38, 0.63)));");
    expect(FOIL_WGSL).toContain("let warp = vec2f(sin(p.y * 7.0 + sin(p.x * 4.0)) * 0.085, sin(p.x * 6.0 - p.y * 3.0) * 0.07);");
    expect(FOIL_WGSL).toContain("let radius = length(q * vec2f(1.0, 0.76));");
    expect(FOIL_WGSL).toContain("return radius * 142.0 + sin(atan2(q.y, q.x) * 3.0 + radius * 8.0) * 1.7;");
    const [r, g, b] = pearlColor(0);
    expect(r).toBeCloseTo(0.55 + 0.43 * Math.cos(6.2831853 * 0.05), 6);
    expect(g).toBeCloseTo(0.52 + 0.4 * Math.cos(6.2831853 * 0.38), 6);
    expect(b).toBeCloseTo(0.64 + 0.34 * Math.cos(6.2831853 * 0.63), 6);
    // The same contour field: rings about every 2*PI/142 card units out from (0.13, 0.08).
    const step = (2 * Math.PI) / 142;
    expect(etchedPhase(0.4, 0.3) - etchedPhase(0.4 - step * 0.8, 0.3 - step * 0.6)).toBeGreaterThan(3);
  });
});

describe("the look", () => {
  it("is a pearl rainbow under the light, not one hue", () => {
    const { lines } = lightMaps(ON);
    let peak = 0;
    for (let k = 3; k < lines.length; k += 4) peak = Math.max(peak, lines[k]);
    const hues: number[] = [];
    for (let k = 0; k < lines.length; k += 4) {
      if (lines[k + 3] < peak * 0.35) continue;
      const rgb = [lines[k], lines[k + 1], lines[k + 2]].map((v) => v / 255);
      if (Math.max(...rgb) - Math.min(...rgb) > 0.12) hues.push(hue(rgb));
    }
    expect(hues.length).toBeGreaterThan(40);
    // Pinks, violets, blues and greens all show around the light (the old haze stayed within teal-olive).
    const bins = new Set(hues.map((h) => Math.floor(h / 60)));
    expect(bins.size).toBeGreaterThanOrEqual(4);
  });

  it("follows the pointer and is dark away from it", () => {
    const near = lightMaps({ ...ON, x: 0.6, y: -0.6 }).wash;
    const at = (i: number, j: number) => near[(j * MAP_W + i) * 4 + 3];
    const ix = (x: number) => Math.round(((x + 1) / 2) * MAP_W - 0.5);
    const iy = (y: number) => Math.round(((y + 1) / 2) * MAP_H - 0.5);
    expect(at(ix(0.6), iy(-0.6))).toBeGreaterThan(at(ix(-0.7), iy(0.8)) * 5);
    // No light, nothing at all.
    const off = lightMaps({ ...ON, hover: 0 });
    expect(off.lines.every((v) => v === 0) && off.wash.every((v) => v === 0)).toBe(true);
  });

  it("keeps the story readable at full light: its small print stays above 4.5:1", () => {
    // The card's own ground; the canvas is the back's only light.
    const lit = [0x17, 0x16, 0x1a].map((v) => v / 255);
    const why = (bg: number[]) => over([244 / 255, 239 / 255, 232 / 255], 0.55, bg);
    const words: QuietBox = { x0: -0.53, y0: -0.36, x1: 0.53, y1: 0.36 };
    let worst = Infinity;
    let worstLine = Infinity;
    for (const x of [-0.6, -0.2, 0.2, 0.6]) {
      for (const y of [-0.5, -0.2, 0, 0.2, 0.5]) {
        const { lines, wash } = lightMaps({ ...ON, x, y }, words);
        for (let k = 0; k < wash.length; k += 4) {
          const px = (((k / 4) % MAP_W) + 0.5) / MAP_W * 1.28 - 0.64;
          const py = (Math.floor(k / 4 / MAP_W) + 0.5) / MAP_H * 1.792 - 0.896;
          if (px < words.x0 || px > words.x1 || py < words.y0 || py > words.y1) continue;
          const bg = over([wash[k] / 255, wash[k + 1] / 255, wash[k + 2] / 255], wash[k + 3] / 255, lit);
          const onLine = over([lines[k] / 255, lines[k + 1] / 255, lines[k + 2] / 255], lines[k + 3] / 255, bg);
          worst = Math.min(worst, contrast(why(bg), bg));
          worstLine = Math.min(worstLine, contrast(why(onLine), onLine));
        }
      }
    }
    // At rest it is about 5.5:1; the old haze took it as low as 2:1 under the light.
    expect(contrast(why(lit), lit)).toBeGreaterThan(5.4);
    expect(worst).toBeGreaterThanOrEqual(4.5);
    // Right on a contour, a pixel-thin line, it still clears 3:1.
    expect(worstLine).toBeGreaterThanOrEqual(3);
    // The face's strength is the ceiling: the back is softer.
    expect(BACK_WASH).toBeLessThan(1);
    expect(BACK_LINES).toBeLessThan(1);
  });

  it("antialiases the etched contours instead of drawing hard one-pixel rings", () => {
    for (const [w, h] of [[300, 420], [600, 840]]) {
      const cov = etchedCoverage(w, h);
      let partial = 0;
      let full = 0;
      for (const v of cov) {
        if (v > 0 && v < 255) partial++;
        else if (v === 255) full++;
      }
      // Every contour has soft edges, and the lines stay thin.
      expect(partial).toBeGreaterThan(full * 4);
      expect(cov.reduce((sum, v) => sum + v, 0) / 255 / cov.length).toBeLessThan(0.35);
    }
  });
});

/** A 2D context that records what is drawn. */
function fakeCanvas(w = 280, h = 392) {
  const ops: string[] = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    save() {},
    restore() {},
    clearRect: () => ops.push("clear"),
    createImageData: (cw: number, ch: number) => ({ width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }),
    putImageData() {},
    drawImage() {
      ops.push(`draw:${ctx.globalCompositeOperation}`);
    },
  };
  const make = () => {
    const c = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    return c;
  };
  const doc = { createElement: make } as unknown as Document;
  const canvas = { width: 0, height: 0, offsetWidth: w, offsetHeight: h, offsetParent: null, offsetLeft: 0, offsetTop: 0, ownerDocument: doc, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, ops };
}

describe("drawing", () => {
  it("draws with plain alpha compositing only, and clears when the light goes", () => {
    const { canvas, ops } = fakeCanvas();
    const holo = createBackHolo(canvas);
    holo.draw({ ...ON, hover: 0 });
    expect(ops).toEqual([]);
    holo.draw(ON);
    expect(canvas.width).toBe(280 * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)));
    expect(ops).toEqual(["clear", "draw:source-over", "draw:source-in", "draw:destination-over"]);
    ops.length = 0;
    holo.draw({ ...ON, hover: 0 });
    expect(ops).toEqual(["clear"]);
    holo.dispose();
    holo.draw(ON);
    expect(ops).toEqual(["clear"]);
  });

  it("is fed by the hover: the light follows the pointer and goes when it leaves", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ left: 100, top: 100, width: 280, height: 392, right: 380, bottom: 492, x: 100, y: 100, toJSON() {} }) as DOMRect;
    document.body.appendChild(el);
    const seen: BackLight[] = [];
    const action = cardHover(el, { enabled: true, onlight: (l) => seen.push(l) });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 380, clientY: 100, isPrimary: true }));
    vi.advanceTimersByTime(1000);
    const lit = seen.at(-1)!;
    expect(lit.hover).toBeGreaterThan(0.95);
    expect(lit.x).toBeGreaterThan(0.9);
    expect(lit.y).toBeLessThan(-0.9);
    action.update({ enabled: false, onlight: (l) => seen.push(l) });
    expect(seen.at(-1)!.hover).toBe(0);
    action.destroy();
  });
});
