import { describe, expect, it } from 'vitest';
import { createSyncPlatformAdapter } from './sync-adapter.js';

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

describe('scope-quarantine mirror feature flag', () => {
  it('primes the Rust snapshot during native shell setup', async () => {
    const calls: Invocation[] = [];
    let notifyFlagSet!: () => void;
    const flagSet = new Promise<void>((resolve) => {
      notifyFlagSet = resolve;
    });
    const adapter = createSyncPlatformAdapter({
      primeMirrorQuarantineGate: true,
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
          notifyFlagSet();
          return null;
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await flagSet;
    expect(adapter.kind).toBe('desktop');
    expect(calls.map((call) => call.cmd)).toEqual([
      'hq_pro_fetch',
      'set_mirror_quarantine_move_not_deletion',
    ]);
    expect(calls[1]?.args).toEqual({ enabled: true });
  });

  it('passes the configured true value into the Rust cache before manual sync', async () => {
    const calls: Invocation[] = [];
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
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'start_sync') return 'hq-sync';
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.sync.startSync('acme')).resolves.toEqual({
      ok: true,
      value: 'hq-sync',
    });
    expect(calls.map((call) => call.cmd)).toEqual([
      'hq_pro_fetch',
      'set_mirror_quarantine_move_not_deletion',
      'start_sync',
    ]);
    expect(calls[1]?.args).toEqual({ enabled: true });
    expect(calls[2]?.args).toEqual({ companySlug: 'acme' });
  });

  it('writes false before daemon start when the flag registry is unavailable', async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'hq_pro_fetch') return { status: 503, body: 'unavailable' };
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'start_daemon') return 'hq-sync';
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.sync.startDaemon()).resolves.toEqual({
      ok: true,
      value: 'hq-sync',
    });
    expect(calls.map((call) => call.cmd)).toEqual([
      'hq_pro_fetch',
      'set_mirror_quarantine_move_not_deletion',
      'start_daemon',
    ]);
    expect(calls[1]?.args).toEqual({ enabled: false });
  });

  it('writes false when the registry has not configured the new key', async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'hq_pro_fetch') {
          return { status: 200, body: JSON.stringify({ version: 1, flags: {} }) };
        }
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'start_sync') return 'hq-sync';
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.sync.startSync()).resolves.toEqual({
      ok: true,
      value: 'hq-sync',
    });
    expect(calls[1]?.args).toEqual({ enabled: false });
  });
});
