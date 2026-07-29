export class RecordingActionTimeoutError extends Error {
  constructor(windowId: string, timeoutMs: number) {
    super(
      `Recording did not confirm for ${windowId} within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
    );
    this.name = 'RecordingActionTimeoutError';
  }
}

interface PendingRecordingAction {
  completion: Promise<unknown>;
  resolveStarted: () => void;
  rejectLifecycle: (reason: Error) => void;
}

interface RecordingActionAckOptions {
  timeoutMs?: number;
}

const DEFAULT_RECORDING_ACK_TIMEOUT_MS = 45_000;

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : String(reason));
}

/**
 * Correlates a recording command with the authoritative Recall lifecycle
 * event. The semantic operation stays keyed by window after an individual
 * caller times out, so a Retry can only await the original start rather than
 * dispatching a duplicate recording.
 */
export class RecordingActionAckCoordinator {
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRecordingAction>();

  constructor(options: RecordingActionAckOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RECORDING_ACK_TIMEOUT_MS;
  }

  start<T>(windowId: string, dispatch: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(windowId);
    if (existing) {
      return this.withCallerTimeout(windowId, existing.completion as Promise<T>);
    }

    let resolveStarted!: () => void;
    let rejectLifecycle!: (reason: Error) => void;
    const lifecycle = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectLifecycle = reject;
    });
    const dispatched = Promise.resolve().then(dispatch);
    const completion = Promise.all([dispatched, lifecycle]).then(
      ([result]) => result,
    );
    const operation: PendingRecordingAction = {
      completion,
      resolveStarted,
      rejectLifecycle,
    };
    this.pending.set(windowId, operation);

    // Keep cleanup attached to the shared operation itself. A timed-out caller
    // no longer observes this promise, but a later lifecycle event must still
    // clean up the semantic key without producing an unhandled rejection.
    void completion.then(
      () => this.removeIfCurrent(windowId, operation),
      () => this.removeIfCurrent(windowId, operation),
    );

    return this.withCallerTimeout(windowId, completion);
  }

  started(windowId: string): boolean {
    const operation = this.pending.get(windowId);
    if (!operation) return false;
    operation.resolveStarted();
    return true;
  }

  failed(windowId: string, reason: unknown): boolean {
    const operation = this.pending.get(windowId);
    if (!operation) return false;
    operation.rejectLifecycle(asError(reason));
    return true;
  }

  hasPending(windowId: string): boolean {
    return this.pending.has(windowId);
  }

  dispose(reason: unknown = 'Recording action coordinator disposed'): void {
    const error = asError(reason);
    for (const operation of this.pending.values()) {
      operation.rejectLifecycle(error);
    }
    this.pending.clear();
  }

  private removeIfCurrent(
    windowId: string,
    operation: PendingRecordingAction,
  ): void {
    if (this.pending.get(windowId) === operation) {
      this.pending.delete(windowId);
    }
  }

  private withCallerTimeout<T>(
    windowId: string,
    completion: Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RecordingActionTimeoutError(windowId, this.timeoutMs));
      }, this.timeoutMs);
      completion.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
