export type TauriEvent<T> = { payload: T };
export type TauriEventHandler<T> = (event: TauriEvent<T>) => void;
export type UnlistenFn = () => void;

type TauriListenFn = <T>(
  event: string,
  handler: TauriEventHandler<T>,
) => Promise<UnlistenFn>;

type TauriEmitFn = (event: string, payload?: unknown) => Promise<void>;

type TauriWindow = Window & {
  __TAURI__?: {
    event?: { listen?: TauriListenFn; emit?: TauriEmitFn };
  };
};

let tauriModulePromise: Promise<typeof import("@tauri-apps/api/event")> | null =
  null;

function unavailableTauriListen(event: string, cause: unknown): Error {
  const error = new Error(`Tauri event listener is unavailable for ${event}`) as Error & {
    cause?: unknown;
  };
  error.cause = cause;
  return error;
}

/**
 * Resolve the module API first. `withGlobalTauri` is deliberately not enabled
 * for the desktop host, but the legacy global remains a compatibility fallback.
 */
export async function tauriListen<T>(
  event: string,
  handler: TauriEventHandler<T>,
): Promise<UnlistenFn> {
  let tauri: typeof import("@tauri-apps/api/event");
  try {
    tauri = await (tauriModulePromise ??= import("@tauri-apps/api/event"));
  } catch (moduleError) {
    const globalTauri =
      typeof window === "undefined"
        ? undefined
        : (window as TauriWindow).__TAURI__;
    const listen = globalTauri?.event?.listen;
    if (listen) return listen(event, handler);
    throw unavailableTauriListen(event, moduleError);
  }
  return tauri.listen(event, handler);
}

/**
 * Publish an app-level event. Same module-first / global-fallback resolution as
 * `tauriListen`, used by the shell's notification-retry seam (PL-03) to ask the
 * controller window to re-run a failed native notification action.
 */
export async function tauriEmit(
  event: string,
  payload?: unknown,
): Promise<void> {
  let tauri: typeof import("@tauri-apps/api/event");
  try {
    tauri = await (tauriModulePromise ??= import("@tauri-apps/api/event"));
  } catch (moduleError) {
    const globalTauri =
      typeof window === "undefined"
        ? undefined
        : (window as TauriWindow).__TAURI__;
    const emit = globalTauri?.event?.emit;
    if (emit) return emit(event, payload);
    throw unavailableTauriListen(event, moduleError);
  }
  return tauri.emit(event, payload);
}
