/**
 * One shared request policy for every server call the client makes (R2).
 *
 * Two problems this solves, both of which turn a brief server throttle into a
 * sustained one:
 *
 *  1. No call path inspected HTTP 429 or `Retry-After`. A throttled request
 *     surfaced as a plain failure and the caller retried on its next tick, at
 *     exactly the same rate.
 *  2. Every background poll ran on a fixed interval, so thousands of clients
 *     polled in phase and kept the server at the same aggregate rate no matter
 *     how hard it pushed back.
 *
 * The policy is deliberately transport-agnostic: `retryThrottled` takes a
 * thunk plus a classifier, so the web `fetch` wrapper and the Tauri
 * `hq_pro_fetch` bridge share one implementation and one set of tests.
 *
 * A 429 is a normal server answer, never a crash: nothing here throws on one,
 * and the final result handed back to the caller is byte-for-byte the shape
 * the caller already handled.
 */

/** Statuses the policy retries. Everything else is returned untouched. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** Backoff base for the first retry, before jitter. */
export const RETRY_BASE_MS = 1_000;

/** Ceiling on a single computed backoff, and on an honoured `Retry-After`. */
export const RETRY_CAP_MS = 60_000;

/** Attempts in total, including the first. 4 ⇒ up to 3 retries. */
export const RETRY_MAX_ATTEMPTS = 4;

/** Default poll jitter: ±20% of the nominal interval. */
export const POLL_JITTER_RATIO = 0.2;

/** No poll ever schedules closer than this, whatever the jitter draws. */
export const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * The draw used when a caller does not inject one.
 *
 * Jitter is deliberately unpredictable in production, which makes any test
 * that advances a fake clock by an exact interval flaky. A component test can
 * pin this to 0.5 (the nominal interval) instead of threading a `random`
 * option through every poll call site.
 */
let defaultRandom: () => number = Math.random;

/** Pin the jitter draw. Tests only; pass no argument to restore `Math.random`. */
export function setJitterRandomForTests(random?: () => number): void {
  defaultRandom = random ?? Math.random;
}

export function isRetryableStatus(status: number | null | undefined): boolean {
  return status != null && RETRYABLE_STATUSES.has(status);
}

/**
 * `Retry-After` in milliseconds, or null when absent/unparseable.
 *
 * Both RFC 9110 forms are accepted: delta-seconds ("2") and an HTTP-date
 * ("Wed, 21 Oct 2015 07:28:00 GMT"). A date in the past yields 0, which is a
 * real answer — the server said "now" — not a missing header.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (header == null) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1_000;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Full-jitter exponential backoff: `random() * min(cap, base * 2^attempt)`.
 *
 * Full jitter (rather than a jittered band around the nominal delay) is what
 * actually de-phases a fleet — the AWS architecture-blog result. `attempt` is
 * zero-based: attempt 0 is the wait before the first retry.
 */
export function fullJitterBackoffMs(
  attempt: number,
  opts: {
    baseMs?: number;
    capMs?: number;
    random?: () => number;
  } = {},
): number {
  const baseMs = opts.baseMs ?? RETRY_BASE_MS;
  const capMs = opts.capMs ?? RETRY_CAP_MS;
  const random = opts.random ?? defaultRandom;
  const exponent = Math.min(attempt, 30);
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/**
 * Jittered poll interval: the nominal interval ±`ratio`, floored.
 *
 * The floor keeps a bad `random()` or a tiny configured interval from turning
 * a poll into a spin — no tick is ever scheduled below `floorMs`.
 */
export function jitterIntervalMs(
  intervalMs: number,
  opts: {
    ratio?: number;
    floorMs?: number;
    random?: () => number;
  } = {},
): number {
  const ratio = opts.ratio ?? POLL_JITTER_RATIO;
  const random = opts.random ?? defaultRandom;
  const nominal = Math.max(0, intervalMs);
  const floorMs =
    opts.floorMs ?? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(nominal * (1 - ratio)));
  // random() ∈ [0,1) ⇒ factor ∈ [1-ratio, 1+ratio).
  const factor = 1 - ratio + random() * (2 * ratio);
  return Math.max(floorMs, Math.round(nominal * factor));
}

// ---------------------------------------------------------------------------
// Throttle signal — shared between the request policy and the pollers
// ---------------------------------------------------------------------------

/**
 * The link between "a request was throttled" and "the next poll should not
 * fire on schedule".
 *
 * The request policy writes to it whenever the server returns 429/503; a
 * poller reads it before arming its next tick and waits out whatever is left.
 * Without this, a poll whose request was throttled would come back around at
 * its normal cadence and throttle again.
 */
export interface ThrottleSignal {
  /** Record that the server asked for `waitMs` of quiet. */
  markThrottled(waitMs: number): void;
  /** Milliseconds still owed, 0 when clear. */
  waitMs(): number;
  /** Forget any outstanding wait (a clean response, or a teardown). */
  clear(): void;
}

export function createThrottleSignal(
  now: () => number = Date.now,
): ThrottleSignal {
  let until = 0;
  return {
    markThrottled(waitMs: number): void {
      const at = now() + Math.max(0, waitMs);
      // Never shorten an outstanding wait: the longest pushback wins.
      if (at > until) until = at;
    },
    waitMs(): number {
      return Math.max(0, until - now());
    },
    clear(): void {
      until = 0;
    },
  };
}

/**
 * Process-wide signal. The adapters mark it and the background pollers read
 * it, so a throttle observed on any call path quiets every poll in the app —
 * which is the behaviour the fleet needs, not per-call-site backoff.
 */
export const globalThrottleSignal: ThrottleSignal = createThrottleSignal();

// ---------------------------------------------------------------------------
// Retry loop
// ---------------------------------------------------------------------------

/** What the classifier tells the policy about one attempt's result. */
export interface AttemptClassification {
  /** HTTP status, or null when the attempt never produced one. */
  status: number | null;
  /** Raw `Retry-After` header value, when the transport exposes one. */
  retryAfter?: string | null;
}

export interface RequestPolicyOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Marked on every throttle so background polls back off too. */
  throttle?: ThrottleSignal | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, retrying only while the classifier reports a retryable
 * status, and hand back whatever the last attempt produced.
 *
 * `Retry-After` wins when the server sends one. A `Retry-After` longer than
 * the cap is not slept off — the policy stops and returns the throttled
 * result, so the caller sees its normal failure instead of the app hanging
 * for minutes. The throttle signal still records the full wait, so the
 * background polls honour it.
 */
export async function retryThrottled<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  classify: (result: T) => AttemptClassification,
  opts: RequestPolicyOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? RETRY_MAX_ATTEMPTS);
  const capMs = opts.capMs ?? RETRY_CAP_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const throttle = opts.throttle === undefined ? globalThrottleSignal : opts.throttle;

  let result = await attempt(0);
  for (let index = 0; index < maxAttempts - 1; index += 1) {
    const verdict = classify(result);
    if (!isRetryableStatus(verdict.status)) {
      // A clean answer means the server is no longer pushing back.
      if (verdict.status != null && verdict.status < 400) throttle?.clear();
      return result;
    }
    const headerMs = parseRetryAfterMs(verdict.retryAfter, now());
    const delayMs =
      headerMs ??
      fullJitterBackoffMs(index, {
        baseMs: opts.baseMs,
        capMs,
        random: opts.random,
      });
    throttle?.markThrottled(delayMs);
    if (headerMs != null && headerMs > capMs) return result;
    await sleep(delayMs);
    result = await attempt(index + 1);
  }
  const finalVerdict = classify(result);
  if (isRetryableStatus(finalVerdict.status)) {
    const headerMs = parseRetryAfterMs(finalVerdict.retryAfter, now());
    throttle?.markThrottled(
      headerMs ??
        fullJitterBackoffMs(maxAttempts - 1, {
          baseMs: opts.baseMs,
          capMs,
          random: opts.random,
        }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Jittered, throttle-aware poller
// ---------------------------------------------------------------------------

export interface JitteredPollOptions {
  /** Nominal cadence in ms; each tick is scheduled at this ±`jitterRatio`. */
  intervalMs: number;
  /** Work to run each tick. Awaited, so a slow tick cannot overlap itself. */
  tick: () => void | Promise<void>;
  jitterRatio?: number;
  floorMs?: number;
  random?: () => number;
  /** Defaults to the process-wide signal; pass null to opt a poll out. */
  throttle?: ThrottleSignal | null;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Run one tick immediately before arming the first timer. */
  immediate?: boolean;
}

/**
 * Next delay for a poll: its jittered interval, or the outstanding throttle
 * wait when the server has asked for longer.
 */
export function nextPollDelayMs(
  intervalMs: number,
  opts: {
    jitterRatio?: number;
    floorMs?: number;
    random?: () => number;
    throttle?: ThrottleSignal | null;
  } = {},
): number {
  const jittered = jitterIntervalMs(intervalMs, {
    ratio: opts.jitterRatio,
    floorMs: opts.floorMs,
    random: opts.random,
  });
  const owed = opts.throttle?.waitMs() ?? 0;
  return Math.max(jittered, owed);
}

/**
 * Self-rescheduling poll. Returns its stop function.
 *
 * `setInterval` is the wrong primitive here twice over: it cannot vary its
 * delay, and it keeps firing while a slow tick is still in flight. This
 * schedules the next tick only after the previous one settles, at a jittered
 * delay that is extended by any outstanding throttle.
 */
export function startJitteredPoll(opts: JitteredPollOptions): () => void {
  const setTimeoutFn =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const throttle = opts.throttle === undefined ? globalThrottleSignal : opts.throttle;

  let handle: unknown = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    const delay = nextPollDelayMs(opts.intervalMs, {
      jitterRatio: opts.jitterRatio,
      floorMs: opts.floorMs,
      random: opts.random,
      throttle,
    });
    handle = setTimeoutFn(() => {
      void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await opts.tick();
    } catch {
      // A failing tick must not kill the poll; the next one is armed below.
    }
    arm();
  };

  if (opts.immediate) {
    void run();
  } else {
    arm();
  }

  return () => {
    stopped = true;
    if (handle != null) clearTimeoutFn(handle);
    handle = null;
  };
}
