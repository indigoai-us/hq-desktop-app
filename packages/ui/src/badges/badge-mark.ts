/**
 * Draws a badge's small ASCII mark on a canvas: a dashed ring in the tier
 * colour (the HQ gradient for Legendary) around a hand-made ASCII icon.
 *
 * "micro" is 54px and "small" is 108px. The icon is drawn on its own layer
 * and placed by its visible pixels, so every icon sits exactly in the centre
 * of the ring whatever its character grid.
 *
 * In light mode the ring uses deeper tier metals and the icon colours are
 * deepened (`inkForLight`) so the mark reads on a light surface.
 */

import {
  HQ_GRADIENT,
  MICRO_ICONS,
  SMALL_ICONS,
  TIER_RING,
  type BadgeDef,
  type BadgeTier,
} from "./badge-catalog.js";
import { inkForLight, type BadgeTheme } from "./badge-theme.js";

export type BadgeMarkSize = "micro" | "small";

export const BADGE_FONT = '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace';

const SMALL_DASHES = 40;
const MICRO_DASHES = 24;
const MICRO_FONT = 8.5;
/** Micro icons are shrunk to fit this radius, so all of them keep the same clear space from the ring. */
const MICRO_ICON_R = 12.5;
/** Small icons are drawn on a slightly reduced grid for clear space inside the ring. */
const ICON_K = 0.82;
const LOCKED_RING = "#7a7385";
/** Tier metals deep enough to read on a light surface. */
const TIER_RING_LIGHT: Readonly<Record<1 | 2 | 3, string>> = { 1: "#8a4522", 2: "#4f566b", 3: "#8f6400" };

function scaleFor(size: BadgeMarkSize): number {
  return size === "micro" ? 1 : 2;
}

/** CSS pixel size of a mark. */
export function badgeMarkPx(size: BadgeMarkSize): number {
  const scale = scaleFor(size);
  return 48 * scale + scale * 3 * 2;
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

export interface DrawBadgeOptions {
  size?: BadgeMarkSize;
  tier?: BadgeTier;
  locked?: boolean;
  dpr?: number;
  theme?: BadgeTheme;
}

export function drawBadgeMark(cv: HTMLCanvasElement, def: BadgeDef, opts: DrawBadgeOptions = {}): void {
  const size = opts.size ?? "micro";
  const micro = size === "micro";
  const scale = scaleFor(size);
  const tier = opts.tier ?? def.tier;
  const locked = Boolean(opts.locked);
  const light = opts.theme === "light";
  const dpr = Math.max(1, Math.round(opts.dpr ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)));
  const pad = scale * 3;
  const S = 48 * scale + pad * 2;
  cv.width = Math.round(S * dpr);
  cv.height = Math.round(S * dpr);
  cv.style.width = `${S}px`;
  cv.style.height = `${S}px`;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);
  const C = S / 2;
  const fs = micro ? MICRO_FONT * scale : Math.round(((48 * scale) / 8) * ICON_K * 0.78);
  const cw = micro ? fs * 0.62 : ((48 * scale) / 16) * ICON_K;
  const chh = micro ? fs * 1.02 : ((48 * scale) / 8) * ICON_K;
  const legendary = tier === "L" && !locked;

  // Ring: dashed, with a dash count that closes evenly, and as thick as the characters' strokes.
  let stroke: string | CanvasGradient = locked ? LOCKED_RING : (light ? TIER_RING_LIGHT : TIER_RING)[tier === "L" ? 3 : tier];
  if (legendary && typeof ctx.createConicGradient === "function") {
    const g = ctx.createConicGradient(0, C, C);
    const order = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0];
    order.forEach((k, i) =>
      g.addColorStop(i / (order.length - 1), mix(HQ_GRADIENT[k], light ? "#1c1036" : "#fff4dc", light ? 0.1 : 0.15)),
    );
    stroke = g;
  }
  const per = (2 * Math.PI * 20.5 * scale) / (micro ? MICRO_DASHES : SMALL_DASHES);
  ctx.setLineDash([per * 0.55, per * 0.45]);
  ctx.lineDashOffset = per * 0.275;
  ctx.beginPath();
  ctx.arc(C, C, 20.5 * scale, 0, Math.PI * 2);
  ctx.lineWidth = fs * 0.15;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.setLineDash([]);

  const icon = (micro ? MICRO_ICONS : SMALL_ICONS)[def.icon];
  if (!icon) return;
  const joins = micro || Boolean(icon.join);

  // Draws the icon on its own layer at font size f; returns the layer and its ink bounds (device px).
  const layer = (f: number) => {
    const L = document.createElement("canvas");
    L.width = cv.width;
    L.height = cv.height;
    const lc = L.getContext("2d");
    if (!lc) return null;
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = f / fs;
    lc.font = `700 ${f}px ${BADGE_FONT}`;
    lc.textAlign = "center";
    lc.textBaseline = "middle";
    icon.art.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === " ") return;
        const accent = icon.acc.includes(ch);
        const color = accent ? icon.a : icon.c;
        lc.fillStyle = locked ? (accent ? "#6f6878" : "#9a93a6") : light ? inkForLight(color) : color;
        const X = pad + (c * cw + cw / 2) * k;
        const Y = pad + (r * chh + chh / 2) * k;
        const up = (icon.art[r - 1] ?? "")[c] === "|";
        const down = (icon.art[r + 1] ?? "")[c] === "|";
        if (joins && ch === "|" && (up || down)) {
          const sw = f * 0.15;
          const top = up ? Y - (chh * k) / 2 : Y - f * 0.42;
          const bottom = down ? Y + (chh * k) / 2 : Y + f * 0.42;
          lc.fillRect(X - sw / 2, top, sw, bottom - top);
          return;
        }
        lc.fillText(ch, X, Y);
      });
    });
    const data = lc.getImageData(0, 0, L.width, L.height).data;
    let x0 = L.width;
    let y0 = L.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < L.height; y++) {
      for (let x = 0; x < L.width; x++) {
        if (data[(y * L.width + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    let rmax = 0;
    const mx = (x0 + x1 + 1) / 2;
    const my = (y0 + y1 + 1) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (data[(y * L.width + x) * 4 + 3] > 24) rmax = Math.max(rmax, Math.hypot(x + 0.5 - mx, y + 0.5 - my));
      }
    }
    return { L, x0, x1, y0, y1, r: rmax / dpr };
  };

  let lay = layer(fs);
  if (lay && micro && lay.r > MICRO_ICON_R * scale) lay = layer((fs * MICRO_ICON_R * scale) / lay.r);
  if (!lay || lay.x1 < 0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(lay.L, Math.round(C * dpr - (lay.x0 + lay.x1 + 1) / 2), Math.round(C * dpr - (lay.y0 + lay.y1 + 1) / 2));
  ctx.restore();
}
