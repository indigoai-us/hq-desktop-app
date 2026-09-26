/**
 * `ChatSidebar`'s `companiesLog()` writes through `api.logToFile` — the
 * TS→Rust bridge onto the `frontend_log` Tauri command — expecting a
 * `[companies] ...` line in `~/.hq/logs/hq-sync.log`. Unit tests around
 * ChatSidebar itself only ever stub `logToFile`, so a broken seam here (wrong
 * command name, dropped args, or `appShell.logToFile` never wired) would pass
 * those tests while never reaching Rust. This exercises the real
 * `createSyncPlatformAdapter` seam end to end (down to the `invoke` call),
 * without touching the actual Tauri runtime.
 */
import { describe, expect, it } from 'vitest';

import { createSyncPlatformAdapter } from './sync-adapter.js';

function adapterWithRecorder() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { ok: true };
    },
    fetch: (() => {
      throw new Error('the adapter must not use window.fetch');
    }) as unknown as typeof globalThis.fetch,
  });
  return { adapter, calls };
}

describe('sync adapter appShell.logToFile', () => {
  it('invokes the frontend_log command with the tag and message', async () => {
    const { adapter, calls } = adapterWithRecorder();

    await adapter.appShell.logToFile('companies', 'open company=indigo channel=chn_abc');

    expect(calls).toEqual([
      {
        cmd: 'frontend_log',
        args: { tag: 'companies', message: 'open company=indigo channel=chn_abc' },
      },
    ]);
  });
});
