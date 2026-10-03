export interface WatcherStatusPayload {
  state: string;
  holderCommand?: string;
}

export function watcherLockNoticeFromStatus(
  status: WatcherStatusPayload,
): string | null {
  if (status.state !== 'waiting-for-lock') return null;
  const holder = status.holderCommand?.trim();
  return holder
    ? `Waiting for another sync (${holder})`
    : 'Waiting for another sync';
}
