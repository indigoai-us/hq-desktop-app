export type TauriEvent<T> = { payload: T };
export type TauriEventHandler<T> = (event: TauriEvent<T>) => void;
export type UnlistenFn = () => void;

type TauriListenFn = <T>(
  event: string,
  handler: TauriEventHandler<T>,
) => Promise<UnlistenFn>;

type TauriWindow = Window & {
  __TAURI__?: {
    event?: { listen?: TauriListenFn };
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
