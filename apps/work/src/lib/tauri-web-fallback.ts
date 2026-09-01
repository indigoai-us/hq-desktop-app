import type { InvokeFn } from "@hq/platform";

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
