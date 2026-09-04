import { invoke } from '@tauri-apps/api/core';
import {
  updateSettings as updateInjectedSettings,
  type SettingsInvoker,
  type SettingsPatch,
} from '@hq/platform';

export {
  SettingsMutationQueue,
  type SettingsInvoker,
  type SettingsPatch,
  type SettingsPrefs,
} from '@hq/platform';

const defaultSettingsInvoker: SettingsInvoker = (command, args) =>
  invoke(command, args);

/**
 * Sync's standalone settings surfaces use Tauri's invoke function, while
 * shared adapters pass their own injected invoker into the same queue.
 */
export function updateSettings(
  patch: SettingsPatch,
  invoker: SettingsInvoker = defaultSettingsInvoker,
): Promise<void> {
  return updateInjectedSettings(patch, invoker);
}
