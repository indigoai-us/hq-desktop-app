/**
 * Settings write seam + mutation queue (port of the desktop
 * `lib/settings-mutations.ts`).
 *
 * The desktop source serialized `save_settings` patches through a process-wide
 * queue, merging each patch over the latest persisted preferences immediately
 * before saving. The adapter surface (`@hq/platform` SettingsApi) is read-only
 * today, so the WRITE half is expressed as an injected `SettingsWriteIo` the
 * host app supplies (desktop: Tauri save_settings; web: hq-pro settings API).
 * Components take a `SettingsUpdater` prop; hosts build one with
 * `createSettingsMutationQueue`.
 */

type IoResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: "unavailable" | "error";
      code?: string;
      message?: string;
    };

export type SettingsPrefs = Record<string, unknown>;
export type SettingsPatch = Readonly<Record<string, unknown>>;

/** Function components receive to persist a minimal settings patch. Rejects on failure. */
export type SettingsUpdater = (patch: SettingsPatch) => Promise<void>;

export interface SettingsWriteIo {
  getSettings(): Promise<IoResult<SettingsPrefs>>;
  saveSettings(prefs: SettingsPrefs): Promise<IoResult<void>>;
}

function unwrap<T>(res: IoResult<T>, what: string): T {
  if (!res.ok) {
    throw new Error(
      res.message ??
        `${what} failed (${res.reason}${res.code ? `: ${res.code}` : ""})`,
    );
  }
  return res.value;
}

/**
 * Serializes settings patches and merges each patch over the latest persisted
 * preferences immediately before saving — same contract as the desktop queue.
 */
export class SettingsMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly io: SettingsWriteIo) {}

  update(patch: SettingsPatch): Promise<void> {
    const capturedPatch = { ...patch };
    const operation = this.tail.then(async () => {
      const current = unwrap(await this.io.getSettings(), "get settings");
      unwrap(
        await this.io.saveSettings({ ...current, ...capturedPatch }),
        "save settings",
      );
    });

    // Keep later mutations runnable after a rejected operation while returning
    // the original promise so the initiating surface can roll back its UI.
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

/** Build a `SettingsUpdater` bound to one queue over the given io. */
export function createSettingsUpdater(io: SettingsWriteIo): SettingsUpdater {
  const queue = new SettingsMutationQueue(io);
  return (patch) => queue.update(patch);
}
