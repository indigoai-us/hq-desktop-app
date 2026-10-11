/**
 * Draws a full-size ASCII Color badge (162px at scale 3): one glyph per cell
 * from the exported grid, then a soft glow of the same layer underneath.
 *
 * Light mode draws heavier glyphs with a tight halo instead of the wide glow:
 * glyphs this small antialias to about half opacity, so on a light surface
 * they need the extra weight and body to read. Pass the light colours
 * (full-ascii-data-light.ts) as `art` in that case.
 */

import { BADGE_FONT } from "./badge-mark.js";
import type { BadgeTheme } from "./badge-theme.js";
import { PALETTE_ALPHABET, type AsciiArt } from "./full-ascii-data.js";

const GRID = 48;

export function fullBadgePx(scale = 3): number {
  return GRID * scale + scale * 3 * 2;
}

export function drawFullBadge(cv: HTMLCanvasElement, art: AsciiArt, opts: { scale?: number; dpr?: number; theme?: BadgeTheme } = {}): void {
  const scale = opts.scale ?? 3;
  const light = opts.theme === "light";
  const dpr = Math.max(1, Math.round(opts.dpr ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)));
  const pad = scale * 3;
  const S = fullBadgePx(scale);
  cv.width = Math.round(S * dpr);
  cv.height = Math.round(S * dpr);
  cv.style.width = `${S}px`;
  cv.style.height = `${S}px`;
  const main = cv.getContext("2d");
  if (!main) return;
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.clearRect(0, 0, cv.width, cv.height);

  // Glyph layer.
  const layer = document.createElement("canvas");
  layer.width = cv.width;
  layer.height = cv.height;
  const ctx = layer.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = scale;
  const chh = scale * 2;
  ctx.font = `${light ? 700 : 500} ${Math.max(4, Math.round(chh * 0.7))}px ${BADGE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const palette = art.palette.map((entry) => {
    const [color, alpha] = entry.split("@");
    return { color, alpha: Number(alpha) || 1 };
  });
  art.chars.forEach((row, y) => {
    const colors = art.colors[y] ?? "";
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === " ") continue;
      const p = palette[PALETTE_ALPHABET.indexOf(colors[x])];
      if (!p) continue;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fillText(ch, pad + x * cw + cw / 2, pad + y * chh + chh / 2);
    }
  });

  // Glow underneath, then the sharp glyphs on top.
  const glow = scale * (light ? 0.9 : 1.6);
  main.filter = `blur(${glow * dpr}px)`;
  main.globalAlpha = 0.85;
  main.drawImage(layer, 0, 0);
  main.filter = "none";
  main.globalAlpha = 1;
  main.drawImage(layer, 0, 0);
}
