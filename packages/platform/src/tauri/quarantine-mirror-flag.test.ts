import { describe, expect, it, vi } from 'vitest';
import type { FlagClient, FlagClientOptions, FlagSnapshot } from '@indigoai-us/hq-flags-client';
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
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 41;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') {
          notifyFlagSet();
          return null;
        }
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await flagSet;
    expect(adapter.kind).toBe('desktop');
    expect(calls.map((call) => call.cmd)).toEqual([
      'hq_pro_fetch',
      'register_mirror_quarantine_move_not_deletion_generation',
      'set_mirror_quarantine_move_not_deletion',
    ]);
    expect(calls[2]?.args).toMatchObject({ enabled: true, generation: 41 });
    await adapter.dispose?.();
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
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 42;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
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
      'register_mirror_quarantine_move_not_deletion_generation',
      'set_mirror_quarantine_move_not_deletion',
      'start_sync',
    ]);
    expect(calls[2]?.args).toMatchObject({ enabled: true, generation: 42 });
    expect(calls[3]?.args).toEqual({ companySlug: 'acme' });
    await adapter.dispose?.();
  });

  it('writes false before daemon start when the flag registry is unavailable', async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'hq_pro_fetch') return { status: 503, body: 'unavailable' };
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 43;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
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
      'register_mirror_quarantine_move_not_deletion_generation',
      'set_mirror_quarantine_move_not_deletion',
      'start_daemon',
    ]);
    expect(calls[2]?.args).toMatchObject({ enabled: false, generation: 43 });
    await adapter.dispose?.();
  });

  it('delivers every refreshed flag value to Rust', async () => {
    const calls: Invocation[] = [];
    let snapshot: FlagSnapshot = {
      version: 1,
      flags: { 'desktop.mirror-quarantine-move-not-deletion': true },
    };
    let notifySnapshotChange!: () => void;
    const client: FlagClient = {
      explain: () => ({ value: false, source: 'fallback' }),
      ready: async () => {},
      refresh: async () => {},
      snapshot: () => snapshot,
      isEnabled: (key) => snapshot.flags[key] === true,
      observeVersion: () => {},
      onSnapshotChange: (listener) => {
        notifySnapshotChange = () => {
          (listener as () => void)();
        };
        return () => {};
      },
      version: () => snapshot.version,
      close: () => {},
    };
    const adapter = createSyncPlatformAdapter({
      primeMirrorQuarantineGate: true,
      createFlagClient: (_options: FlagClientOptions) => client,
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 51;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
      expect(calls[1]?.args).toMatchObject({ enabled: true, generation: 51 });
    });
    const initial = calls[1]?.args;
    snapshot = {
      version: 2,
      flags: { 'desktop.mirror-quarantine-move-not-deletion': false },
    };
    notifySnapshotChange();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3);
      expect(calls[2]?.args).toMatchObject({ enabled: false });
    });
    expect(calls.filter((call) => call.cmd === 'register_mirror_quarantine_move_not_deletion_generation'))
      .toHaveLength(1);
    expect(calls[2]?.args?.generation).toBe(initial?.generation);
    expect(calls[2]?.args?.revision).toBeGreaterThan(Number(initial?.revision));
    expect(adapter.kind).toBe('desktop');
    await adapter.dispose?.();
  });

  it('unregisters the Rust-issued generation when the adapter is disposed', async () => {
    const calls: Invocation[] = [];
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
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 72;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await vi.waitFor(() => {
      expect(calls.some((call) => call.cmd === 'set_mirror_quarantine_move_not_deletion')).toBe(true);
    });
    await adapter.dispose?.();

    expect(calls.filter((call) => call.cmd === 'register_mirror_quarantine_move_not_deletion_generation'))
      .toHaveLength(1);
    expect(calls.filter((call) => call.cmd === 'unregister_mirror_quarantine_move_not_deletion_generation'))
      .toEqual([{ cmd: 'unregister_mirror_quarantine_move_not_deletion_generation', args: { generation: 72 } }]);
  });

  it('writes false when the registry has not configured the new key', async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'hq_pro_fetch') {
          return { status: 200, body: JSON.stringify({ version: 1, flags: {} }) };
        }
        if (cmd === 'register_mirror_quarantine_move_not_deletion_generation') return 44;
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        if (cmd === 'unregister_mirror_quarantine_move_not_deletion_generation') return null;
        if (cmd === 'start_sync') return 'hq-sync';
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.sync.startSync()).resolves.toEqual({
      ok: true,
      value: 'hq-sync',
    });
    expect(calls[2]?.args).toMatchObject({ enabled: false });
    await adapter.dispose?.();
  });
});
