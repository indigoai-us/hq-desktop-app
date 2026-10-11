/**
 * Share a badge card on social: an image or a short video of the card, in
 * three proportions (square, story and landscape), downloaded from the card
 * stage (BadgeCardModal "Download").
 *
 * Everything is drawn on a 2D canvas, so it works without WebGPU and the
 * file looks the same wherever it is made: the card face (the same layout
 * as BadgeCard.svelte, scaled from its 280px basis), its full-colour ASCII
 * art, a glow in the tier colour, and the story from the card's back.
 *
 * The video is the card as it behaves on the stage: it turns over from its
 * back in 3D, then a pointer drifts across it, the card tilts toward it, and
 * the holographic foil (pearl rainbow, etched rings and a glint, modelled
 * on foil-gpu.ts) follows the light. Recorded with MediaRecorder.
 */

import { TIER_NAME, type ResolvedBadge } from "./badge-catalog.js";
import { CARD_BG, cardDate, cardNumber, cardTierLabel } from "./badge-card.js";
import { drawFullBadge, fullBadgePx } from "./full-badge.js";
import type { AsciiArt } from "./full-ascii-data.js";
import { badgeStory, type BadgeStory } from "./badge-story.js";
import { createFoil, type Foil } from "./foil-gpu.js";

export type ShareShape = "square" | "story" | "landscape";

/** A failure with plain words for the screen; anything else gets generic copy. */
export class ShareError extends Error {
  constructor(readonly copy: string) {
    super(copy);
    this.name = "ShareError";
  }
}
export type ShareKind = "image" | "video";

/** Output size per proportion, at the sizes the big networks ask for. */
export const SHARE_SIZE: Readonly<Record<ShareShape, { w: number; h: number; label: string; ratio: string }>> = {
  square: { w: 1080, h: 1080, label: "Square", ratio: "1:1" },
  story: { w: 1080, h: 1920, label: "Story", ratio: "9:16" },
  landscape: { w: 1920, h: 1080, label: "Landscape", ratio: "16:9" },
};

/** The video: the back, the turn to the face, the pointer over the foil, then a hold. */
export const SHARE_VIDEO_MS = 7000;
const GLOW_MS = 600;
const TURN_MS = 1300;
const HOVER_MS = 4400;
const FPS = 30;
/** Tilt per unit of pointer, exactly as on the stage (badge-card.ts cardTilt). */
const TILT_X = 0.16;
const TILT_Y = 0.12;

const TITLE = "#f4efe8";
const BODY = "rgba(244, 239, 232, 0.86)";
const SUB = "rgba(244, 239, 232, 0.55)";
const SANS = '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace';
const EDGE: Readonly<Record<string, string>> = { 1: "#785037", 2: "#686b79", 3: "#917125" };
const GLOW: Readonly<Record<string, string>> = { 1: "199, 128, 79", 2: "170, 176, 198", 3: "227, 173, 44", L: "154, 74, 214" };
const HQ_GRADIENT = ["#3b22d0", "#9a4ad6", "#ec6f86", "#fca58a"];

/** The HQ wordmark (viewBox 577 × 330), as on the card. */
const HQ_LOGO_PATHS = [
  "M176.594 7.54293H243.149V318.135H176.594V185.024H66.5555V318.135H0V7.54293H66.5555V118.469H176.594V7.54293Z",
  "M529.768 329.671L496.49 296.837C484.806 304.824 471.938 311.036 457.888 315.473C443.985 319.91 429.343 322.128 413.961 322.128C392.959 322.128 373.214 317.987 354.727 309.705C336.239 301.274 319.97 289.738 305.919 275.096C291.869 260.306 280.85 243.223 272.863 223.848C264.877 204.325 260.883 183.397 260.883 161.064C260.883 138.879 264.877 118.099 272.863 98.7239C280.85 79.201 291.869 62.0445 305.919 47.2544C319.97 32.4642 336.239 20.928 354.727 12.6455C373.214 4.21517 392.959 0 413.961 0C435.111 0 454.93 4.21517 473.417 12.6455C491.905 20.928 508.174 32.4642 522.225 47.2544C536.275 62.0445 547.22 79.201 555.059 98.7239C563.045 118.099 567.039 138.879 567.039 161.064C567.039 177.185 564.82 192.641 560.383 207.431C556.094 222.073 550.178 235.754 542.635 248.474L576.8 282.639L529.768 329.671ZM413.961 255.573C420.025 255.573 425.867 254.907 431.487 253.576C437.255 252.245 442.802 250.396 448.126 248.03L429.491 229.394L476.523 182.362L492.94 198.779C495.454 193.011 497.303 186.947 498.486 180.587C499.818 174.227 500.483 167.72 500.483 161.064C500.483 148.049 498.191 135.847 493.606 124.459C489.169 113.07 482.957 103.087 474.97 94.5087C466.984 85.7826 457.74 78.9791 447.239 74.0984C436.886 69.0698 425.793 66.5554 413.961 66.5554C402.129 66.5554 390.962 69.0698 380.461 74.0984C370.108 78.9791 360.939 85.7826 352.952 94.5087C344.965 103.087 338.679 113.07 334.094 124.459C329.657 135.847 327.439 148.049 327.439 161.064C327.439 174.079 329.657 186.355 334.094 197.892C338.679 209.28 344.965 219.337 352.952 228.063C360.939 236.642 370.108 243.371 380.461 248.252C390.962 253.133 402.129 255.573 413.961 255.573Z",
];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The technical grid (the "Technical grid" share card in the
 * hq-accomplishment-badges gallery, designed at 1200 x 630): one vertical
 * rule a side, a dashed rule top and bottom, plus marks where they cross,
 * mono labels in the bands and on the outer rules, the HQ mark under it.
 * `k` scales the 1200 x 630 design to each size.
 */
export interface ShareGrid {
  k: number;
  /** Outer rule, then the inner content edge, on each side (left to right). Only the outer ones are drawn. */
  xs: [number, number, number, number];
  /** Top and bottom dashed rules. */
  ys: [number, number];
}

/** Where everything goes in each proportion. */
export interface ShareLayout {
  grid: ShareGrid;
  card: Box;
  /** The words: beside the card (landscape) or under it, centred (story, square). */
  text: Box;
  /** The card sits on top of the words, and the words are centred under it. */
  stacked: boolean;
  /** Type sizes in output pixels: the mono kicker, the badge name, what they did, why. */
  kicker: number;
  name: number;
  did: number;
  why: number;
  /** Mono labels in the bands and on the rules. */
  label: number;
}

/**
 * The vertical rules drawn: one a side, the outer ones (owner review
 * 2026-10-08). The inner positions still bound the card and the words.
 */
export function ruleXs(g: ShareGrid): [number, number] {
  return [g.xs[0], g.xs[3]];
}

function grid(w: number, h: number, k: number, top: number, bottom: number): ShareGrid {
  return { k, xs: [50 * k, 100 * k, w - 100 * k, w - 50 * k], ys: [top, bottom] };
}

export function shareLayout(shape: ShareShape): ShareLayout {
  const { w, h } = SHARE_SIZE[shape];
  if (shape === "landscape") {
    // The top and bottom rules sit as far in as the side rules, an even gutter all round.
    const g = grid(w, h, 1.6, 50 * 1.6, h - 50 * 1.6);
    const ch = 740;
    const card = { x: g.xs[1] + 80, y: (g.ys[0] + g.ys[1] - ch) / 2, w: ch / 1.4, h: ch };
    const tx = card.x + card.w + 96;
    return { grid: g, card, stacked: false, text: { x: tx, y: card.y, w: g.xs[2] - 80 - tx, h: ch }, kicker: 21, name: 136, did: 42, why: 28, label: 19 };
  }
  if (shape === "story") {
    // The rules and labels sit inside the 9:16 safe area: clear of the top 250px and the reply bar.
    const g = grid(w, h, 1.4, 270, 1550);
    // Room above the card for its near edge to grow as it turns.
    const cw = 480;
    const card = { x: (w - cw) / 2, y: g.ys[0] + 84, w: cw, h: cw * 1.4 };
    return { grid: g, card, stacked: true, text: { x: g.xs[1] + 40, y: card.y + card.h + 64, w: g.xs[2] - g.xs[1] - 80, h: 480 }, kicker: 20, name: 92, did: 36, why: 25, label: 17 };
  }
  // Square: the card on top, the words centred under it. The top and bottom
  // rules sit as far in as the side rules, an even gutter all round.
  const g = grid(w, h, 1.2, 50 * 1.2, h - 50 * 1.2);
  const cw = 380;
  const card = { x: (w - cw) / 2, y: g.ys[0] + 44, w: cw, h: cw * 1.4 };
  const tw = 520;
  return { grid: g, card, stacked: true, text: { x: (w - tw) / 2, y: card.y + card.h + 40, w: tw, h: 300 }, kicker: 15, name: 56, did: 26, why: 19, label: 14 };
}

/** "hq-badge-liftoff-silver-square.png". */
export function shareFileName(badge: ResolvedBadge, shape: ShareShape, ext: string): string {
  const tier = TIER_NAME[badge.tier].toLowerCase();
  return `hq-badge-${badge.def.id}-${tier}-${shape}.${ext}`;
}

/** The video format this webview can record, preferring MP4 for social apps. */
export function pickVideoType(isSupported: (type: string) => boolean): { mime: string; ext: string } | null {
  for (const mime of ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"]) {
    if (isSupported(mime)) return { mime, ext: mime.startsWith("video/mp4") ? "mp4" : "webm" };
  }
  return null;
}

export function canRecordVideo(): boolean {
  return typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickVideoType((t) => MediaRecorder.isTypeSupported(t)) !== null;
}

export interface VideoFrame {
  /** Glow behind the card, 0..1. */
  glow: number;
  /** Rotation about the vertical axis in radians: π shows the back, 0 the face. */
  rotY: number;
  /** Rotation about the horizontal axis in radians. */
  rotX: number;
  /** The light on the foil: where it is on the card (-1..1) and how strong. */
  light: { x: number; y: number; hover: number };
  /** The words beside the card, 0..1. */
  words: number;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Where the video is at `t` ms. */
export function videoFrame(t: number): VideoFrame {
  const glow = clamp01(t / GLOW_MS);
  const turnT = clamp01((t - GLOW_MS) / TURN_MS);
  if (turnT < 1) {
    // The turn: back to face, with a flash of light crossing the foil as it comes round.
    const e = ease(turnT);
    return {
      glow,
      rotY: Math.PI * (1 - e),
      rotX: -0.08 * Math.sin(Math.PI * e),
      light: { x: -1 + 2 * e, y: -0.3, hover: 0.7 * Math.sin(Math.PI * turnT) },
      words: 0,
    };
  }
  const h = t - GLOW_MS - TURN_MS;
  const k = clamp01(h / HOVER_MS);
  // The pointer drifts in a slow figure eight; the card tilts toward it.
  const px = 0.75 * Math.sin(2 * Math.PI * k - 0.4);
  const py = 0.55 * Math.sin(4 * Math.PI * k + 0.6);
  const hover = h >= HOVER_MS ? 0 : Math.min(1, h / 400, (HOVER_MS - h) / 500);
  return {
    glow: 1,
    // `|| 0`: no negative zero once the light has gone.
    rotY: px * TILT_X * hover || 0,
    rotX: -py * TILT_Y * hover || 0,
    light: { x: px, y: py, hover },
    words: clamp01(h / 500),
  };
}

// ── Drawing ──────────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, b: Box, r: number): void {
  ctx.beginPath();
  ctx.moveTo(b.x + r, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r);
  ctx.closePath();
}

function setSpacing(ctx: CanvasRenderingContext2D, em: number, size: number): void {
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${em * size}px`;
}

function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, fill: string): number {
  const s = height / 330;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = fill;
  for (const d of HQ_LOGO_PATHS) ctx.fill(new Path2D(d));
  ctx.restore();
  return 577 * s;
}

function edgeStyle(ctx: CanvasRenderingContext2D, badge: ResolvedBadge, b: Box): string | CanvasGradient {
  if (badge.tier !== "L") return EDGE[String(badge.tier)];
  const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
  HQ_GRADIENT.forEach((c, i) => g.addColorStop(i / (HQ_GRADIENT.length - 1), c));
  return g;
}

/**
 * Wrap `text` to `width` with even lines: the narrowest width that keeps the
 * same number of lines, so the last line never holds one word on its own.
 */
export function balancedLines(measure: (s: string) => number, text: string, width: number, maxLines = 4): string[] {
  const lines = wrapLines(measure, text, width, maxLines);
  if (lines.length < 2) return lines;
  let best = lines;
  for (let w = width * 0.98; w > width * 0.5; w *= 0.98) {
    const next = wrapLines(measure, text, w, maxLines);
    if (next.length !== lines.length || next.some((l) => l.endsWith("…"))) break;
    best = next;
  }
  return best;
}

/** Wrap `text` to `width`, at most `maxLines` lines. */
export function wrapLines(measure: (s: string) => number, text: string, width: number, maxLines = 4): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.,]?$/u, "")}…`;
    return kept;
  }
  return lines;
}

/** The card's face, laid out as BadgeCard.svelte at 280px and scaled to `b.w`. */
function drawFace(ctx: CanvasRenderingContext2D, b: Box, badge: ResolvedBadge, art: HTMLCanvasElement | null, ground = true): void {
  const u = b.w / 280;
  ctx.save();
  roundRect(ctx, b, 12 * u);
  ctx.clip();
  // Without `ground` the card and art come from the foil shader; only the words and frame go on top.
  if (ground) {
    ctx.fillStyle = CARD_BG;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  // Top row: the HQ mark and the card's number.
  const topY = b.y + 24 * u;
  drawLogo(ctx, b.x + 28 * u, topY, 15 * u, SUB);
  ctx.font = `400 ${9.5 * u}px ${MONO}`;
  setSpacing(ctx, 0.16, 9.5 * u);
  ctx.fillStyle = SUB;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(cardNumber(badge.def.id).toUpperCase(), b.x + b.w - 28 * u, topY + 7.5 * u);

  // The art.
  if (art && ground) {
    const size = 216 * u;
    ctx.drawImage(art, b.x + (b.w - size) / 2, b.y + 52 * u, size, size);
  }

  // Name, what earns it, and the tier line.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TITLE;
  ctx.font = `500 ${24 * u}px ${SANS}`;
  setSpacing(ctx, -0.04, 24 * u);
  ctx.fillText(badge.def.name, b.x + 28 * u, b.y + 302 * u);
  ctx.fillStyle = SUB;
  ctx.font = `400 ${11.5 * u}px ${SANS}`;
  setSpacing(ctx, 0, 11.5 * u);
  wrapLines((s) => ctx.measureText(s).width, `${badge.def.crit}.`, 224 * u, 2).forEach((line, i) => {
    ctx.fillText(line, b.x + 28 * u, b.y + (322 + i * 15.5) * u);
  });
  const ruleY = b.y + b.h - 41 * u;
  ctx.fillStyle = edgeStyle(ctx, badge, b);
  ctx.fillRect(b.x + 28 * u, ruleY, b.w - 56 * u, Math.max(1, u));
  ctx.font = `500 ${8 * u}px ${MONO}`;
  setSpacing(ctx, 0.14, 8 * u);
  ctx.fillStyle = TITLE;
  ctx.fillText(cardTierLabel(badge.tier).toUpperCase(), b.x + 28 * u, b.y + b.h - 22 * u);
  ctx.textAlign = "right";
  ctx.fillStyle = SUB;
  ctx.font = `400 ${8 * u}px ${MONO}`;
  ctx.fillText(cardDate(badge.earnedAt).toUpperCase(), b.x + b.w - 28 * u, b.y + b.h - 22 * u);
  setSpacing(ctx, 0, 8 * u);

  ctx.restore();

  drawFrame(ctx, b, badge);
}

/** The card's back: the HQ mark on the dark card, for the start of the video. */
function drawBack(ctx: CanvasRenderingContext2D, b: Box, badge: ResolvedBadge): void {
  ctx.save();
  roundRect(ctx, b, 12 * (b.w / 280));
  ctx.clip();
  ctx.fillStyle = CARD_BG;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  // Faint rings, as on the card's back on the stage.
  const u = b.w / 280;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
  ctx.lineWidth = Math.max(1, u);
  for (let r = 7 * u; r < Math.hypot(b.w, b.h) / 2; r += 7 * u) {
    ctx.beginPath();
    ctx.arc(b.x + b.w / 2, b.y + b.h / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const lw = b.w * 0.26;
  drawLogo(ctx, b.x + (b.w - lw) / 2, b.y + b.h / 2 - (lw * 330) / 577 / 2, (lw * 330) / 577, "rgba(244, 239, 232, 0.5)");
  ctx.restore();
  drawFrame(ctx, b, badge);
}

function drawFrame(ctx: CanvasRenderingContext2D, b: Box, badge: ResolvedBadge): void {
  const u = b.w / 280;
  ctx.save();
  ctx.lineWidth = Math.max(1, u);
  ctx.strokeStyle = edgeStyle(ctx, badge, b);
  roundRect(ctx, { x: b.x + 8 * u, y: b.y + 8 * u, w: b.w - 16 * u, h: b.h - 16 * u }, 9 * u);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
  roundRect(ctx, b, 12 * u);
  ctx.stroke();
  ctx.restore();
}

function drawStage(ctx: CanvasRenderingContext2D, shape: ShareShape, badge: ResolvedBadge, glow: number, dx: number, dy: number): void {
  const { w, h } = SHARE_SIZE[shape];
  const base = shareLayout(shape).card;
  const card = { ...base, x: base.x + dx, y: base.y + dy };
  ctx.fillStyle = CARD_BG;
  ctx.fillRect(0, 0, w, h);
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  const r = Math.max(card.w, card.h) * 1.05;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  const rgb = GLOW[String(badge.tier)];
  g.addColorStop(0, `rgba(${rgb}, ${0.24 * glow})`);
  g.addColorStop(0.62, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

const RULE = "rgba(244, 239, 232, 0.5)";
const ROMAN_TIER: Readonly<Record<string, string>> = { 1: "I", 2: "II", 3: "III", L: "L" };

/** "HQ-B-004 · T-II": the badge's code, on the right-hand rule. */
export function shareCode(badge: ResolvedBadge): string {
  const n = cardNumber(badge.def.id).match(/\d+/u)?.[0] ?? "000";
  return `HQ-B-${n} · T-${ROMAN_TIER[String(badge.tier)]}`;
}

/** The light tag on the bottom rule: where to find HQ (owner review 2026-10-08). */
export const SHARE_TAG = "HQFORWORK.COM";
/** The label on the left rule; the right rule carries the badge's code. */
export const SHARE_SIDE_LABEL = "HQ ACCOMPLISHMENT BADGE";

function mono(ctx: CanvasRenderingContext2D, size: number, weight = 400): void {
  ctx.font = `${weight} ${size}px ${MONO}`;
  setSpacing(ctx, 0.16, size);
}

/** The rules, marks and labels of the technical grid. */
function drawGrid(ctx: CanvasRenderingContext2D, shape: ShareShape, badge: ResolvedBadge, alpha: number): void {
  const { w, h } = SHARE_SIZE[shape];
  const L = shareLayout(shape);
  const { k, xs, ys } = L.grid;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Where the side labels sit on the outer rules: the rule breaks there.
  const midY = (ys[0] + ys[1]) / 2;
  mono(ctx, L.label * 0.92);
  const sideGap = (text: string) => ctx.measureText(text).width / 2 + 14 * k;
  const rules = ruleXs(L.grid);
  const gaps = [sideGap(SHARE_SIDE_LABEL), sideGap(shareCode(badge).toUpperCase())];
  // Vertical rules, broken where they cross the dashed ones and at the labels.
  ctx.fillStyle = RULE;
  rules.forEach((x, i) => {
    const breaks = ys.map((y) => [y - 12 * k, y + 12 * k] as const);
    if (gaps[i]) breaks.push([midY - gaps[i], midY + gaps[i]] as const);
    breaks.sort((a, b) => a[0] - b[0]);
    let y0 = 0;
    for (const [a, b] of breaks) {
      ctx.fillRect(x - 0.5, y0, 1, a - y0);
      y0 = b;
    }
    ctx.fillRect(x - 0.5, y0, 1, h - y0);
  });
  // The HQ mark sits on the top rule at the left, across from the tag on the
  // bottom rule at the right; the rule breaks around it.
  const logo = shareLogoBox(L.grid);
  // Dashed rules, broken where they cross the vertical ones and around the mark.
  ys.forEach((y, row) => {
    for (let x = 0; x < w; x += 6 * k) {
      if (rules.some((v) => Math.abs(x - v) < 10 * k)) continue;
      if (row === 0 && x + 3 * k > logo.x - 14 * k && x < logo.x + logo.w + 14 * k) continue;
      ctx.fillRect(x, y - 0.5, 3 * k, 1);
    }
  });
  // Plus marks at the crossings.
  ctx.fillStyle = TITLE;
  const p = 4.5 * k;
  for (const x of rules) for (const y of ys) {
    ctx.fillRect(x - p, y - 0.5, 2 * p, 1);
    ctx.fillRect(x - 0.5, y - p, 1, 2 * p);
  }

  // Labels on the outer rules, in the breaks.
  ctx.textBaseline = "middle";
  const side = (text: string, x: number, angle: number) => {
    ctx.save();
    ctx.translate(x, midY);
    ctx.rotate(angle);
    mono(ctx, L.label * 0.92);
    ctx.fillStyle = "rgba(244, 239, 232, 0.85)";
    ctx.textAlign = "center";
    ctx.fillText(text, 0, 1);
    ctx.restore();
  };
  side(SHARE_SIDE_LABEL, xs[0], -Math.PI / 2);
  side(shareCode(badge).toUpperCase(), xs[3], Math.PI / 2);

  // Where to find HQ, a light tag sitting on the bottom rule.
  mono(ctx, L.label);
  const tag = SHARE_TAG;
  const tw = ctx.measureText(tag).width;
  const padX = 14 * k;
  const th = L.label + 14 * k;
  const tx = xs[2] - 20 * k - tw - padX * 2;
  ctx.fillStyle = TITLE;
  ctx.fillRect(tx, ys[1] - th / 2, tw + padX * 2, th);
  ctx.fillStyle = CARD_BG;
  ctx.textAlign = "left";
  ctx.fillText(tag, tx + padX, ys[1] + 1);

  drawLogo(ctx, logo.x, logo.y, logo.h, TITLE);
  ctx.restore();
}

/** The HQ mark on the top rule: left-aligned where the tag is right-aligned below, centred on the rule. */
export function shareLogoBox(g: ShareGrid): Box {
  const h = 26 * g.k;
  const w = (h * 577) / 330;
  return { x: g.xs[1] + 20 * g.k, y: g.ys[0] - h / 2, w, h };
}

interface CopyPlan {
  kicker: string;
  sizes: { kicker: number; name: number; did: number; why: number };
  name: string[];
  did: string[];
  why: string[];
  /** Height of the block and its widest line. */
  h: number;
  w: number;
}

/**
 * Lay the words out: the kicker, the badge name, what they did, why. Type
 * steps down until the block fits its space (above the bottom rule in the
 * story, the card's height beside it), so a long story never runs into the tag.
 */
function planCopy(ctx: CanvasRenderingContext2D, shape: ShareShape, badge: ResolvedBadge, story: BadgeStory | null, owner: string | null): CopyPlan {
  const L = shareLayout(shape);
  const room = L.stacked ? L.grid.ys[1] - 36 * L.grid.k - L.text.y : L.card.h;
  const measure = (font: string, spacing: number, size: number) => (t: string) => {
    ctx.font = font;
    setSpacing(ctx, spacing, size);
    return ctx.measureText(t).width;
  };
  let plan: CopyPlan | null = null;
  for (let f = 1; f > 0.6; f *= 0.94) {
    const sz = { kicker: L.kicker * Math.max(0.85, f), name: L.name * f, did: L.did * f, why: L.why * f };
    const name = balancedLines(measure(`600 ${sz.name}px ${SANS}`, -0.06, sz.name), badge.def.name, L.text.w, 2);
    const did = balancedLines(measure(`400 ${sz.did}px ${SANS}`, -0.01, sz.did), story?.did ?? `${badge.def.crit}.`, L.text.w, 3);
    const why = story?.why ? balancedLines(measure(`400 ${sz.why}px ${SANS}`, 0, sz.why), story.why, L.text.w, 3) : [];
    const h = sz.kicker * 1.2 + sz.name * 0.3 + name.length * sz.name * 0.92 + sz.did * 0.6 + did.length * sz.did * 1.32 + (why.length ? sz.why * 0.8 + why.length * sz.why * 1.42 : 0);
    const w = Math.max(
      ...name.map(measure(`600 ${sz.name}px ${SANS}`, -0.06, sz.name)),
      ...did.map(measure(`400 ${sz.did}px ${SANS}`, -0.01, sz.did)),
      ...why.map(measure(`400 ${sz.why}px ${SANS}`, 0, sz.why)),
    );
    const kicker = (owner?.trim() ? `${owner.trim()} earned` : "Earned on HQ").toUpperCase();
    plan = { kicker, sizes: sz, name, did, why, h, w };
    if (h <= room) break;
  }
  return plan!;
}

/**
 * Stacked, the card and the words sit as one group centred between the top
 * and bottom rules, keeping at least 50 (design px) under the top rule so the
 * turning card never crosses it.
 */
export function stackShift(shape: ShareShape, copyHeight: number): number {
  const L = shareLayout(shape);
  if (!L.stacked) return 0;
  const [top, bottom] = L.grid.ys;
  const height = L.text.y - L.card.y + copyHeight;
  const centred = top + (bottom - top - height) / 2;
  return Math.max(top + 50 * L.grid.k, centred) - L.card.y;
}

/** Side by side, the card and the words sit as one group centred between the inner rules. */
export function groupShift(shape: ShareShape, copyWidth: number): number {
  const L = shareLayout(shape);
  if (L.stacked) return 0;
  const [, innerL, innerR] = L.grid.xs;
  const groupW = L.text.x - L.card.x + Math.min(copyWidth, L.text.w);
  const want = innerL + (innerR - innerL - groupW) / 2;
  return Math.max(0, want - L.card.x);
}

function drawWords(ctx: CanvasRenderingContext2D, shape: ShareShape, plan: CopyPlan, dx: number, dy: number, alpha: number): void {
  if (alpha <= 0) return;
  const L = shareLayout(shape);
  const { text, card } = L;
  const sz = plan.sizes;
  // Beside the card, centred on it; or under the card, centred across.
  let y = L.stacked ? text.y + dy : card.y + (card.h - plan.h) / 2;
  const x = L.stacked ? text.x + text.w / 2 : text.x + dx;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = L.stacked ? "center" : "left";
  ctx.textBaseline = "alphabetic";
  mono(ctx, sz.kicker);
  ctx.fillStyle = "rgba(244, 239, 232, 0.75)";
  y += sz.kicker;
  ctx.fillText(plan.kicker, x, y);
  y += sz.name * 0.3;
  ctx.fillStyle = TITLE;
  ctx.font = `600 ${sz.name}px ${SANS}`;
  setSpacing(ctx, -0.06, sz.name);
  for (const line of plan.name) {
    y += sz.name * 0.92;
    ctx.fillText(line, x, y);
  }
  y += sz.did * 0.6;
  ctx.fillStyle = BODY;
  ctx.font = `400 ${sz.did}px ${SANS}`;
  setSpacing(ctx, -0.01, sz.did);
  for (const line of plan.did) {
    y += sz.did * 1.32;
    ctx.fillText(line, x, y);
  }
  if (plan.why.length) {
    y += sz.why * 0.8;
    ctx.fillStyle = SUB;
    ctx.font = `400 ${sz.why}px ${SANS}`;
    setSpacing(ctx, 0, sz.why);
    for (const line of plan.why) {
      y += sz.why * 1.42;
      ctx.fillText(line, x, y);
    }
  }
  ctx.restore();
}

// ── Holographic foil ─────────────────────────────────────────────────────

/** foil-gpu.ts pearlColor: the rainbow the foil reflects. */
function pearl(phase: number): string {
  const c = (o: number, base: number, amp: number) => Math.round(255 * Math.min(1, Math.max(0, base + amp * Math.cos(2 * Math.PI * (phase + o)))));
  return `rgb(${c(0.05, 0.55, 0.43)}, ${c(0.38, 0.52, 0.4)}, ${c(0.63, 0.64, 0.34)})`;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

function ctx2d(cv: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = cv.getContext("2d");
  if (!c) throw new ShareError("This window can't draw the image.");
  return c;
}

/**
 * Light the foil on a flat face texture: a pearl rainbow with etched rings,
 * shown where a diagonal band of light meets a spotlight at the pointer, and
 * a narrow glint along the band (the light model of foil-gpu.ts).
 */
function applyFoil(face: CanvasRenderingContext2D, layer: HTMLCanvasElement, light: VideoFrame["light"], tilt: { x: number; y: number }): void {
  if (light.hover <= 0.001) return;
  const W = layer.width;
  const H = layer.height;
  const unit = W / 1.28; // foil-gpu half-card units: the card is 1.28 wide
  const lx = W / 2 + light.x * (W / 2);
  const ly = H / 2 + light.y * (H / 2);
  const dir = { x: 0.72, y: 0.52 };
  const dl = Math.hypot(dir.x, dir.y);
  const nx = dir.x / dl;
  const ny = dir.y / dl;
  const f = ctx2d(layer);
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.globalCompositeOperation = "source-over";
  f.clearRect(0, 0, W, H);

  // Pearl rainbow across the band direction; its phase moves with the tilt.
  const shift = tilt.x * 2.2 + tilt.y * 1.6 + light.x * 0.18;
  const span = Math.hypot(W, H);
  const g = f.createLinearGradient(W / 2 - nx * span / 2, H / 2 - ny * span / 2, W / 2 + nx * span / 2, H / 2 + ny * span / 2);
  for (let i = 0; i <= 12; i += 1) g.addColorStop(i / 12, pearl(shift + (i / 12) * 1.6));
  f.globalAlpha = 0.42;
  f.fillStyle = g;
  f.fillRect(0, 0, W, H);

  // Etched rings around a point a little off centre, in the same pearl, faint.
  f.globalAlpha = 0.32;
  f.lineWidth = Math.max(1, W / 420);
  const cx = W / 2 + 0.13 * unit;
  const cy = H / 2 + 0.08 * unit;
  const step = (2 * Math.PI / 142) * unit;
  for (let r = step, i = 0; r < span; r += step, i += 1) {
    f.strokeStyle = pearl(shift + i * 0.045);
    f.beginPath();
    f.ellipse(cx, cy, r, r / 0.76, 0, 0, Math.PI * 2);
    f.stroke();
  }

  // The glint: a narrow bright line along the band (feathered by the masks below).
  f.globalAlpha = 1;
  const gw = 0.085 * unit * 2.2;
  const glint = f.createLinearGradient(lx - nx * gw, ly - ny * gw, lx + nx * gw, ly + ny * gw);
  glint.addColorStop(0, "rgba(255,255,255,0)");
  glint.addColorStop(0.5, "rgba(255,255,255,0.5)");
  glint.addColorStop(1, "rgba(255,255,255,0)");
  f.fillStyle = glint;
  f.fillRect(0, 0, W, H);

  // Keep it where the light is: the band through the pointer, times the spotlight.
  f.globalAlpha = 1;
  f.globalCompositeOperation = "destination-in";
  const bw = 0.36 * unit * 2.2;
  const band = f.createLinearGradient(lx - nx * bw, ly - ny * bw, lx + nx * bw, ly + ny * bw);
  for (let i = 0; i <= 10; i += 1) band.addColorStop(i / 10, `rgba(0,0,0,${Math.exp(-((((i / 10) - 0.5) * 4) ** 2)).toFixed(3)})`);
  f.fillStyle = band;
  f.fillRect(0, 0, W, H);
  // A wide, soft spotlight: no edge to the light.
  const spot = f.createRadialGradient(lx, ly, 0, lx, ly, unit * 1.3);
  for (let i = 0; i <= 8; i += 1) spot.addColorStop(i / 8, `rgba(0,0,0,${Math.exp(-(((i / 8) * 2.2) ** 2)).toFixed(3)})`);
  f.fillStyle = spot;
  f.fillRect(0, 0, W, H);

  // Onto the face, inside the card's frame, lightening only.
  const u = W / 280;
  face.save();
  roundRect(face, { x: 8 * u, y: 8 * u, w: W - 16 * u, h: H - 16 * u }, 9 * u);
  face.clip();
  face.globalCompositeOperation = "screen";
  face.globalAlpha = Math.min(1, light.hover);
  face.drawImage(layer, 0, 0);
  face.restore();
}

// ── The stage's own foil ─────────────────────────────────────────────────

/** The card's real hover shader (foil-gpu.ts), drawn off screen for the share files. */
interface GpuFoil {
  canvas: HTMLCanvasElement;
  foil: Foil;
  host: HTMLElement;
}

/**
 * Set up the stage's WebGPU foil for a card `w` x `h` px, laid out as
 * BadgeCard.svelte (scaled from 280px) so the shader places the art, the
 * fade under the title and the corner brackets where the card does. Null
 * where WebGPU is missing: the share files fall back to the 2D foil.
 */
async function gpuFoil(badge: ResolvedBadge, art: HTMLCanvasElement | null, w: number, h: number): Promise<GpuFoil | null> {
  if (!art || typeof document === "undefined" || !(navigator as Navigator & { gpu?: unknown }).gpu) return null;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;visibility:hidden;";
  const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  // The shader draws at the card's CSS size times the screen scale; size the card so the canvas is `w` px.
  const cssW = w / dpr;
  const cssU = cssW / 280;
  const card = document.createElement("div");
  card.style.cssText = `position:relative;width:${cssW}px;height:${(h / dpr).toFixed(2)}px;`;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  const artEl = art;
  artEl.style.cssText = `position:absolute;left:${(cssW - 216 * cssU) / 2}px;top:${52 * cssU}px;width:${216 * cssU}px;height:${216 * cssU}px;`;
  const title = document.createElement("div");
  title.style.cssText = `position:absolute;left:${24 * cssU}px;top:${283 * cssU}px;padding-left:${4 * cssU}px;`;
  card.append(canvas, artEl, title);
  host.append(card);
  document.body.append(host);
  const foil = createFoil({ canvas, card, art: artEl, title, tier: badge.tier === "L" ? "L" : String(badge.tier) });
  const ok = await foil.ready.catch(() => false);
  if (!ok || !canvas.width) {
    foil.dispose();
    host.remove();
    return null;
  }
  return { canvas, foil, host };
}

/** Put the shader's card under the face's words and frame. */
function litFromGpu(lit: CanvasRenderingContext2D, scene: ShareScene, gpu: GpuFoil, f: VideoFrame): void {
  const W = scene.lit.width;
  const H = scene.lit.height;
  gpu.foil.draw({ tiltX: f.rotY, tiltY: f.rotX, lightX: f.light.x, lightY: f.light.y, hover: f.light.hover });
  lit.save();
  roundRect(lit, { x: 0, y: 0, w: W, h: H }, 12 * (W / 280));
  lit.clip();
  lit.drawImage(gpu.canvas, 0, 0, W, H);
  lit.restore();
  drawFace(lit, { x: 0, y: 0, w: W, h: H }, scene.badge, null, false);
}

// ── 3D ───────────────────────────────────────────────────────────────────

/**
 * Draw a flat card texture turned in 3D, centred at (cx, cy): rotX then rotY,
 * with a perspective of 3.5 card widths (the stage's camera). Done in strips,
 * rows for the tilt and columns for the turn, each scaled by its depth.
 */
function drawTurned(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, tmp: HTMLCanvasElement, cx: number, cy: number, rotX: number, rotY: number): void {
  const W = tex.width;
  const H = tex.height;
  const d = W * 3.5;
  const step = 2;
  // Rows: tilt about the horizontal axis.
  const t = ctx2d(tmp);
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.clearRect(0, 0, tmp.width, tmp.height);
  const tcx = tmp.width / 2;
  const tcy = tmp.height / 2;
  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  for (let y0 = 0; y0 < H; y0 += step) {
    const yc = y0 + step / 2 - H / 2;
    const s = d / (d - yc * sinX);
    t.drawImage(tex, 0, y0, W, step, tcx - (W * s) / 2, tcy + yc * cosX * s - (step * s) / 2, W * s, step * s * Math.abs(cosX) + 0.6);
  }
  // Columns: turn about the vertical axis.
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const TW = tmp.width;
  const TH = tmp.height;
  for (let x0 = 0; x0 < TW; x0 += step) {
    const xc = x0 + step / 2 - TW / 2;
    const s = d / (d + xc * sinY);
    const w = Math.max(0.6, step * Math.abs(cosY) * s + 0.6);
    ctx.drawImage(tmp, x0, 0, step, TH, cx + xc * cosY * s - w / 2, cy - (TH * s) / 2, w, TH * s);
  }
}

/** Everything one frame needs, made once. */
export interface ShareScene {
  badge: ResolvedBadge;
  shape: ShareShape;
  /** Whose card; none is your own. Named in the kicker ("Maya Chen earned"). */
  owner: string | null;
  /** The words, laid out once, and how far the card and words move to centre as a group. */
  copy: CopyPlan;
  dx: number;
  dy: number;
  story: BadgeStory | null;
  art: HTMLCanvasElement | null;
  /** Flat face and back at output size, and scratch canvases for each frame. */
  face: HTMLCanvasElement;
  back: HTMLCanvasElement;
  lit: HTMLCanvasElement;
  foil: HTMLCanvasElement;
  tmp: HTMLCanvasElement;
  /** The stage's WebGPU foil, when this window has it. */
  gpu: GpuFoil | null;
}

function cardTextures(badge: ResolvedBadge, art: HTMLCanvasElement | null, w: number, h: number): Pick<ShareScene, "face" | "back" | "lit" | "foil" | "tmp"> {
  w = Math.round(w);
  h = Math.round(h);
  const box = { x: 0, y: 0, w, h };
  const face = canvas(w, h);
  drawFace(ctx2d(face), box, badge, art);
  const back = canvas(w, h);
  drawBack(ctx2d(back), box, badge);
  return { face, back, lit: canvas(w, h), foil: canvas(w, h), tmp: canvas(w * 1.12, h * 1.12) };
}

/** The still: the card flat, with the foil lit from the upper left. */
const STILL_LIGHT = { x: -0.35, y: -0.45, hover: 0.55 };

/** Draw the scene at `t` ms into the video; `null` draws the still. */
export function drawShareFrame(ctx: CanvasRenderingContext2D, scene: ShareScene, t: number | null): void {
  const { badge, shape } = scene;
  const base = shareLayout(shape).card;
  const card = { ...base, x: base.x + scene.dx, y: base.y + scene.dy };
  const f: VideoFrame = t === null ? { glow: 1, rotY: 0, rotX: 0, light: STILL_LIGHT, words: 1 } : videoFrame(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawStage(ctx, shape, badge, 0.4 + 0.6 * f.glow, scene.dx, scene.dy);
  drawGrid(ctx, shape, badge, t === null ? 1 : clamp01(t / 500));

  // A soft shadow under the card, narrowing as it turns edge-on.
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  const across = Math.abs(Math.cos(f.rotY));
  const shadow = ctx.createRadialGradient(cx, card.y + card.h * 1.02, 0, cx, card.y + card.h * 1.02, card.w * 0.7);
  shadow.addColorStop(0, `rgba(0, 0, 0, ${0.55 * (0.3 + 0.7 * across)})`);
  shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.save();
  ctx.translate(cx, card.y + card.h * 1.02);
  ctx.scale(Math.max(0.15, across), 0.18);
  ctx.translate(-cx, -(card.y + card.h * 1.02));
  ctx.fillStyle = shadow;
  ctx.fillRect(card.x - card.w, card.y, card.w * 3, card.h * 2);
  ctx.restore();

  // Which side faces us: the back past a quarter turn, drawn the right way round.
  const showBack = Math.cos(f.rotY) < 0;
  let tex: HTMLCanvasElement;
  if (showBack) tex = scene.back;
  else {
    const lit = ctx2d(scene.lit);
    lit.setTransform(1, 0, 0, 1, 0, 0);
    lit.clearRect(0, 0, scene.lit.width, scene.lit.height);
    if (scene.gpu) litFromGpu(lit, scene, scene.gpu, f);
    else {
      lit.drawImage(scene.face, 0, 0);
      applyFoil(lit, scene.foil, f.light, { x: f.rotY, y: f.rotX });
    }
    tex = scene.lit;
  }
  const rotY = showBack ? f.rotY - Math.PI : f.rotY;
  if (Math.abs(rotY) < 1e-4 && Math.abs(f.rotX) < 1e-4) ctx.drawImage(tex, card.x, card.y, card.w, card.h);
  else drawTurned(ctx, tex, scene.tmp, cx, cy, f.rotX, rotY);
  drawWords(ctx, shape, scene.copy, scene.dx, scene.dy, f.words);
}

async function loadArt(badge: ResolvedBadge, px: number): Promise<HTMLCanvasElement | null> {
  try {
    const { FULL_ASCII } = await import("./full-ascii-data.js");
    const art: AsciiArt | undefined = FULL_ASCII[`${badge.def.id}:${badge.tier}`] ?? FULL_ASCII[`${badge.def.id}:${badge.def.tier}`];
    if (!art) return null;
    const cv = document.createElement("canvas");
    drawFullBadge(cv, art, { scale: Math.max(3, Math.ceil(px / fullBadgePx(1))), dpr: 1, theme: "dark" });
    return cv;
  } catch {
    return null;
  }
}

async function loadFonts(): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts?.load) return;
  await Promise.allSettled([
    fonts.load(`400 24px ${SANS}`),
    fonts.load(`500 24px ${SANS}`),
    fonts.load(`400 12px ${MONO}`),
    fonts.load(`500 12px ${MONO}`),
  ]);
}

/** Set the scene up: fonts, the art at the size it will be drawn, the card's two sides, the story. */
export async function shareScene(badge: ResolvedBadge, shape: ShareShape, owner: string | null): Promise<ShareScene> {
  await loadFonts();
  const card = shareLayout(shape).card;
  const art = await loadArt(badge, (216 / 280) * card.w);
  // On your own card the post is yours: first person. Someone else's is about them.
  const story = badgeStory(badge, owner, owner ? "third" : "first");
  const copy = planCopy(ctx2d(canvas(1, 1)), shape, badge, story, owner);
  const textures = cardTextures(badge, art, card.w, card.h);
  const gpu = await gpuFoil(badge, art, textures.face.width, textures.face.height);
  return { badge, shape, owner, story, art, copy, dx: groupShift(shape, copy.w), dy: stackShift(shape, copy.h), ...textures, gpu };
}

/** Let go of the scene's GPU foil. */
export function disposeScene(scene: ShareScene): void {
  scene.gpu?.foil.dispose();
  scene.gpu?.host.remove();
  scene.gpu = null;
}

function makeCanvas(shape: ShareShape): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = canvas(SHARE_SIZE[shape].w, SHARE_SIZE[shape].h);
  return { canvas: cv, ctx: ctx2d(cv) };
}

export async function renderShareImage(badge: ResolvedBadge, shape: ShareShape, owner: string | null): Promise<Blob> {
  const scene = await shareScene(badge, shape, owner);
  const { canvas: cv, ctx } = makeCanvas(shape);
  try {
    drawShareFrame(ctx, scene, null);
  } finally {
    disposeScene(scene);
  }
  return new Promise((resolve, reject) => {
    cv.toBlob((blob) => (blob ? resolve(blob) : reject(new ShareError("The image could not be made. Try again."))), "image/png");
  });
}

/** Record the video. Runs in real time, about seven seconds. */
export async function renderShareVideo(badge: ResolvedBadge, shape: ShareShape, owner: string | null): Promise<{ blob: Blob; ext: string }> {
  const type = typeof MediaRecorder === "undefined" ? null : pickVideoType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new ShareError("Video isn't available in this window. Try the image.");
  const scene = await shareScene(badge, shape, owner);
  try {
    const { canvas: cv, ctx } = makeCanvas(shape);
    drawShareFrame(ctx, scene, 0);
    const stream = cv.captureStream(FPS);
    const recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 10_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const done = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new ShareError("The video could not be recorded. Try again, or try the image."));
    });
    recorder.start(250);
    // Timers, not animation frames: frames pause when the window is hidden.
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - start;
        drawShareFrame(ctx, scene, Math.min(t, SHARE_VIDEO_MS));
        if (t >= SHARE_VIDEO_MS) resolve();
        else setTimeout(tick, Math.max(0, 1000 / FPS - (performance.now() - start - t)));
      };
      tick();
    });
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    return { blob: recordedVideo(chunks, type.mime), ext: type.ext };
  } finally {
    disposeScene(scene);
  }
}

/** The recorded chunks as one file; an empty recording is an error, never a 0-byte download. */
export function recordedVideo(chunks: readonly Blob[], mime: string): Blob {
  const blob = new Blob(chunks as Blob[], { type: mime.split(";")[0] });
  if (!blob.size) throw new ShareError("The video came out empty. Try again, or try the image.");
  return blob;
}

/** Save a blob as a download, the app's usual way (see activity-model.ts). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Make the file and download it. */
export async function downloadShare(badge: ResolvedBadge, kind: ShareKind, shape: ShareShape, owner: string | null): Promise<void> {
  if (kind === "image") {
    saveBlob(await renderShareImage(badge, shape, owner), shareFileName(badge, shape, "png"));
    return;
  }
  const { blob, ext } = await renderShareVideo(badge, shape, owner);
  saveBlob(blob, shareFileName(badge, shape, ext));
}
