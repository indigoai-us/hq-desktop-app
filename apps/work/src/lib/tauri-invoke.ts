import type { InvokeFn } from "@hq/platform";

type TauriWindow = Window & {
  __TAURI__?: {
    core?: { invoke?: InvokeFn };
    tauri?: { invoke?: InvokeFn };
  };
};

let tauriModulePromise: Promise<typeof import("@tauri-apps/api/core")> | null =
  null;

function unavailableTauriInvoke(command: string, cause: unknown): Error {
  const error = new Error(`Tauri invoke is unavailable for ${command}`) as Error & {
    cause?: unknown;
  };
  error.cause = cause;
  return error;
}

/**
 * Resolve the module API first. `withGlobalTauri` is deliberately not enabled
 * for the desktop host, but the legacy global remains a compatibility fallback.
 */
export const tauriInvoke: InvokeFn = async (command, args) => {
  let tauri: typeof import("@tauri-apps/api/core");
  try {
    tauri = await (tauriModulePromise ??= import("@tauri-apps/api/core"));
  } catch (moduleError) {
    const globalTauri =
      typeof window === "undefined"
        ? undefined
        : (window as TauriWindow).__TAURI__;
    const invoke = globalTauri?.core?.invoke ?? globalTauri?.tauri?.invoke;
    if (invoke) return invoke(command, args);
    throw unavailableTauriInvoke(command, moduleError);
  }
  return tauri.invoke(command, args);
};
