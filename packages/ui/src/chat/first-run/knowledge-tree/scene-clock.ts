/**
 * The scene's clock: seconds since the step first opened, with time spent
 * while the window was hidden left out (as the welcome flow's controller.ts
 * does), so a scene never jumps ahead behind the person's back. Events from
 * the scan are stamped with the same clock.
 */

export interface SceneClock {
  /** Scene seconds now. */
  now(): number;
  /** Stop listening for visibility changes. */
  dispose(): void;
}

interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export function createSceneClock(
  opts: { nowMs?: () => number; doc?: VisibilityDoc | null } = {},
): SceneClock {
  const nowMs = opts.nowMs ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const doc = opts.doc === undefined ? (typeof document !== "undefined" ? document : null) : opts.doc;
  const origin = nowMs();
  let hiddenTotal = 0;
  let hiddenSince: number | null = doc?.hidden ? origin : null;
  const onVisibility = () => {
    if (!doc) return;
    if (doc.hidden && hiddenSince === null) hiddenSince = nowMs();
    else if (!doc.hidden && hiddenSince !== null) {
      hiddenTotal += nowMs() - hiddenSince;
      hiddenSince = null;
    }
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  return {
    now() {
      const at = hiddenSince ?? nowMs();
      return Math.max(0, (at - origin - hiddenTotal) / 1000);
    },
    dispose() {
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
