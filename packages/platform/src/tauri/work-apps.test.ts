/**
 * Integration auto-detect: the Work shell's adapter maps `detectWorkApps` onto
 * the host's `detect_work_apps` command and passes its answer through.
 */
import { describe, expect, it } from 'vitest';

import type { FoundWorkApps } from '../adapter.js';
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

const FOUND: FoundWorkApps = {
  platform: 'macos',
  scannedAtMs: 1,
  apps: [{ bundleId: 'com.linear', name: 'Linear' }],
  mcpServers: [
    {
      tool: 'claude_code',
      name: 'supabase',
      transport: 'http',
      host: 'mcp.supabase.com',
      local: false,
      hasCredentialFields: true,
      enabled: true,
    },
  ],
  sources: [{ source: 'claude_code', outcome: 'read', count: 1 }],
  truncated: false,
};

describe('sync adapter work-app detection', () => {
  it('calls detect_work_apps with no arguments and returns its answer', async () => {
    const { adapter, calls } = adapterWith(() => FOUND);
    const found = await adapter.shell.detectWorkApps!();
    expect(calls).toEqual([{ cmd: 'detect_work_apps', args: undefined }]);
    expect(found).toEqual({ ok: true, value: FOUND });
  });

  it('a host without the command answers as a failure, not a throw', async () => {
    const { adapter } = adapterWith(() => new Error('command detect_work_apps not found'));
    const found = await adapter.shell.detectWorkApps!();
    expect(found.ok).toBe(false);
  });
});
