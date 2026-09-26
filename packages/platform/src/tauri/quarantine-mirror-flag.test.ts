import { describe, expect, it, vi } from 'vitest';
import type { FlagClient, FlagClientOptions, FlagSnapshot } from '@indigoai-us/hq-flags-client';
import { createSyncPlatformAdapter } from './sync-adapter.js';

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    expect(calls[1]?.args).toMatchObject({ enabled: true });
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
    expect(calls[1]?.args).toMatchObject({ enabled: true });
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
    expect(calls[1]?.args).toMatchObject({ enabled: false });
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
        if (cmd === 'set_mirror_quarantine_move_not_deletion') return null;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toMatchObject({ enabled: true });
    });
    const initial = calls[0]?.args;
    snapshot = {
      version: 2,
      flags: { 'desktop.mirror-quarantine-move-not-deletion': false },
    };
    notifySnapshotChange();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
      expect(calls[1]?.args).toMatchObject({ enabled: false });
    });
    expect(calls[1]?.args?.generation).toBe(initial?.generation);
    expect(calls[1]?.args?.revision).toBeGreaterThan(Number(initial?.revision));
    expect(adapter.kind).toBe('desktop');
  });

  it('ignores a late prime from an older adapter generation', async () => {
    const calls: Invocation[] = [];
    const oldReady = deferred<void>();
    const makeClient = (
      ready: () => Promise<void>,
      enabled: boolean,
    ): FlagClient => {
      const snapshot: FlagSnapshot = {
        version: 1,
        flags: { 'desktop.mirror-quarantine-move-not-deletion': enabled },
      };
      return {
        explain: () => ({ value: false, source: 'fallback' }),
        ready,
        refresh: async () => {},
        snapshot: () => snapshot,
        isEnabled: (key) => snapshot.flags[key] === true,
        observeVersion: () => {},
        onSnapshotChange: () => () => {},
        version: () => snapshot.version,
        close: () => {},
      };
    };
    const clients = [
      makeClient(() => oldReady.promise, true),
      makeClient(async () => {}, false),
    ];
    const accepted: {
      current: { generation: number; revision: number; enabled: boolean } | null;
    } = { current: null };
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd !== 'set_mirror_quarantine_move_not_deletion') {
        throw new Error(`unexpected ${cmd}`);
      }
      const incoming = {
        generation: Number(args?.generation),
        revision: Number(args?.revision),
        enabled: args?.enabled === true,
      };
      if (
        !accepted.current ||
        incoming.generation > accepted.current.generation ||
        (incoming.generation === accepted.current.generation &&
          incoming.revision > accepted.current.revision)
      ) {
        accepted.current = incoming;
      }
      return null;
    };
    const createFlagClient = (_options: FlagClientOptions) =>
      clients.shift() ?? makeClient(async () => {}, false);

    createSyncPlatformAdapter({
      invoke,
      createFlagClient,
      primeMirrorQuarantineGate: true,
    });
    createSyncPlatformAdapter({
      invoke,
      createFlagClient,
      primeMirrorQuarantineGate: true,
    });

    await vi.waitFor(() => expect(accepted.current?.enabled).toBe(false));
    const newer = accepted.current;
    oldReady.resolve(undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(accepted.current).toEqual(newer);
    expect(calls[1]?.args?.generation).toBeLessThan(
      Number(calls[0]?.args?.generation),
    );
    expect(accepted.current?.enabled).toBe(false);
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
    expect(calls[1]?.args).toMatchObject({ enabled: false });
  });
});
