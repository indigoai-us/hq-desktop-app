/**
 * Small pure helpers shared by the knowledge tree's layout and drawing.
 * Ported from the approved design preview
 * (workspace/previews/first-run-knowledge-tree/js/tree.js and app.js), which
 * took them from the shipped welcome flow (onboarding/welcome/engines.ts):
 * the seeded RNG, Lizzie's stable hash noise, the canvas cubic in-out and the
 * welcome tokens' cubic-bezier easings. Nothing here reads a clock or
 * Math.random, so every drawing built on it is a pure function of its inputs.
 */

export const TAU = Math.PI * 2;
export const UP = -Math.PI / 2;
export const DEG = Math.PI / 180;

/** mulberry32: a small, fast, seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One 32-bit seed from several integers, so each part of the tree has its own stream. */
export function seedOf(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    h ^= part | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Stable hash noise in [0, 1) (engines.ts rnd, NewBotDawn dawnNoise). */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export function angDiff(to: number, from: number): number {
  let d = to - from;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export function smooth(u: number): number {
  const k = clamp01(u);
  return k * k * (3 - 2 * k);
}

/** The canvas cubic in-out (engines.ts ease). */
export const cubicIO = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** Inverse of `cubicIO`, closed form. */
export function invCubicIO(y: number): number {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  return y < 0.5 ? Math.cbrt(y / 4) : 1 - Math.cbrt(2 * (1 - y)) / 2;
}

/** A CSS cubic-bezier timing function, solved by bisection. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i += 1) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** --w-ease-out */
export const easeOut = bezier(0.23, 1, 0.32, 1);
/** --w-ease-in-out */
export const easeInOut = bezier(0.77, 0, 0.175, 1);
