import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSyncPlatformAdapter } from '../../../../packages/platform/src/tauri/sync-adapter.js';
import { startTraySync } from './traySync';

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

describe('tray Sync Now flag preflight', () => {
  it('routes the App Sync Now handler through the tested adapter helper', () => {
    const app = readFileSync(
      fileURLToPath(new URL('../App.svelte', import.meta.url)),
      'utf8',
    );
    expect(app).toContain('await startTraySync(traySyncAdapter);');
    expect(app).not.toContain("await invoke('start_sync')");
  });

  it('starts immediately after delivering the primed flag value to Rust', async () => {
    const calls: Invocation[] = [];
    let rustGate = false;
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'hq_pro_fetch') {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { 'desktop.mirror-quarantine-move-not-deletion': true },
            }),
          };
        }
        if (cmd === 'set_mirror_quarantine_move_not_deletion') {
          rustGate = args?.enabled === true;
          return null;
        }
        if (cmd === 'start_sync') {
          expect(rustGate).toBe(true);
          return null;
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });

    const startedAt = Date.now();
    await startTraySync(adapter);
    const elapsedMs = Date.now() - startedAt;

    expect(calls.map(({ cmd }) => cmd)).toEqual([
      'hq_pro_fetch',
      'set_mirror_quarantine_move_not_deletion',
      'start_sync',
    ]);
    expect(calls[1]?.args).toMatchObject({ enabled: true });
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
