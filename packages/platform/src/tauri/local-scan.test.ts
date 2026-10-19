/**
 * Visual first run: the Work shell's adapter maps the native launch scan
 * (counts and names only, no hq-cli) onto the host's `scan_local_sessions`.
 */
import { describe, expect, it } from 'vitest';

import type { LocalScanView } from '../adapter.js';
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

const SCAN: LocalScanView = {
  tools: [
    { tool: 'claude-code', sessions_total: 4, sessions_last_30d: 3, last_active_at: 1_700_000_000_000, share_last_30d: 1 },
    { tool: 'codex', sessions_total: 0, sessions_last_30d: 0, last_active_at: null, share_last_30d: 0 },
  ],
  projects: [{ tool: 'claude-code', name: 'site', sessions: 3, last_active_at: 1_700_000_000_000 }],
  repos: [{ path: '/Users/me/code/site', last_commit_at: 1_699_000_000_000 }],
  apps: ['Linear'],
  mcp_servers: ['github'],
  sources: [{ source: 'claude-code', outcome: 'read', count: 4 }],
  truncated: false,
  elapsed_ms: 41,
};

describe('sync adapter local scan', () => {
  it('runs the native scan through the host command, with no arguments', async () => {
    const { adapter, calls } = adapterWith((cmd) => (cmd === 'scan_local_sessions' ? SCAN : null));
    const result = await adapter.localScan!.scan();
    expect(calls).toEqual([{ cmd: 'scan_local_sessions', args: undefined }]);
    expect(result).toEqual({ ok: true, value: SCAN });
  });

  it('a host without the command answers as a failure, not a throw', async () => {
    const { adapter } = adapterWith(() => new Error('command scan_local_sessions not found'));
    const result = await adapter.localScan!.scan();
    expect(result.ok).toBe(false);
  });

  it('writes the import report through the host command and answers its path', async () => {
    const input = {
      sessions: { total: 4, claude: 4, codex: 0, cursor: 0, days_seen: 2, first_at: 1_699_000_000_000, last_at: 1_700_000_000_000 },
      tools: ['claude-code'],
      projects: ['site'],
      counts: { mcp_servers: 1 },
    };
    const rel = 'workspace/imports/2026-10-19T08-12-30/report.json';
    const { adapter, calls } = adapterWith((cmd) => (cmd === 'import_report_write' ? rel : null));
    const result = await adapter.importReport!.write(input);
    expect(calls).toEqual([{ cmd: 'import_report_write', args: { input } }]);
    expect(result).toEqual({ ok: true, value: rel });
  });

  it('reads the newest import report, or null', async () => {
    const report = { scan_id: 'desktop-2026-10-19T08-12-30', sessions: { total: 4 } };
    const { adapter, calls } = adapterWith((cmd) => (cmd === 'import_report_latest' ? report : null));
    expect(await adapter.importReport!.latest()).toEqual({ ok: true, value: report });
    expect(calls).toEqual([{ cmd: 'import_report_latest', args: undefined }]);
    const none = adapterWith(() => null);
    expect(await none.adapter.importReport!.latest()).toEqual({ ok: true, value: null });
  });
});
