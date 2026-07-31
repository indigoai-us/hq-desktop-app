export interface UnreadSummaryCounts {
  unreadDms: number;
  pendingRequests: number;
}

interface UnreadSummarySnapshot {
  authGeneration: number;
  snapshotGeneration: number;
  dmRevision: number;
  requestRevision: number;
}

/**
 * Orders authoritative unread-summary snapshots against auth transitions and
 * realtime DM/request events.
 *
 * Snapshots are still useful for reconciliation, but each field may commit
 * only when no newer event changed that field after the request began. An auth
 * reset invalidates every outstanding token, and overlapping requests use
 * latest-started-wins ordering.
 */
export class UnreadSummaryTracker {
  private authGeneration = 0;
  private snapshotGeneration = 0;
  private dmRevision = 0;
  private requestRevision = 0;

  beginSnapshot(): UnreadSummarySnapshot {
    this.snapshotGeneration += 1;
    return {
      authGeneration: this.authGeneration,
      snapshotGeneration: this.snapshotGeneration,
      dmRevision: this.dmRevision,
      requestRevision: this.requestRevision,
    };
  }

  commitSnapshot(
    snapshot: UnreadSummarySnapshot,
    incoming: UnreadSummaryCounts,
    current: UnreadSummaryCounts,
  ): UnreadSummaryCounts | null {
    if (
      snapshot.authGeneration !== this.authGeneration ||
      snapshot.snapshotGeneration !== this.snapshotGeneration
    ) {
      return null;
    }

    return {
      unreadDms:
        snapshot.dmRevision === this.dmRevision
          ? normalizeCount(incoming.unreadDms)
          : normalizeCount(current.unreadDms),
      pendingRequests:
        snapshot.requestRevision === this.requestRevision
          ? normalizeCount(incoming.pendingRequests)
          : normalizeCount(current.pendingRequests),
    };
  }

  noteDmEvent(): void {
    this.dmRevision += 1;
  }

  noteRequestEvent(): void {
    this.requestRevision += 1;
  }

  captureAuthEpoch(): number {
    return this.authGeneration;
  }

  isAuthEpochCurrent(epoch: number): boolean {
    return epoch === this.authGeneration;
  }

  reset(): void {
    this.authGeneration += 1;
    this.snapshotGeneration += 1;
    this.dmRevision = 0;
    this.requestRevision = 0;
  }
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
