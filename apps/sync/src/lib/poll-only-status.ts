export type RealtimeMode = 'poll-only' | 'realtime';
export type SyncDisplayState = 'idle' | 'syncing' | 'poll-only';

export function afterFanoutPlan(
  realtimeMode: RealtimeMode | null,
  transferActive: boolean,
): SyncDisplayState {
  return realtimeMode === 'poll-only' && !transferActive ? 'poll-only' : 'syncing';
}

export function afterSyncComplete(realtimeMode: RealtimeMode | null): SyncDisplayState {
  return realtimeMode === 'poll-only' ? 'poll-only' : 'idle';
}

export function formatPollOnlyStatus(
  lastSyncAt: string | null | undefined,
  minPollMs = 60_000,
  maxPollMs = 600_000,
  now = Date.now(),
): string {
  const minMinutes = Math.max(1, Math.ceil(minPollMs / 60_000));
  const maxMinutes = Math.max(minMinutes, Math.ceil(maxPollMs / 60_000));
  const cadence = minMinutes === maxMinutes
    ? `${minMinutes} min`
    : `${minMinutes} to ${maxMinutes} min`;
  const timestamp = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
  const completed = Number.isFinite(timestamp)
    ? `Synced ${Math.max(0, Math.floor((now - timestamp) / 60_000))} min ago`
    : 'No completed sync yet';
  return `${completed}. Live updates are off. HQ checks every ${cadence}.`;
}
