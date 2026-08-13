/**
 * Visibility-gated, refcounted interval poller (perf: HQ-DESKTOP CPU/RAM).
 *
 * Background stores used to run app-lifetime `setInterval` loops that kept
 * invoking Tauri commands while nothing on screen consumed the data and while
 * the window was hidden. This helper centralizes the two guards:
 *
 * - **Subscriber gating** — the interval only runs while at least one
 *   consumer holds an acquire lease (`acquire()` → release fn). 0 → 1 runs an
 *   immediate tick (fresh data on mount); 1 → 0 clears the interval entirely.
 * - **Hidden-document skip** — interval ticks are skipped while
 *   `document.hidden` (injectable for tests). The next visible tick refreshes.
 *
 * Pure TS, no Svelte/DOM requirements — clock and hidden-state are injectable
 * so tests never rely on wall-clock time.
 */

export interface GatedPollerOptions {
  intervalMs: number;
  tick: () => void;
  /** Defaults to `document.hidden` (false when no document, e.g. tests/SSR). */
  isHidden?: () => boolean;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface GatedPoller {
  /** Take a lease; the poller runs while ≥1 lease is held. Returns release. */
  acquire(): () => void;
  /** True while the interval timer is scheduled (≥1 subscriber). */
  isRunning(): boolean;
  subscriberCount(): number;
}

export function documentIsHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function createGatedPoller(options: GatedPollerOptions): GatedPoller {
  const { intervalMs, tick, isHidden = documentIsHidden } = options;

  let subscribers = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (timer != null) return;
    // Immediate tick so a mounting surface gets fresh data without waiting a
    // full interval; hidden-state only gates the recurring background ticks.
    tick();
    // Resolve the timer functions at call time (not module/creation time) so
    // injected fakes — including vi.useFakeTimers installed after a store
    // module created its poller at import — always apply.
    const setIntervalFn = options.setIntervalFn ?? globalThis.setInterval;
    timer = setIntervalFn(() => {
      if (isHidden()) return;
      tick();
    }, intervalMs);
  }

  function stop(): void {
    if (timer != null) {
      const clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval;
      clearIntervalFn(timer);
    }
    timer = null;
  }

  return {
    acquire() {
      subscribers += 1;
      if (subscribers === 1) start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers -= 1;
        if (subscribers === 0) stop();
      };
    },
    isRunning() {
      return timer != null;
    },
    subscriberCount() {
      return subscribers;
    },
  };
}
