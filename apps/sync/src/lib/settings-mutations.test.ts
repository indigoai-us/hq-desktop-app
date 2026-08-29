import { describe, expect, it, vi } from 'vitest';
import {
  SettingsMutationQueue,
  type SettingsInvoker,
  type SettingsPrefs,
  updateSettings,
} from './settings-mutations';

const { tauriInvoke } = vi.hoisted(() => ({ tauriInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

type HarnessOptions = {
  blockFirstSave?: boolean;
  failFirstSave?: boolean;
};

function createHarness(
  initial: SettingsPrefs,
  { blockFirstSave = false, failFirstSave = false }: HarnessOptions = {},
) {
  let persisted = { ...initial };
  let saveCount = 0;
  let inFlightSaves = 0;
  let maxInFlightSaves = 0;
  let releaseFirstSave = () => {};
  const firstSaveGate = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedSnapshots: SettingsPrefs[] = [];

  const invokeSettings = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_settings') return { ...persisted };
    if (command !== 'save_settings') throw new Error(`Unexpected command: ${command}`);

    saveCount += 1;
    inFlightSaves += 1;
    maxInFlightSaves = Math.max(maxInFlightSaves, inFlightSaves);
    const prefs = { ...((args?.prefs ?? {}) as SettingsPrefs) };
    savedSnapshots.push(prefs);

    if (blockFirstSave && saveCount === 1) await firstSaveGate;
    inFlightSaves -= 1;
    if (failFirstSave && saveCount === 1) throw new Error('disk unavailable');
    persisted = prefs;
    return undefined;
  }) as SettingsInvoker;

  return {
    invokeSettings,
    releaseFirstSave,
    savedSnapshots,
    persisted: () => ({ ...persisted }),
    maxInFlightSaves: () => maxInFlightSaves,
  };
}

function settle(promise: Promise<void>) {
  return promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('SettingsMutationQueue', () => {
  it('serializes cross-surface patches and merges each over the latest saved preferences', async () => {
    const harness = createHarness(
      {
        autoUpdate: true,
        notifications: true,
        widgetEnabled: true,
      },
      { blockFirstSave: true },
    );
    const queue = new SettingsMutationQueue(harness.invokeSettings);

    const updaterSave = settle(queue.update({ autoUpdate: false }));
    const widgetSave = settle(queue.update({ widgetEnabled: false }));

    await vi.waitFor(() => expect(harness.savedSnapshots).toHaveLength(1));
    expect(harness.maxInFlightSaves()).toBe(1);
    harness.releaseFirstSave();

    expect(await updaterSave).toEqual({ ok: true });
    expect(await widgetSave).toEqual({ ok: true });
    expect(harness.maxInFlightSaves()).toBe(1);
    expect(harness.savedSnapshots[1]).toEqual({
      autoUpdate: false,
      notifications: true,
      widgetEnabled: false,
    });
  });

  it('preserves repeated widget-toggle order even while the first save is in flight', async () => {
    const harness = createHarness(
      { widgetEnabled: true, widgetDisplay: null },
      { blockFirstSave: true },
    );
    const queue = new SettingsMutationQueue(harness.invokeSettings);

    const disable = settle(queue.update({ widgetEnabled: false }));
    const reenable = settle(queue.update({ widgetEnabled: true }));

    await vi.waitFor(() => expect(harness.savedSnapshots).toHaveLength(1));
    harness.releaseFirstSave();
    expect(await disable).toEqual({ ok: true });
    expect(await reenable).toEqual({ ok: true });

    expect(harness.persisted()).toMatchObject({
      widgetEnabled: true,
      widgetDisplay: null,
    });
    expect(harness.maxInFlightSaves()).toBe(1);
  });

  it('continues with the next queued patch after an earlier save fails', async () => {
    const harness = createHarness(
      { notifications: true, autoUpdate: true },
      { failFirstSave: true },
    );
    const queue = new SettingsMutationQueue(harness.invokeSettings);

    const failed = settle(queue.update({ notifications: false }));
    const recovered = settle(queue.update({ autoUpdate: false }));

    expect((await failed).ok).toBe(false);
    expect(await recovered).toEqual({ ok: true });
    expect(harness.persisted()).toEqual({
      notifications: true,
      autoUpdate: false,
    });
  });

  it('uses a per-operation invoker while sharing ordering with the default invoker', async () => {
    const harness = createHarness(
      { dockIcon: true, widgetEnabled: false },
      { blockFirstSave: true },
    );
    const defaultCalls: string[] = [];
    const explicitCalls: string[] = [];
    const defaultInvoker: SettingsInvoker = (command, args) => {
      defaultCalls.push(command);
      return harness.invokeSettings(command, args);
    };
    const explicitInvoker: SettingsInvoker = (command, args) => {
      explicitCalls.push(command);
      return harness.invokeSettings(command, args);
    };
    const queue = new SettingsMutationQueue(defaultInvoker);

    const dockSave = settle(queue.update({ dockIcon: false }, explicitInvoker));
    const widgetSave = settle(queue.update({ widgetEnabled: true }));

    await vi.waitFor(() => expect(harness.savedSnapshots).toHaveLength(1));
    expect(explicitCalls).toEqual(['get_settings', 'save_settings']);
    expect(defaultCalls).toEqual([]);
    expect(harness.maxInFlightSaves()).toBe(1);
    harness.releaseFirstSave();

    expect(await dockSave).toEqual({ ok: true });
    expect(await widgetSave).toEqual({ ok: true });
    expect(defaultCalls).toEqual(['get_settings', 'save_settings']);
    expect(harness.savedSnapshots[1]).toEqual({
      dockIcon: false,
      widgetEnabled: true,
    });
  });

  it('routes the exported shared helper through the default Tauri adapter', async () => {
    let persisted: SettingsPrefs = { notifications: true, autoUpdate: true };
    tauriInvoke.mockImplementation(
      async (command: string, args?: { prefs?: SettingsPrefs }) => {
        if (command === 'get_settings') return { ...persisted };
        if (command === 'save_settings') {
          persisted = { ...(args?.prefs ?? {}) };
          return undefined;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );

    await updateSettings({ notifications: false });

    expect(persisted).toEqual({ notifications: false, autoUpdate: true });
    expect(tauriInvoke).toHaveBeenCalledWith('save_settings', {
      prefs: { notifications: false, autoUpdate: true },
    });
  });
});
