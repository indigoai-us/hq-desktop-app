/**
 * Visual first run, "Bring in your context": the Work shell's adapter maps the
 * scan onto the host's two commands, with the scan id the UI listens for.
 */
import { describe, expect, it } from 'vitest';

import { IMPORT_SCAN_EVENT } from '../adapter.js';
import { createSyncPlatformAdapter } from './sync-adapter.js';

function adapterWith(answer: (cmd: string) => unknown) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      const value = answer(cmd);
      if (value instanceof Error) throw value;
      return value;
    },
    fetch: (() => {
      throw new Error('the adapter must not use window.fetch');
    }) as unknown as typeof globalThis.fetch,
  });
  return { adapter, calls };
}

describe('sync adapter context import', () => {
  it('starts and cancels a scan by id through the host commands', async () => {
    const { adapter, calls } = adapterWith((cmd) =>
      cmd === 'import_scan_start' ? { status: 'done', lines: 12, dropped: 0 } : true,
    );
    const started = await adapter.contextImport!.scanStart('scan-1');
    const cancelled = await adapter.contextImport!.scanCancel('scan-1');
    expect(calls).toEqual([
      { cmd: 'import_scan_start', args: { scanId: 'scan-1' } },
      { cmd: 'import_scan_cancel', args: { scanId: 'scan-1' } },
    ]);
    expect(started).toEqual({ ok: true, value: { status: 'done', lines: 12, dropped: 0 } });
    expect(cancelled).toEqual({ ok: true, value: true });
  });

  it('a host without the command answers as a failure, not a throw', async () => {
    const { adapter } = adapterWith(() => new Error('command import_scan_start not found'));
    const started = await adapter.contextImport!.scanStart('scan-2');
    expect(started.ok).toBe(false);
  });

  it('names the event the host emits each line on', () => {
    expect(IMPORT_SCAN_EVENT).toBe('import-scan://event');
  });
});
