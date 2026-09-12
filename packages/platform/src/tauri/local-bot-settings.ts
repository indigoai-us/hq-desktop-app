import type { LocalBotSettingsInput } from "../adapter.js";

/**
 * Tauri args for `local_bots_configure`. Rust takes `Option<String>` per
 * setting: `null` (omitted) leaves it alone, `""` resets it to the default.
 */
export function localBotSettingsArgs(
  name: string,
  settings: LocalBotSettingsInput,
): { name: string; model: string | null; effort: string | null } {
  const arg = (value: string | null | undefined): string | null =>
    value === undefined ? null : value === null ? "" : value.trim();
  return { name, model: arg(settings.model), effort: arg(settings.effort) };
}
