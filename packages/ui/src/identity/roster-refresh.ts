/**
 * Company-roster refresh policy shared by the live shells.
 *
 * The roster (`identity.listWorkspaces`) used to be fetched exactly once at
 * mount, and a failed fetch silently left it empty. A brand-new owner whose
 * company was created on the website then saw #welcome lead with "Create a
 * company" until they restarted the app. Two fixes ride this module:
 *
 * 1. A failed fetch retries on a bounded backoff (never forever).
 * 2. The native sync runner's `sync:company-provisioned` / `sync:all-complete`
 *    events re-fetch the roster, so a company that lands mid-session appears
 *    without a restart.
 *
 * Zero-network and framework-free: the shell hands in `load` (fetch + apply,
 * returns whether it succeeded) and a `listen` seam.
 */

/** Backoff between failed roster fetches. Bounded: three retries, then stop. */
export const ROSTER_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];

/** Native sync events after which the roster may have gained a company. */
export const ROSTER_REFRESH_EVENTS = [
  "sync:company-provisioned",
  "sync:all-complete",
] as const;

export type RosterRefreshEvent = (typeof ROSTER_REFRESH_EVENTS)[number];

/**
 * Outcome of one load that was still current when it finished:
 * `applied` — the roster landed; `retrying` — it failed and a backoff retry
 * is armed; `exhausted` — it failed and the retry budget is spent.
 */
export type RosterSettledOutcome = "applied" | "retrying" | "exhausted";

/** Where the shell is in loading the roster for the current session. */
export type RosterStatus = "loading" | "ready" | "failed";

export interface RosterRefresher {
  /**
   * Fetch now. Resolves `true` when the load applied (or was superseded by a
   * newer tenant — nothing left to retry), `false` when it failed and a retry
   * was scheduled (or the retry budget is spent).
   */
  refresh(): Promise<boolean>;
  /** Drop any pending retry and reset the backoff (tenant change, sign-out). */
  cancel(): void;
  /** `cancel()` and ignore every in-flight result from now on. */
  dispose(): void;
  /** True while a backoff timer is armed. */
  readonly retryPending: boolean;
}

export interface RosterRefresherOptions {
  /** Fetch + apply. `false` or a throw means "failed, retry if budget remains". */
  load: () => Promise<boolean>;
  /**
   * Observes every load that was still current when it settled. Loads
   * superseded by `cancel()` / `dispose()` are never reported. Lets a shell
   * drive a loading → ready | failed status without polling `retryPending`.
   */
  onSettled?: (outcome: RosterSettledOutcome) => void;
  delaysMs?: readonly number[];
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function createRosterRefresher(
  options: RosterRefresherOptions,
): RosterRefresher {
  const delays = options.delaysMs ?? ROSTER_RETRY_DELAYS_MS;
  const armTimer =
    options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const disarmTimer =
    options.clearTimeoutFn ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let attempt = 0;
  let timer: unknown = null;
  let disposed = false;
  let inFlight: Promise<boolean> | null = null;
  let queued = false;
  /** Bumped by `cancel()`: loads started under an older epoch are stale. */
  let epoch = 0;

  function clearTimer(): void {
    if (timer != null) {
      disarmTimer(timer);
      timer = null;
    }
  }

  function scheduleRetry(): boolean {
    if (disposed) return false;
    const delay = delays[attempt];
    if (delay === undefined) return false;
    attempt += 1;
    clearTimer();
    timer = armTimer(() => {
      timer = null;
      void refresh();
    }, delay);
    return true;
  }

  async function runOnce(myEpoch: number): Promise<boolean> {
    let applied = false;
    try {
      applied = await options.load();
    } catch {
      applied = false;
    }
    // Superseded (disposed, or cancelled at a tenant boundary): the caller's
    // own `load` already discards stale writes; never retry on its behalf.
    if (disposed || myEpoch !== epoch) return true;
    if (applied) {
      attempt = 0;
      options.onSettled?.("applied");
      return true;
    }
    const retrying = scheduleRetry();
    options.onSettled?.(retrying ? "retrying" : "exhausted");
    return false;
  }

  async function runLoop(myEpoch: number): Promise<boolean> {
    let result = await runOnce(myEpoch);
    // Coalesce: one more pass after the current fetch, never a pile-up.
    while (queued && !disposed && myEpoch === epoch) {
      queued = false;
      clearTimer();
      result = await runOnce(myEpoch);
    }
    return result;
  }

  function refresh(): Promise<boolean> {
    if (disposed) return Promise.resolve(true);
    // A refresh supersedes any armed retry: it IS the retry.
    clearTimer();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const run = runLoop(epoch).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  }

  return {
    refresh,
    cancel() {
      clearTimer();
      queued = false;
      attempt = 0;
      // Abandon any in-flight load: the next refresh must start its own
      // fetch at once rather than wait behind a stale tenant's slow one.
      epoch += 1;
      inFlight = null;
    },
    dispose() {
      disposed = true;
      clearTimer();
      queued = false;
    },
    get retryPending() {
      return timer != null;
    },
  };
}

/** Minimal Tauri-style `listen` seam (`@tauri-apps/api/event` or a host wrapper). */
export type RosterListenFn = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/**
 * Subscribe `onRefresh` to every roster-relevant native sync event. Returns a
 * teardown that never throws (listener registration may still be resolving).
 */
export function subscribeRosterRefreshEvents(
  listen: RosterListenFn,
  onRefresh: (event: RosterRefreshEvent) => void,
): () => void {
  let cancelled = false;
  const unlistens = ROSTER_REFRESH_EVENTS.map((eventName) =>
    listen(eventName, () => {
      if (!cancelled) onRefresh(eventName);
    }).catch(() => () => {}),
  );
  return () => {
    cancelled = true;
    for (const pending of unlistens) {
      void pending
        .then((unlisten) => {
          try {
            unlisten();
          } catch {
            /* teardown must never escape the caller's cleanup pass */
          }
        })
        .catch(() => {});
    }
  };
}
