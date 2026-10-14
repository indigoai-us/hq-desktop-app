/**
 * The only door into the Settings chunk. Settings is a full destination that
 * no first paint needs, so it stays out of the initial JS graph.
 * The promise is memoized; a failed load clears it so the next open retries.
 */
type ShellSettingsModule = typeof import("../settings/ShellSettings.svelte");

let pending: Promise<ShellSettingsModule> | null = null;

export function loadShellSettings(): Promise<ShellSettingsModule> {
  pending ??= import("../settings/ShellSettings.svelte").catch((err) => {
    console.error("[settings] chunk load failed", err);
    pending = null;
    throw err;
  });
  return pending;
}
