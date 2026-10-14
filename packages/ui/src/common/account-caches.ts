/**
 * One place to forget every in-memory per-account read on sign-out.
 *
 * Module caches (company store, Team, picker rosters, personal rail, Outpost,
 * project views) are keyed by company or owner, so a company switch already
 * reads the right entry. Sign-out is different: the next account must never
 * paint the previous account's data, and the old reads must not stay in the
 * webview's heap. Each cache registers its clear function here when its
 * module loads; the shell calls `clearAccountCaches()` on sign-out.
 */
const clears = new Set<() => void>();

/** Register a clear function. Returns the unregister function. */
export function registerAccountCache(clear: () => void): () => void {
  clears.add(clear);
  return () => clears.delete(clear);
}

/** Clear every registered cache. One failing clear never blocks the rest. */
export function clearAccountCaches(): void {
  for (const clear of clears) {
    try {
      clear();
    } catch (error) {
      console.warn("[account-caches] clear failed", error);
    }
  }
}
