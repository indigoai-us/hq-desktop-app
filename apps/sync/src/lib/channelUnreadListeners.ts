type Unlisten = () => void;

export type ListenPayload = (
  eventName: string,
  handler: (payload: unknown) => void,
) => Promise<Unlisten>;

type ChannelUnreadUpdate = { channelId: string; unread: number };
type ApplyChannelUnread = (channelId: string, unread: number) => void;

type ChannelUnreadListenerDeps = {
  listen: ListenPayload;
  applyChannelUnread: ApplyChannelUnread;
  refreshSnapshot: () => void;
};

function parseChannelUnreadUpdate(payload: unknown): ChannelUnreadUpdate | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const channelId = record.channelId;
  const unread = record.unread;
  if (
    typeof channelId !== 'string' ||
    channelId.trim().length === 0 ||
    typeof unread !== 'number' ||
    !Number.isSafeInteger(unread) ||
    unread < 0
  ) {
    return null;
  }

  return { channelId, unread };
}

/**
 * Register the two events that can update the channel unread badge. A
 * channel:unread-changed event with no channel fields is an invalidation wake
 * from the directory-change path, so refresh the complete snapshot instead of
 * dropping it and leaving the aggregate badge stale. Malformed updates use the
 * same recovery path.
 */
export async function registerChannelUnreadListeners({
  listen,
  applyChannelUnread,
  refreshSnapshot,
}: ChannelUnreadListenerDeps): Promise<Unlisten[]> {
  const unreadChanged = await listen('channel:unread-changed', (payload) => {
    const update = parseChannelUnreadUpdate(payload);
    if (update === null) {
      refreshSnapshot();
      return;
    }
    applyChannelUnread(update.channelId, update.unread);
  });

  const channelUpdated = await listen('channel:updated', (payload) => {
    const update = parseChannelUnreadUpdate(payload);
    if (update === null) {
      refreshSnapshot();
      return;
    }
    applyChannelUnread(update.channelId, update.unread);
  });

  return [unreadChanged, channelUpdated];
}
