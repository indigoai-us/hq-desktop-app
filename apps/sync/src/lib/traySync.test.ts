import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSyncPlatformAdapter } from '../../../../packages/platform/src/tauri/sync-adapter.js';
import { classifyTraySyncFailure, startTraySync } from './traySync';

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
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 1;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') {
          rustGate = args?.enabled === true;
          return null;
        }
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
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
      'register_mirror_quarantine_move_not_deletion_generation',
      'set_mirror_quarantine_move_not_deletion',
      'start_sync',
    ]);
    expect(calls[2]?.args).toMatchObject({ enabled: true, generation: 1 });
    expect(elapsedMs).toBeLessThan(1_000);
    await adapter.dispose?.();
  });
});

describe('tray Sync Now failure classification (US-016)', () => {
  const cloudOn = async () => true;
  const cloudOff = async () => false;

  it('treats a refusal while all cloud sync is off as idle, whatever the message says', async () => {
    expect(
      await classifyTraySyncFailure(
        'Cloud sync is turned off. Turn it back on in Settings › Sync.',
        cloudOff,
      ),
    ).toBe('sync-off');
    // Reworded copy does not turn the tray red.
    expect(await classifyTraySyncFailure('Some future wording', cloudOff)).toBe('sync-off');
  });

  it('treats any failure while cloud sync is on as an error, even with off-like wording', async () => {
    expect(
      await classifyTraySyncFailure(
        'Cloud sync is turned off. Turn it back on in Settings › Sync.',
        cloudOn,
      ),
    ).toBe('error');
    expect(await classifyTraySyncFailure('Sync is off for acme on this computer.', cloudOn)).toBe(
      'error',
    );
    expect(await classifyTraySyncFailure('spawn failed', cloudOn)).toBe('error');
  });

  it('keeps an already running sync as syncing', async () => {
    expect(await classifyTraySyncFailure('Sync is already running', cloudOff)).toBe(
      'already-running',
    );
  });

  it('counts an unreadable switch as on, so a real failure still shows', async () => {
    const unreadable = async (): Promise<boolean> => {
      throw new Error('ipc down');
    };
    expect(await classifyTraySyncFailure('spawn failed', unreadable)).toBe('error');
  });

  it('App.svelte classifies from the saved switch, not message substrings', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.svelte', import.meta.url)), 'utf8');
    expect(app).toContain("invoke<boolean>('get_cloud_enabled')");
    expect(app).not.toContain("msg.includes('Cloud sync is off')");
    expect(app).not.toContain("msg.includes('Sync is off for')");
  });
});
