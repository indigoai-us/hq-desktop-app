import { describe, expect, it } from 'vitest';

import {
  SettingsMutationQueue,
  updateSettings,
  type SettingsInvoker,
} from '../../../../packages/platform/src/tauri/settings-mutations';

describe('settings write boundary', () => {
  it('persists a patch through updateSettings by merging it over the latest prefs', async () => {
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_settings') return { theme: 'dark', keep: true };
      if (command === 'save_settings') return undefined;
      throw new Error(`unexpected command ${command} ${JSON.stringify(args)}`);
    }) as SettingsInvoker;
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const recording: SettingsInvoker = (async (command, args) => {
      calls.push({ command, args });
      return invoke(command, args);
    }) as SettingsInvoker;

    await updateSettings({ theme: 'light' }, recording);

    expect(calls.map((call) => call.command)).toEqual(['get_settings', 'save_settings']);
    expect(calls[1]?.args).toEqual({ prefs: { theme: 'light', keep: true } });
  });

  it('serializes SettingsMutationQueue patches so the second save sees the first', async () => {
    let stored: Record<string, unknown> = { keep: true };
    let releaseFirstGet: () => void = () => {};
    const firstGetBlocked = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    let gets = 0;
    const calls: string[] = [];
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === 'get_settings') {
        gets += 1;
        if (gets === 1) await firstGetBlocked;
        return { ...stored };
      }
      if (command === 'save_settings') {
        stored = { ...(args?.prefs as Record<string, unknown>) };
        return undefined;
      }
      throw new Error(`unexpected command ${command}`);
    }) as SettingsInvoker;

    const queue = new SettingsMutationQueue(invoke);
    const first = queue.update({ a: 1 });
    const second = queue.update({ b: 2 });
    releaseFirstGet();
    await first;
    await second;

    expect(stored).toEqual({ keep: true, a: 1, b: 2 });
    expect(calls).toEqual(['get_settings', 'save_settings', 'get_settings', 'save_settings']);
  });

  it('rejects a queue update when no command invoker was injected', async () => {
    const queue = new SettingsMutationQueue();
    await expect(queue.update({ a: 1 })).rejects.toThrow(
      'Settings mutations require an injected command invoker.',
    );
  });
});
