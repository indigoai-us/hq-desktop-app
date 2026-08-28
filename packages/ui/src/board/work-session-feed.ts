/**
 * Work-session feed (US-008 AC3).
 *
 * Work-session records degrade to polling until wake support (US-009) lands
 * on the backend, then switch to wake-driven — feature-detected at runtime,
 * so NO code change is required at flip time:
 *
 * - `wakeSupported` (a capability probe the host may pass) true at start →
 *   never polls; refreshes only on `wake()`.
 * - Otherwise polls every `pollMs`. The FIRST observed work-session wake
 *   (a `work:*` reconcile, or a retained work-session topic replayed on
 *   subscribe) proves the backend publishes work-session wakes: the poll
 *   timer is stopped and the feed becomes wake-driven for its lifetime.
 *
 * Platform-pure: timers injectable, refresh is a seam.
 */

export interface FeedTimerHost {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type WorkSessionFeedMode = "idle" | "polling" | "wake-driven";

export interface WorkSessionFeedOptions {
  /** Re-fetch work-session records from REST (absent-safe: may resolve []). */
  refresh: () => Promise<void>;
  pollMs: number;
  /** Capability probe: work-session wake topics/retained meta available now. */
  wakeSupported?: () => boolean;
  timers?: FeedTimerHost;
}

export interface WorkSessionFeed {
  readonly mode: WorkSessionFeedMode;
  start(): void;
  /** A work-session wake arrived — refresh now and go wake-driven. */
  wake(): void;
  stop(): void;
}

const realTimers: FeedTimerHost = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function createWorkSessionFeed(
  options: WorkSessionFeedOptions,
): WorkSessionFeed {
  const timers = options.timers ?? realTimers;
  let mode: WorkSessionFeedMode = "idle";
  let handle: unknown = null;
  let stopped = false;

  const stopPolling = (): void => {
    if (handle != null) {
      timers.clearInterval(handle);
      handle = null;
    }
  };

  const refresh = (): void => {
    void options.refresh().catch(() => {
      // Refresh failures are absent-safe; the next tick/wake retries.
    });
  };

  return {
    get mode() {
      return mode;
    },
    start() {
      if (stopped || mode !== "idle") return;
      refresh();
      if (options.wakeSupported?.() === true) {
        mode = "wake-driven";
        return;
      }
      mode = "polling";
      handle = timers.setInterval(refresh, options.pollMs);
    },
    wake() {
      if (stopped) return;
      // Feature detection: an observed wake proves wake support — stop
      // polling permanently and ride wakes from here on.
      stopPolling();
      mode = "wake-driven";
      refresh();
    },
    stop() {
      stopped = true;
      stopPolling();
      mode = "idle";
    },
  };
}
