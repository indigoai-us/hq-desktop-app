import type { ClaudeLaunchOptions } from "../adapter.js";

/**
 * `launch_claude_code` arguments: only the options a caller set, so a plain
 * launch still sends `{ path }` exactly as before.
 */
export function claudeLaunchArgs(path: string, opts?: ClaudeLaunchOptions): Record<string, string> {
  return {
    path,
    ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts?.prompt?.trim() ? { prompt: opts.prompt } : {}),
  };
}
