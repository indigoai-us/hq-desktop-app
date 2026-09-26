import type { PlatformAdapter } from '@hq/platform';

/** Route tray Sync Now through the native adapter's flag delivery preflight. */
export async function startTraySync(
  adapter: Pick<PlatformAdapter, 'sync'>,
): Promise<void> {
  const started = await adapter.sync.startSync();
  if (!started.ok) throw new Error(started.message);
}
