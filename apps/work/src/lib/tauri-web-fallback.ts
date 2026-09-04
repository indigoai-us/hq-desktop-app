import type { InvokeFn } from "@hq/platform";

type TauriEvent<T> = { payload: T };
type TauriEventHandler<T> = (event: TauriEvent<T>) => void;
type UnlistenFn = () => void;
type TauriListenFn = <T>(
  event: string,
  handler: TauriEventHandler<T>,
) => Promise<UnlistenFn>;

/**
 * Web-only build alias for the dynamic Tauri module import. A browser build
 * must not package Tauri's IPC client, but retain the legacy global fallback
 * if an embedding host supplies one unexpectedly.
 */
export const invoke: InvokeFn = async (command, args) => {
  const tauri = (window as Window & {
    __TAURI__?: {
      core?: { invoke?: InvokeFn };
      tauri?: { invoke?: InvokeFn };
    };
  }).__TAURI__;
  const globalInvoke = tauri?.core?.invoke ?? tauri?.tauri?.invoke;
  if (globalInvoke) return globalInvoke(command, args);
  throw new Error(`Tauri invoke is unavailable for ${command}`);
};

export const listen: TauriListenFn = async (event, handler) => {
  const tauri = (window as Window & {
    __TAURI__?: { event?: { listen?: TauriListenFn } };
  }).__TAURI__;
  const globalListen = tauri?.event?.listen;
  if (globalListen) return globalListen(event, handler);
  throw new Error(`Tauri event listener is unavailable for ${event}`);
};
