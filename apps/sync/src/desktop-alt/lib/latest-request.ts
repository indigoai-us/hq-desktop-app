/**
 * Predicate handed to one refresh generation. Async work must check it before
 * applying either success or failure state.
 */
export type LatestRequestCheck = () => boolean;

/**
 * Coordinates overlapping refreshes without cancelling their IPC calls.
 *
 * Every run receives a monotonic generation. Only the newest generation may
 * apply results or clear the active state; older work can settle harmlessly.
 */
export class LatestRequestCoordinator {
  private latestRequestId = 0;

  async run(
    task: (isLatest: LatestRequestCheck) => Promise<void>,
    onActiveChange: (active: boolean) => void,
  ): Promise<void> {
    const requestId = ++this.latestRequestId;
    const isLatest = () => requestId === this.latestRequestId;
    onActiveChange(true);

    try {
      await task(isLatest);
    } finally {
      if (isLatest()) onActiveChange(false);
    }
  }
}
