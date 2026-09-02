/**
 * The single Updates-pane check orchestration.
 *
 * Adopted from the native host's settings pane (main's `refreshVersions`) —
 * its status mapping is canonical and reproduced here verbatim in intent —
 * lifted out of the component so it is unit-testable and so there is exactly
 * ONE orchestration behind every manual and automatic check (mount, window
 * focus, native update events, and the explicit "Check for updates" button).
 *
 * Two hard guarantees this module adds over the inline version it replaces:
 *
 *  1. Per-target independence. The old code awaited `Promise.all` over five
 *     adapter calls and only then committed any row, so one slow call (the
 *     Rust `check_for_updates` serializes behind the background checker's
 *     lock and then does network I/O) pinned ALL THREE rows on "CHECKING".
 *  2. Bounded time. Every call runs under a timeout, and the busy flag is
 *     always released in a `finally`, so a hung check degrades to a visible
 *     "check failed" + retry instead of spinning forever.
 */

export type UpdateRowStatus =
  | "checking"
  | "up-to-date"
  | "available"
  | "unchecked"
  | "unlocated"
  | "failed";

export type UpdateRow = "app" | "core" | "cli";

/** Result envelope used by the platform adapter. */
export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason?: string; message?: string };

export interface UpdateOrchestrationAdapter {
  getVersions(): Promise<AdapterResult<Record<string, unknown>>>;
  checkForUpdates(): Promise<AdapterResult<unknown>>;
  checkCoreState(): Promise<AdapterResult<unknown>>;
  checkCliUpdate(): Promise<AdapterResult<unknown>>;
}

export interface UpdateCheckOutcome {
  appStatus: UpdateRowStatus;
  coreStatus: UpdateRowStatus;
  cliStatus: UpdateRowStatus;
  coreVersion: string | null;
  cliVersion: string | null;
  coreProbeError: string | null;
  cliProbeError: string | null;
  /** Version string from a successful app-updater hit; null when up to date. */
  appUpdateVersion: string | null;
  /** Raw Core state payload (drift, channel, versionBehind) from the check. */
  coreState: unknown;
}

export interface UpdateVersions {
  coreVersion: string | null;
  cliVersion: string | null;
  coreProbeError: string | null;
  cliProbeError: string | null;
}

export interface RunUpdateCheckOptions {
  /** Per-call ceiling. A slower call resolves as a failed row, never a spin. */
  timeoutMs?: number;
  /** Injected by tests; defaults to the ambient timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Commit a row the moment its own check settles. */
  onRow?: (row: UpdateRow, status: UpdateRowStatus) => void;
  /**
   * Commit installed versions as soon as `getVersions()` settles, before the
   * slower Core/CLI comparison checks finish.
   */
  onVersions?: (versions: UpdateVersions) => void;
}

export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 45_000;

const TIMEOUT = Symbol("update-check-timeout");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Native probe envelope: `{ status: "failed", message }` → error string. */
export function probeFailure(value: unknown): string | null {
  const probe = asRecord(value);
  if (probe?.status !== "failed") return null;
  const detail = typeof probe.message === "string" ? probe.message.trim() : "";
  return detail || "The native version probe failed.";
}

/**
 * Race a call against a timeout. A rejected or timed-out call becomes a
 * `failure` result rather than an exception, so no caller can be left with an
 * unresolved busy flag.
 */
async function bounded<T>(
  call: () => Promise<AdapterResult<T>>,
  timeoutMs: number,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<AdapterResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(call)
        .catch(
          (err): AdapterResult<T> => ({
            ok: false,
            reason: "invoke",
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeoutFn(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (raced === TIMEOUT) {
      return {
        ok: false,
        reason: "timeout",
        message: `The check timed out after ${Math.round(timeoutMs / 1000)}s. Try again.`,
      };
    }
    return raced;
  } finally {
    if (timer !== undefined) clearTimeoutFn(timer);
  }
}

/** Map the app updater result onto a row status (main's mapping). */
export function appStatusFrom(check: AdapterResult<unknown>): UpdateRowStatus {
  if (!check.ok) return check.reason === "timeout" ? "failed" : "unchecked";
  return check.value ? "available" : "up-to-date";
}

/** Version offered by a successful app-updater hit. */
export function appUpdateVersionFrom(
  check: AdapterResult<unknown>,
): string | null {
  if (!check.ok) return null;
  const rec = asRecord(check.value);
  const version = rec?.version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

/** Map the Core state result onto a row status (main's mapping). */
export function coreStatusFrom(
  check: AdapterResult<unknown>,
  coreVersion: string | null,
  probeError: string | null,
): UpdateRowStatus {
  if (probeError) return "failed";
  if (!check.ok && check.reason === "timeout") return "failed";
  if (!coreVersion) return check.ok ? "unlocated" : "unchecked";
  const state = check.ok ? asRecord(check.value) : null;
  if (!state || typeof state.versionBehind !== "boolean") return "unchecked";
  return state.versionBehind ? "available" : "up-to-date";
}

/** Map the CLI update result onto a row status (main's mapping). */
export function cliStatusFrom(
  check: AdapterResult<unknown>,
  cliVersion: string | null,
  probeError: string | null,
): UpdateRowStatus {
  if (probeError) return "failed";
  if (!check.ok && check.reason === "timeout") return "failed";
  if (!cliVersion) return check.ok ? "unlocated" : "unchecked";
  if (!check.ok) return "unchecked";
  const state = asRecord(check.value);
  return state && typeof state.latest === "string" ? "available" : "up-to-date";
}

/**
 * Run one full three-row update check. Never rejects, always resolves — the
 * caller can clear its busy flag unconditionally.
 */
export async function runUpdateCheck(
  adapter: UpdateOrchestrationAdapter,
  options: RunUpdateCheckOptions = {},
): Promise<UpdateCheckOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const run = <T>(call: () => Promise<AdapterResult<T>>) =>
    bounded(call, timeoutMs, setTimeoutFn, clearTimeoutFn);

  // The version probe feeds the Core and CLI rows; the app row is fully
  // independent and commits as soon as its own check lands.
  const versionsPromise = run(() => adapter.getVersions());
  const corePromise = run(() => adapter.checkCoreState());
  const cliPromise = run(() => adapter.checkCliUpdate());

  let appUpdateVersion: string | null = null;
  const appPromise = run(() => adapter.checkForUpdates()).then((check) => {
    const status = appStatusFrom(check);
    appUpdateVersion = appUpdateVersionFrom(check);
    options.onRow?.("app", status);
    return status;
  });

  const versions = await versionsPromise;
  const versionRecord = versions.ok ? asRecord(versions.value) : null;
  let coreProbeError = versions.ok
    ? probeFailure(versionRecord?.coreProbe)
    : versions.message ?? "The Core version probe failed.";
  let cliProbeError = versions.ok
    ? probeFailure(versionRecord?.cliProbe)
    : versions.message ?? "The CLI version probe failed.";
  const coreVersion =
    typeof versionRecord?.core === "string" && versionRecord.core
      ? (versionRecord.core as string)
      : null;
  const cliVersion =
    typeof versionRecord?.cli === "string" && versionRecord.cli
      ? (versionRecord.cli as string)
      : null;

  options.onVersions?.({
    coreVersion,
    cliVersion,
    coreProbeError,
    cliProbeError,
  });

  const coreCheck = await corePromise;
  const coreState = coreCheck.ok ? (coreCheck.value ?? null) : null;
  const coreStatus = coreStatusFrom(coreCheck, coreVersion, coreProbeError);
  if (!coreCheck.ok && !coreProbeError) {
    coreProbeError =
      (typeof coreCheck.message === "string" && coreCheck.message.trim()) ||
      "The Core update check failed.";
  }
  options.onRow?.("core", coreStatus);

  const cliCheck = await cliPromise;
  const cliStatus = cliStatusFrom(cliCheck, cliVersion, cliProbeError);
  if (!cliCheck.ok && !cliProbeError) {
    cliProbeError =
      (typeof cliCheck.message === "string" && cliCheck.message.trim()) ||
      "The CLI update check failed.";
  }
  options.onRow?.("cli", cliStatus);

  return {
    appStatus: await appPromise,
    coreStatus,
    cliStatus,
    coreVersion,
    cliVersion,
    coreProbeError,
    cliProbeError,
    appUpdateVersion,
    coreState,
  };
}

export interface UpdateCheckRunner {
  isRunning: () => boolean;
  run: (
    adapter: UpdateOrchestrationAdapter,
    options?: RunUpdateCheckOptions,
  ) => Promise<UpdateCheckOutcome>;
}

/** Coalesce overlapping update checks onto a single in-flight promise. */
export function createUpdateCheckRunner(): UpdateCheckRunner {
  let inFlight: Promise<UpdateCheckOutcome> | null = null;
  return {
    isRunning: () => inFlight !== null,
    run(adapter, options) {
      if (inFlight) return inFlight;
      inFlight = runUpdateCheck(adapter, options).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
