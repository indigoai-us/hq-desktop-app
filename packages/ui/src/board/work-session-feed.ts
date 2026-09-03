/**
 * Work-session feed (US-008 AC3 / US-015).
 *
 * Work-session records degrade to polling until wake support (US-009) lands
 * on the backend, then switch to wake-driven — feature-detected at runtime,
 * so NO code change is required at flip time:
 *
 * - `wakeSupported` (a capability probe the host may pass) true at start →
 *   never polls; refreshes only on `wake()`.
 * - Otherwise polls every `pollMs`. The FIRST observed work-session wake
 *   (a `work:*` reconcile, a retained work-session topic, or a live kind
 *   wake) proves the backend publishes wakes: the poll timer is stopped and
 *   the feed becomes wake-driven for its lifetime.
 *
 * Callers should invoke `wake()` for both work-session and live wakes.
 * Use {@link shouldTreatAsWorkSessionWake} / {@link isLiveWakeKind} to decide.
 *
 * Platform-pure: timers injectable, refresh is a seam.
 */

import { isWorkSessionTopic } from "./board-reconcile";

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
  /** A work-session or live wake arrived — refresh now and go wake-driven. */
  wake(): void;
  stop(): void;
}

/** True for wake payload kinds that should drive the work-session feed. */
export function isLiveWakeKind(kind: string): boolean {
  const k = kind.trim().toLowerCase();
  return k === "live" || k === "work-session";
}

/**
 * True when a topic or kind should flip/refresh the work-session feed:
 * exact `hq/{uid}/work-session/...` topics, or kind `"live"`.
 */
export function shouldTreatAsWorkSessionWake(topicOrKind: string): boolean {
  const raw = topicOrKind.trim();
  if (!raw) return false;
  if (raw.toLowerCase() === "live") return true;
  if (isLiveWakeKind(raw)) return true;
  return isWorkSessionTopic(raw);
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
