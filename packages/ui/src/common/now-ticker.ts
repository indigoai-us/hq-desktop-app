/**
 * Re-tick clock for relative-time labels (QA-069).
 *
 * Lists store absolute timestamps and format "19m ago" / "in 33m" against a
 * `now` value. Call this from an effect so `now` advances every 30 s while
 * the page is mounted; return the stop function as the effect cleanup.
 */
export const RELATIVE_TIME_TICK_MS = 30_000;

export function startNowTicker(
  onTick: (now: number) => void,
  intervalMs: number = RELATIVE_TIME_TICK_MS,
): () => void {
  const id = setInterval(() => onTick(Date.now()), intervalMs);
  return () => clearInterval(id);
}
