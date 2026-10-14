import { describe, expect, it } from 'vitest';

import { createSyncPlatformAdapter } from './sync-adapter.js';

describe('sync adapter company read scope', () => {
  it('reads the bound company so a one-off read can put it back', async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let bound: string | null = 'acme';
    const adapter = createSyncPlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'get_desktop_active_company') return bound;
        if (command === 'set_desktop_active_company') {
          bound = ((args?.companySlug as string) || null);
          return null;
        }
        throw new Error(`unexpected command ${command}`);
      },
      fetch: (() => {
        throw new Error('the adapter must not use window.fetch');
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.appShell.getActiveCompany!()).resolves.toEqual({ ok: true, value: 'acme' });
    await adapter.appShell.setActiveCompany('indigo');
    await expect(adapter.appShell.getActiveCompany!()).resolves.toEqual({ ok: true, value: 'indigo' });
    expect(calls.map((c) => c.command)).toEqual([
      'get_desktop_active_company',
      'set_desktop_active_company',
      'get_desktop_active_company',
    ]);
  });
});
