/**
 * The Create brief sunrise, as numbers. Every visual quantity is derived
 * from the run's real progress (status.json), so the scene reads as the
 * progress bar it is:
 * - sun elevation = progress (below the horizon at 0, cresting mid-sweep,
 *   fully risen at ready)
 * - sky warmth and horizon glow rise with it; stars fade as it rises
 * - failed: the sun holds where the run stopped and the sky desaturates
 * Pure so the easing rules are testable without a canvas.
 */

export type DawnPhase = "idle" | "running" | "ready" | "failed";

/** Rate of the ease toward the real progress (per second). */
const EASE_RATE = 2.4;
/** How far below the real progress the idle bob can dip (in progress units). */
export const DAWN_BOB = 0.012;

/**
 * Ease the shown progress toward the target (no overshoot: exponential
 * approach from below or above lands on it, never past it).
 */
export function easeDawn(shown: number, target: number, dt: number, time: number, reduced: boolean): number {
  const t = clamp01(target);
  if (reduced) return t;
  void time;
  return clamp01(shown + (t - shown) * (1 - Math.exp(-Math.max(0, dt) * EASE_RATE)));
}

/**
 * What is drawn: the eased value with a slow bob below it, so a long step
 * still moves. Never above the eased value, so never above the real progress.
 */
export function dawnDisplay(eased: number, target: number, time: number, reduced: boolean): number {
  if (reduced || target <= 0 || target >= 1) return clamp01(eased);
  return clamp01(eased - DAWN_BOB * (0.5 + 0.5 * Math.sin(time * 0.9)));
}

export interface DawnLook {
  /** 0..1 eased elevation used for every derived value. */
  elevation: number;
  /** Star opacity multiplier, 1 at night, 0 at full sunrise. */
  stars: number;
  /** Sky warmth, 0 graphite to 1 warm. */
  warmth: number;
  /** 0 full color, 1 grey (failed). */
  desaturate: number;
}

export function dawnLook(shown: number, failedFade: number): DawnLook {
  const elevation = 1 - Math.pow(1 - clamp01(shown), 2.2);
  return {
    elevation,
    stars: 1 - elevation,
    warmth: elevation * (1 - 0.7 * clamp01(failedFade)),
    desaturate: clamp01(failedFade),
  };
}

/** Bloom intensity over its 900 ms life: quick rise, slow fall, 0 outside. */
export function bloomAt(ms: number): number {
  if (ms <= 0 || ms >= 900) return 0;
  return ms < 180 ? ms / 180 : 1 - (ms - 180) / 720;
}

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
