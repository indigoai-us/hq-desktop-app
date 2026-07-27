import { invoke } from '@tauri-apps/api/core';

export type SettingsPrefs = Record<string, unknown>;
export type SettingsPatch = Readonly<Record<string, unknown>>;

export type SettingsInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const defaultSettingsInvoker: SettingsInvoker = (command, args) => invoke(command, args);

/**
 * Serializes settings patches and merges each patch over the latest persisted
 * preferences immediately before saving.
 */
export class SettingsMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly invokeSettings: SettingsInvoker = defaultSettingsInvoker) {}

  update(patch: SettingsPatch): Promise<void> {
    const capturedPatch = { ...patch };
    const operation = this.tail.then(async () => {
      const current = await this.invokeSettings<SettingsPrefs>('get_settings');
      await this.invokeSettings<void>('save_settings', {
        prefs: { ...current, ...capturedPatch },
      });
    });

    // Keep later mutations runnable after a rejected operation while returning
    // the original promise so the initiating surface can roll back its UI.
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

const sharedSettingsMutations = new SettingsMutationQueue();

/** Persist a minimal settings patch through the process-wide frontend queue. */
export function updateSettings(patch: SettingsPatch): Promise<void> {
  return sharedSettingsMutations.update(patch);
}
