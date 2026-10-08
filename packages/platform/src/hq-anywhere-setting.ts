import {
  failure,
  ok,
  unavailable,
  type AdapterPromise,
  type AdapterResult,
  type IdentityApi,
  type SettingsApi,
} from "./adapter.js";
import { HQ_ANYWHERE_RUNTIME_FLAG } from "./flags.js";

export const HQ_ANYWHERE_RETRY_ATTEMPTS = 3;
export const HQ_ANYWHERE_RETRY_DELAYS_MS = [250, 750] as const;

export interface HqAnywhereRetryOptions {
  pause?: (milliseconds: number) => Promise<void>;
}

export type HqAnywhereGlobalRuntimeStatus =
  | { state: "idle" }
  | { state: "running"; enabled: boolean | null }
  | { state: "failed"; enabled: boolean | null };

const IDLE_RUNTIME_STATUS: HqAnywhereGlobalRuntimeStatus = { state: "idle" };
let globalRuntimeStatus: HqAnywhereGlobalRuntimeStatus = IDLE_RUNTIME_STATUS;
const globalRuntimeStatusListeners = new Set<
  (status: HqAnywhereGlobalRuntimeStatus) => void
>();

/** Share startup reconciliation state with the Settings row when it is mounted later. */
export function subscribeHqAnywhereGlobalRuntimeStatus(
  listener: (status: HqAnywhereGlobalRuntimeStatus) => void,
): () => void {
  globalRuntimeStatusListeners.add(listener);
  listener(globalRuntimeStatus);
  return () => globalRuntimeStatusListeners.delete(listener);
}

function publishGlobalRuntimeStatus(
  status: HqAnywhereGlobalRuntimeStatus,
): void {
  globalRuntimeStatus = status;
  for (const listener of globalRuntimeStatusListeners) listener(status);
}

const pauseFor = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Missing, discovered, archived, disabled, or unreadable flags fail closed and hide the setting. */
export async function hqAnywhereRuntimeEnabled(
  identity: IdentityApi,
): Promise<boolean> {
  try {
    const result = await identity.resolveFeatureFlagStatus?.(HQ_ANYWHERE_RUNTIME_FLAG);
    return result?.ok === true && result.value.configured && result.value.enabled;
  } catch (error) {
    console.warn("[hq-anywhere] runtime flag lookup failed:", error);
    return false;
  }
}

/** Retry one person-setting request, preserving the final adapter failure for diagnostics. */
export async function retryHqAnywhereRequest<T>(
  request: () => AdapterPromise<T>,
  options: HqAnywhereRetryOptions = {},
): Promise<AdapterResult<T>> {
  const pause = options.pause ?? pauseFor;
  let lastResult: AdapterResult<T> = unavailable("hq-anywhere-unavailable");

  for (let attempt = 0; attempt < HQ_ANYWHERE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      lastResult = await request();
    } catch (error) {
      lastResult = failure(
        "hq-anywhere-request",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (lastResult.ok) return lastResult;
    const delay = HQ_ANYWHERE_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await pause(delay);
  }

  return lastResult;
}

export function getHqAnywherePersonSetting(
  settings: SettingsApi,
  options?: HqAnywhereRetryOptions,
): Promise<AdapterResult<boolean>> {
  if (!settings.getHqAnywherePersonSetting) {
    return Promise.resolve(unavailable("hq-anywhere-setting-read-unavailable"));
  }
  return retryHqAnywhereRequest(
    () => settings.getHqAnywherePersonSetting!(),
    options,
  );
}

export function putHqAnywherePersonSetting(
  settings: SettingsApi,
  value: boolean,
  options?: HqAnywhereRetryOptions,
): Promise<AdapterResult<void>> {
  if (!settings.putHqAnywherePersonSetting) {
    return Promise.resolve(unavailable("hq-anywhere-setting-write-unavailable"));
  }
  return retryHqAnywhereRequest(
    () => settings.putHqAnywherePersonSetting!(value),
    options,
  );
}

/** Apply a saved HQ Anywhere choice only while its kill switch is enabled. */
export async function setHqAnywhereGlobalRuntime(
  identity: IdentityApi,
  settings: SettingsApi,
  enabled: boolean,
  options?: HqAnywhereRetryOptions,
): Promise<AdapterResult<void>> {
  if (!(await hqAnywhereRuntimeEnabled(identity))) {
    publishGlobalRuntimeStatus(IDLE_RUNTIME_STATUS);
    return ok(undefined);
  }
  publishGlobalRuntimeStatus({ state: "running", enabled });
  let result: AdapterResult<void>;
  try {
    result = settings.syncHqAnywhereGlobal
      ? await retryHqAnywhereRequest(
          () => settings.syncHqAnywhereGlobal!(enabled),
          options,
        )
      : unavailable("hq-anywhere-global-runtime-unavailable");
  } catch (error) {
    result = failure(
      "hq-anywhere-global-runtime",
      error instanceof Error ? error.message : String(error),
    );
  }
  publishGlobalRuntimeStatus(
    result.ok ? IDLE_RUNTIME_STATUS : { state: "failed", enabled },
  );
  return result;
}

/** Reconcile the local setup after sign-in without changing a saved opt-out. */
export async function ensureHqAnywhereGlobalRuntime(
  identity: IdentityApi,
  settings: SettingsApi,
  options?: HqAnywhereRetryOptions,
): Promise<AdapterResult<void>> {
  if (!(await hqAnywhereRuntimeEnabled(identity))) return ok(undefined);
  publishGlobalRuntimeStatus({ state: "running", enabled: null });
  const setting = await getHqAnywherePersonSetting(settings, options);
  if (!setting.ok) {
    publishGlobalRuntimeStatus({ state: "failed", enabled: null });
    return setting;
  }
  return setHqAnywhereGlobalRuntime(identity, settings, setting.value, options);
}
