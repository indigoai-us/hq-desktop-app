import type { PlatformAdapter } from '@hq/platform';

/** Route tray Sync Now through the native adapter's flag delivery preflight. */
export async function startTraySync(
  adapter: Pick<PlatformAdapter, 'sync'>,
): Promise<void> {
  const started = await adapter.sync.startSync();
  if (!started.ok) throw new Error(started.message);
}

/** How the tray treats a failed Sync Now start. */
export type TraySyncFailure = 'already-running' | 'sync-off' | 'error';

/**
 * Classify a failed tray Sync Now (an All-scope run). "Turn off all cloud
 * sync" is the only switch that refuses an All-scope run (off vaults are
 * skipped by the runner instead), so a refusal is recognised from the saved
 * switch, read back from the host, not from the wording of the message
 * (US-016). That is the person's own choice and the tray stays idle.
 */
export async function classifyTraySyncFailure(
  message: string,
  readCloudEnabled: () => Promise<boolean>,
): Promise<TraySyncFailure> {
  // A sync already holds the runner singleton (the watch daemon or a prior run).
  if (message.toLowerCase().includes('already running')) return 'already-running';
  let cloudEnabled = true;
  try {
    cloudEnabled = (await readCloudEnabled()) !== false;
  } catch {
    cloudEnabled = true;
  }
  return cloudEnabled ? 'error' : 'sync-off';
}
