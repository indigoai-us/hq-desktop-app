/** Maximum time a company Activity refresh may hold the UI in a loading state. */
export const ACTIVITY_REQUEST_TIMEOUT_MS = 12_000;

export class ActivityRequestTimeoutError extends Error {
  constructor() {
    super("Activity request timed out");
    this.name = "ActivityRequestTimeoutError";
  }
}

/**
 * Resolve or reject with the underlying request, but always settle by the
 * deadline. Late native responses are safely ignored by this projection.
 */
export function withActivityRequestDeadline<T>(
  request: PromiseLike<T>,
  timeoutMs = ACTIVITY_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ActivityRequestTimeoutError());
    }, timeoutMs);

    void Promise.resolve(request).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
