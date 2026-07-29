export interface ChannelUnreadLike {
  channelId: string;
  unread?: number | null;
}

/**
 * Orders authoritative channel snapshots against realtime unread events.
 *
 * A newer snapshot supersedes an older one. Realtime events that land while the
 * latest snapshot is in flight are overlaid at commit, preserving their newer
 * per-channel counts while still completing the aggregate with every channel
 * returned by the list.
 */
export class ChannelUnreadTracker {
  private snapshotGeneration = 0;
  private eventRevision = 0;
  private readonly snapshotBaselines = new Map<number, number>();
  private readonly eventRevisions = new Map<string, number>();
  private counts = new Map<string, number>();
  private completeSnapshot = false;

  beginSnapshot(): number {
    this.snapshotGeneration += 1;
    this.snapshotBaselines.set(
      this.snapshotGeneration,
      this.eventRevision,
    );
    return this.snapshotGeneration;
  }

  abandonSnapshot(token: number): void {
    this.snapshotBaselines.delete(token);
  }

  commitSnapshot(
    token: number,
    channels: readonly ChannelUnreadLike[],
  ): number | null {
    const baseline = this.snapshotBaselines.get(token);
    this.snapshotBaselines.delete(token);
    if (token !== this.snapshotGeneration || baseline === undefined) return null;
    const next = new Map(
      channels.map((channel) => [
        channel.channelId,
        normalizeUnread(channel.unread),
      ]),
    );
    for (const [channelId, revision] of this.eventRevisions) {
      if (revision > baseline) {
        next.set(channelId, this.counts.get(channelId) ?? 0);
      }
    }
    this.counts = next;
    this.completeSnapshot = true;
    return this.total();
  }

  applyEvent(channelId: string, unread: number): number {
    this.eventRevision += 1;
    this.eventRevisions.set(channelId, this.eventRevision);
    this.counts.set(channelId, normalizeUnread(unread));
    return this.total();
  }

  hasCompleteSnapshot(): boolean {
    return this.completeSnapshot;
  }

  get(channelId: string): number {
    return this.counts.get(channelId) ?? 0;
  }

  total(): number {
    return [...this.counts.values()].reduce((sum, unread) => sum + unread, 0);
  }
}

function normalizeUnread(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}
