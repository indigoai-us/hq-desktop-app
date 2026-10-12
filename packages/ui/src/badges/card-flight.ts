/**
 * The card's flight between its binder pocket and the stage: the open
 * animation grows the card out of the pocket it was tapped in, and closing
 * puts it back. Pure geometry plus one Web Animations call, so the maths is
 * unit-testable and nothing runs where the API is missing (tests, old
 * webviews) or the person prefers reduced motion.
 */

import { prefersReducedMotion } from "./badge-card.js";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Open: the card grows out of its pocket. Close: a little quicker, back in. */
export const FLIGHT_OPEN_MS = 420;
export const FLIGHT_CLOSE_MS = 280;
/** Settles without overshoot, like a card set down on a table. */
export const FLIGHT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * The transform that puts a card drawn at `to` over `from`: the translate
 * between their centres and the width ratio. Scale is uniform because the
 * pocket and the stage hold the same 5:7 card.
 */
export function flightTransform(from: Box, to: Box): string {
  if (!(to.width > 0) || !(from.width > 0)) return "none";
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const scale = from.width / to.width;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(scale, 4)})`;
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** True when the flight can run here. */
export function canFly(el: Element | null | undefined, origin: Element | null | undefined): boolean {
  return Boolean(
    el &&
      origin &&
      origin.isConnected &&
      typeof (el as HTMLElement).animate === "function" &&
      !prefersReducedMotion(),
  );
}

/**
 * Animate `card` between its own box and `origin`'s. `direction` "in" starts
 * at the pocket and lands on the stage; "out" goes back. Resolves when done,
 * or at once when the flight cannot run.
 */
export function fly(card: HTMLElement | null, origin: HTMLElement | null, direction: "in" | "out"): Promise<void> {
  if (!card || !origin || !canFly(card, origin)) return Promise.resolve();
  const at = flightTransform(origin.getBoundingClientRect(), card.getBoundingClientRect());
  const frames = direction === "in" ? [{ transform: at }, { transform: "none" }] : [{ transform: "none" }, { transform: at }];
  const animation = card.animate(frames, {
    duration: direction === "in" ? FLIGHT_OPEN_MS : FLIGHT_CLOSE_MS,
    easing: FLIGHT_EASE,
    fill: direction === "out" ? "forwards" : "none",
  });
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}
