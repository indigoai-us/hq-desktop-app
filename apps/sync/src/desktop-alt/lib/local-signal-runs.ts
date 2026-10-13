import { invoke } from '@tauri-apps/api/core';

/**
 * signals-local-meetings-v1 US-002 — typed client for the desktop-native local
 * signal run contract (`src-tauri/src/commands/local_signal_runs.rs`).
 * Every call after `request` is keyed by job ID, and session-owned calls also
 * carry the provider session ID that claimed the run.
 */

export type RunState =
  | 'pending'
  | 'claimed'
  | 'extracting'
  | 'writing'
  | 'uploading'
  | 'complete'
  | 'cancelled'
  | 'failed';
export type Provider = 'claude' | 'codex';
export type ProviderChoice = Provider | 'any';

export interface RunRequestInput {
  companyUid: string;
  memberUid: string;
  sourceRef: string;
  sourceDigest: string;
  audienceReceiptRef: string;
  provider: ProviderChoice;
  promptVersion: string;
  schemaVersion: string;
}

export interface RunRecord {
  request: RunRequestInput & { schema: 'hq-local-signal-run/v1'; jobId: string; dedupeKey: string; createdAt: string };
  state: RunState;
  status: string;
  history: { state: RunState; at: string }[];
  updatedAt: string;
  claimedBy: Provider | null;
  providerSessionId: string | null;
  ownerPid: number | null;
  parsedResultDigest: string | null;
  activations: number;
}

export interface ProviderSession {
  provider: Provider;
  sessionId: string;
  interactive: boolean;
}

/**
 * The Meetings "Generate signals" button. One call per activation: the backend
 * reuses the job when the source digest and versions are unchanged, then hands
 * it to an open interactive session or leaves it pending.
 */
export async function generateSignals(
  accountId: string,
  input: RunRequestInput,
  sessions: ProviderSession[],
): Promise<RunRecord> {
  const rec = await invoke<RunRecord>('local_signal_run_request', { accountId, input });
  return invoke<RunRecord>('local_signal_run_dispatch', { accountId, jobId: rec.request.jobId, sessions });
}

export function cancelSignalRun(accountId: string, jobId: string): Promise<RunRecord> {
  return invoke<RunRecord>('local_signal_run_cancel', { accountId, jobId, sessionId: null });
}

export function getSignalRun(accountId: string, jobId: string): Promise<RunRecord> {
  return invoke<RunRecord>('local_signal_run_get', { accountId, jobId });
}

export function listSignalRuns(accountId: string): Promise<RunRecord[]> {
  return invoke<RunRecord[]>('local_signal_run_list', { accountId });
}
