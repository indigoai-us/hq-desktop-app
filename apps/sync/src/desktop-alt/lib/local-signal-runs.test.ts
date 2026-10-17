import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { cancelSignalRun, generateSignals, type RunRequestInput } from './local-signal-runs';

const input: RunRequestInput = {
  companyUid: 'cmp_1',
  memberUid: 'prs_1',
  sourceRef: 'sources/meetings/m1.md',
  sourceDigest: 'd1',
  audienceReceiptRef: 'receipts/a1.json',
  provider: 'any',
  promptVersion: 'p1',
  schemaVersion: 's1',
};

describe('local signal run client', () => {
  beforeEach(() => invoke.mockReset());

  it('submits one request per activation and dispatches the returned job ID', async () => {
    invoke
      .mockResolvedValueOnce({ request: { jobId: 'job-1' }, state: 'pending' })
      .mockResolvedValueOnce({ request: { jobId: 'job-1' }, state: 'pending' });
    const rec = await generateSignals('acct', input, []);
    expect(invoke).toHaveBeenNthCalledWith(1, 'local_signal_run_request', { accountId: 'acct', input });
    expect(invoke).toHaveBeenNthCalledWith(2, 'local_signal_run_dispatch', {
      accountId: 'acct',
      jobId: 'job-1',
      sessions: [],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(rec.state).toBe('pending');
  });

  it('cancels from the UI by job ID without a session ID', async () => {
    invoke.mockResolvedValueOnce({ state: 'cancelled' });
    await cancelSignalRun('acct', 'job-1');
    expect(invoke).toHaveBeenCalledWith('local_signal_run_cancel', { accountId: 'acct', jobId: 'job-1', sessionId: null });
  });
});
