export type SettingsPrefs = Record<string, unknown>;
export type SettingsPatch = Readonly<Record<string, unknown>>;

export type SettingsInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Serializes settings patches and merges each patch over the latest persisted
 * preferences immediately before saving. The host invokes commands through
 * the injected function, so this shared module has no Tauri runtime import.
 */
export class SettingsMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly invokeSettings?: SettingsInvoker) {}

  update(patch: SettingsPatch, invoker?: SettingsInvoker): Promise<void> {
    const capturedPatch = { ...patch };
    const operationInvoker = invoker ?? this.invokeSettings;
    if (!operationInvoker) {
      return Promise.reject(
        new Error('Settings mutations require an injected command invoker.'),
      );
    }
    const operation = this.tail.then(async () => {
      const current = await operationInvoker<SettingsPrefs>('get_settings');
      await operationInvoker<void>('save_settings', {
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

/**
 * Persist a minimal settings patch through the process-wide frontend queue.
 * An optional per-call invoker lets injected host adapters share that ordering
 * without bypassing their own invocation boundary.
 */
export function updateSettings(
  patch: SettingsPatch,
  invoker: SettingsInvoker,
): Promise<void> {
  return sharedSettingsMutations.update(patch, invoker);
}
