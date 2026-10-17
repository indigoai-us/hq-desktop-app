/**
 * The holographic light on the back of a badge card (BadgeCardBack.svelte),
 * drawn into a 2D canvas with the face's foil model (foil-gpu.ts).
 *
 * Design decision (owner review 2026-10-16): the back used to paint its light
 * in CSS, a repeating-radial-gradient of rings over a 300% rainbow, blended
 * with `mix-blend-mode: screen` and cut out with a radial `mask-image`. Only a
 * third of the rainbow ever sat under the light, so it read as a flat
 * teal-olive haze, not pearl; its rings were plain circles, not the face's
 * etched contours; and the haze reached across the story, taking its small
 * print from about 5.5:1 contrast to as low as 2:1 under the light. Now the
 * back draws the face's own etched contours (etchedPhase) in the face's pearl
 * rainbow (pearlColor), lit by the same band and spotlight around the
 * pointer, at less strength than the face and softer still under the words,
 * so the story stays easy to read. It is plain alpha over the dark card, with
 * no blend mode and no mask inside the card's 3D turn, so it looks the same
 * in WebKit (the app's webview) and in Chromium.
 *
 * Per frame it costs two tiny light maps worked out in JS and three canvas
 * draws. The etched contours are worked out once per canvas size and shared
 * by every card back of that size.
 */

/** The light on the card, as card-hover.ts tracks it. */
export interface BackLight {
  /** The light, -1..1 across the card. */
  x: number;
  y: number;
  /** How strongly the light is on the card, 0..1. */
  hover: number;
  /** Tilt in radians: x turns the card sideways, y up or down. */
  tiltX: number;
  tiltY: number;
}

/** Where the story's words sit, in card units (the shader's p: -0.64..0.64 across, -0.896..0.896 down). */
export interface QuietBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BackHolo {
  /** Draw one frame with this light. No light clears the canvas. */
  draw(light: BackLight): void;
  dispose(): void;
}

/** The shader's half card, in card units (a 5:7 card). */
const HALF_X = 0.64;
const HALF_Y = 0.896;
/** Light maps are worked out on this grid and drawn smoothed up to the card. */
export const MAP_W = 40;
export const MAP_H = 56;
/**
 * How strong the back's light is next to the face's (foil-gpu.ts fs_main).
 * The face fades its light to a fifth under its own text; the back, mostly
 * words, keeps about half, and less again right under the words (`quiet`).
 */
export const BACK_WASH = 0.45;
export const BACK_LINES = 0.55;

/** foil-gpu.ts pearlColor, in JS: the pearl rainbow at a phase, 0..1 per channel. */
export function pearlColor(phase: number): [number, number, number] {
  const c = (o: number) => Math.cos(6.2831853 * (phase + o));
  return [0.55 + 0.43 * c(0.05), 0.52 + 0.4 * c(0.38), 0.64 + 0.34 * c(0.63)];
}

/** foil-gpu.ts etchedPhase, in JS: the etched contours' phase at a point in card units. */
export function etchedPhase(x: number, y: number): number {
  const wx = Math.sin(y * 7 + Math.sin(x * 4)) * 0.085;
  const wy = Math.sin(x * 6 - y * 3) * 0.07;
  const qx = x + wx - 0.13;
  const qy = y + wy - 0.08;
  const radius = Math.hypot(qx, qy * 0.76);
  return radius * 142 + Math.sin(Math.atan2(qy, qx) * 3 + radius * 8) * 1.7;
}

/**
 * The etched contours at w x h pixels: how much of each pixel a contour
 * covers, 0..255. Antialiased to the pixel the way the shader's stroke() is,
 * so the thin lines neither shimmer nor break up at 1x or 2x.
 */
export function etchedCoverage(w: number, h: number): Uint8ClampedArray {
  const phase = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = ((j + 0.5) / h - 0.5) * HALF_Y * 2;
    for (let i = 0; i < w; i++) phase[j * w + i] = etchedPhase(((i + 0.5) / w - 0.5) * HALF_X * 2, y);
  }
  const out = new Uint8ClampedArray(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const v = phase[k];
      // fwidth(), from the neighbours.
      const dx = Math.abs((i + 1 < w ? phase[k + 1] : v) - (i > 0 ? phase[k - 1] : v)) * (i > 0 && i + 1 < w ? 0.5 : 1);
      const dy = Math.abs((j + 1 < h ? phase[k + w] : v) - (j > 0 ? phase[k - w] : v)) * (j > 0 && j + 1 < h ? 0.5 : 1);
      const aa = Math.max(Math.min(dx + dy, 1), 1e-3);
      // stroke(sin(contour), 0.06, aa)
      const t = Math.max(0, Math.min(1, (Math.abs(Math.sin(v)) - 0.06) / aa));
      out[k] = Math.round((1 - t * t * (3 - 2 * t)) * 255);
    }
  }
  return out;
}

/**
 * The light at one frame on a MAP_W x MAP_H grid, as RGBA (0..255, not
 * premultiplied, like ImageData): `lines` colours the etched contours, `wash` is the soft
 * pearl light around the pointer. Both follow foil-gpu.ts fs_main (light band,
 * spotlight, glint, pearl phase), scaled by BACK_LINES and BACK_WASH. Under
 * `quiet`, the words, the contours fade to 40% and the wash to 75%, as the
 * face fades its foil under its own text.
 */
export function lightMaps(l: BackLight, quiet: QuietBox | null = null, gw = MAP_W, gh = MAP_H): { lines: Uint8ClampedArray; wash: Uint8ClampedArray } {
  const lines = new Uint8ClampedArray(gw * gh * 4);
  const wash = new Uint8ClampedArray(gw * gh * 4);
  const hover = Math.max(0, Math.min(1, l.hover));
  if (hover <= 0) return { lines, wash };
  const sx = Math.sin(l.tiltY), cx = Math.cos(l.tiltY);
  const sy = Math.sin(l.tiltX), cy = Math.cos(l.tiltX);
  // right = (cy, 0, -sy), down = (sy*sx, cx, cy*sx), as in the shader.
  const lcx = l.x * HALF_X, lcy = l.y * HALF_Y;
  const put = (a: Uint8ClampedArray, k: number, r: number, g: number, b: number) => {
    // Light added to the near-black card, as a colour at an alpha over it
    // (ImageData is not premultiplied): its brightest channel sets the alpha.
    const alpha = Math.min(1, Math.max(r, g, b));
    if (alpha <= 0) return;
    a[k] = (r / alpha) * 255;
    a[k + 1] = (g / alpha) * 255;
    a[k + 2] = (b / alpha) * 255;
    a[k + 3] = alpha * 255;
  };
  for (let j = 0; j < gh; j++) {
    const py = ((j + 0.5) / gh - 0.5) * HALF_Y * 2;
    for (let i = 0; i < gw; i++) {
      const px = ((i + 0.5) / gw - 0.5) * HALF_X * 2;
      const dx = px - lcx, dy = py - lcy;
      const sweep = dx * 0.72 + dy * 0.52 + Math.sin(py * 4 + px * 3) * 0.08;
      const band = Math.exp(-((sweep / 0.36) ** 2));
      const glint = Math.exp(-((sweep / 0.085) ** 2));
      const spot = Math.exp(-((dx * 1.05) ** 2 + (dy * 0.72) ** 2) * 2.6);
      const light = band * spot * hover;
      // Light and view directions, projected on the tilted card.
      const hx = cy * px + sy * sx * py, hy = cx * py, hz = -sy * px + cy * sx * py;
      const lx = lcx - hx, ly = lcy - hy, lz = 1.2 - hz;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const vx = -hx, vy = -hy, vz = 4.5 - hz;
      const vl = Math.hypot(vx, vy, vz) || 1;
      const sumx = lx / ll + vx / vl, sumy = ly / ll + vy / vl, sumz = lz / ll + vz / vl;
      const lavx = sumx * cy - sumz * sy;
      const lavy = sumx * sy * sx + sumy * cx + sumz * cy * sx;
      const pearl = pearlColor(lavx * 0.48 - lavy * 0.32 + py * 0.32 + etchedPhase(px, py) * 0.003);
      const k = (j * gw + i) * 4;
      // How far outside the words, eased in over about two lines.
      let open = 1;
      if (quiet) {
        const ox = Math.max(quiet.x0 - px, 0, px - quiet.x1);
        const oy = Math.max(quiet.y0 - py, 0, py - quiet.y1);
        const t = Math.min(1, Math.hypot(ox, oy) / 0.22);
        open = t * t * (3 - 2 * t);
      }
      // The contours: (0.12 + pearl * 0.65) * 0.65 * reveal.
      const reveal = hover * (0.06 + 0.24 * spot + light * 1.15) * 0.65 * BACK_LINES * (0.4 + 0.6 * open);
      put(lines, k, (0.12 + pearl[0] * 0.65) * reveal, (0.14 + pearl[1] * 0.65) * reveal, (0.18 + pearl[2] * 0.65) * reveal);
      // The wash: the pearl light and its glint.
      const g = glint * spot * hover * 0.12;
      const w = light * 0.24;
      const soft = BACK_WASH * (0.75 + 0.25 * open);
      put(
        wash,
        k,
        (pearl[0] * w + (pearl[0] * 0.5 + 0.5) * g + light * 0.09) * soft,
        (pearl[1] * w + (pearl[1] * 0.5 + 0.5) * g + light * 0.094) * soft,
        (pearl[2] * w + (pearl[2] * 0.5 + 0.5) * g + light * 0.097) * soft,
      );
    }
  }
  return { lines, wash };
}

type Ctx = CanvasRenderingContext2D;

/** Etched contours drawn as white at their coverage, one per canvas size. */
const contourCache = new Map<string, HTMLCanvasElement>();

function makeCanvas(doc: Document, w: number, h: number): HTMLCanvasElement {
  const c = doc.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function fill(doc: Document, w: number, h: number, rgba: Uint8ClampedArray): HTMLCanvasElement | null {
  const c = makeCanvas(doc, w, h);
  const ctx = c.getContext("2d") as Ctx | null;
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return c;
}

function contours(doc: Document, w: number, h: number): HTMLCanvasElement | null {
  const key = `${w}x${h}`;
  const hit = contourCache.get(key);
  if (hit) return hit;
  const cov = etchedCoverage(w, h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < cov.length; k++) {
    rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = 255;
    rgba[k * 4 + 3] = cov[k];
  }
  const c = fill(doc, w, h, rgba);
  if (!c) return null;
  // A card back comes in a few sizes at most (the stage, a resized window).
  if (contourCache.size >= 4) contourCache.delete(contourCache.keys().next().value as string);
  contourCache.set(key, c);
  return c;
}

/** Test seam: forget the shared contours. */
export function clearContourCache(): void {
  contourCache.clear();
}

/** An element's box inside `root`, from layout offsets, so the card's tilt does not skew it. */
function boxIn(el: HTMLElement, root: Element | null): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let at: HTMLElement | null = el;
  while (at && at !== root) {
    x += at.offsetLeft;
    y += at.offsetTop;
    at = at.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * The words' box in card units: the union of `text`'s children (the name and
 * the story), measured in the canvas's own frame.
 */
function quietBox(canvas: HTMLCanvasElement, text: HTMLElement | null | undefined): QuietBox | null {
  const cw = canvas.offsetWidth;
  const ch = canvas.offsetHeight;
  if (!text || !cw || !ch) return null;
  const root = canvas.offsetParent;
  const at = boxIn(canvas, root);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const child of Array.from(text.children) as HTMLElement[]) {
    const b = boxIn(child, root);
    if (!b.w || !b.h) continue;
    x0 = Math.min(x0, b.x - at.x);
    y0 = Math.min(y0, b.y - at.y);
    x1 = Math.max(x1, b.x - at.x + b.w);
    y1 = Math.max(y1, b.y - at.y + b.h);
  }
  if (!Number.isFinite(x0)) return null;
  const ux = (v: number) => (v / cw - 0.5) * HALF_X * 2;
  const uy = (v: number) => (v / ch - 0.5) * HALF_Y * 2;
  return { x0: ux(x0), y0: uy(y0), x1: ux(x1), y1: uy(y1) };
}

/** Draws into `canvas`; `text` holds the words the light stays soft under. */
export function createBackHolo(canvas: HTMLCanvasElement, text?: HTMLElement | null): BackHolo {
  const doc = canvas.ownerDocument;
  let ctx: Ctx | null = null;
  let lit = false;
  let disposed = false;
  let linesMap: HTMLCanvasElement | null = null;
  let washMap: HTMLCanvasElement | null = null;
  let linesCtx: Ctx | null = null;
  let washCtx: Ctx | null = null;

  function size(): boolean {
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.round(canvas.offsetWidth * dpr);
    const h = Math.round(canvas.offsetHeight * dpr);
    if (!w || !h) return false;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return true;
  }

  function map(rgba: Uint8ClampedArray, target: Ctx): void {
    const img = target.createImageData(MAP_W, MAP_H);
    img.data.set(rgba);
    target.putImageData(img, 0, 0);
  }

  function draw(l: BackLight): void {
    if (disposed) return;
    if (l.hover < 0.002) {
      if (lit && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      lit = false;
      return;
    }
    if (!size()) return;
    ctx ??= canvas.getContext("2d") as Ctx | null;
    if (!ctx) return;
    if (!linesMap) {
      linesMap = makeCanvas(doc, MAP_W, MAP_H);
      washMap = makeCanvas(doc, MAP_W, MAP_H);
      linesCtx = linesMap.getContext("2d") as Ctx | null;
      washCtx = washMap.getContext("2d") as Ctx | null;
    }
    const etched = contours(doc, canvas.width, canvas.height);
    if (!etched || !linesCtx || !washCtx || !washMap) return;
    const { lines, wash } = lightMaps(l, quietBox(canvas, text));
    map(lines, linesCtx);
    map(wash, washCtx);
    const { width: w, height: h } = canvas;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // The contours, coloured and lit by the light map...
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(etched, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(linesMap, 0, 0, w, h);
    // ...over the soft pearl wash around the pointer.
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(washMap, 0, 0, w, h);
    ctx.restore();
    lit = true;
  }

  return {
    draw,
    dispose() {
      disposed = true;
      ctx = linesCtx = washCtx = null;
      linesMap = washMap = null;
    },
  };
}
