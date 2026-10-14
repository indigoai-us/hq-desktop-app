/**
 * BLANK-3: one wait, however many loaders show it.
 *
 * A page read often shows a ReadLoader that is replaced by another one a
 * moment later (the lazy door's loader, then the page's own). Each new
 * loader restarted the waiting-line and Try again clocks, so a person could
 * wait well past LOADING_MESSAGE_AFTER_MS before seeing a line. A loader that
 * mounts while another is showing, or within HANDOFF_MS of the last one
 * leaving, continues that wait instead of starting a new one.
 */

/** A replacement loader mounting this soon after the last one left continues its wait. */
export const HANDOFF_MS = 250;

let active = 0;
let waitStartedAt = 0;
let lastEndedAt = Number.NEGATIVE_INFINITY;

/** Registers a mounting loader; returns when the wait it shows began (ms epoch). */
export function beginLoaderWait(now: number = Date.now()): number {
  const continues = active > 0 || now - lastEndedAt <= HANDOFF_MS;
  if (!continues) waitStartedAt = now;
  active += 1;
  return waitStartedAt;
}

/** Registers an unmounting loader. */
export function endLoaderWait(now: number = Date.now()): void {
  active = Math.max(0, active - 1);
  if (active === 0) lastEndedAt = now;
}

/** Test seam: forget any wait in progress. */
export function resetLoaderWaits(): void {
  active = 0;
  waitStartedAt = 0;
  lastEndedAt = Number.NEGATIVE_INFINITY;
}
