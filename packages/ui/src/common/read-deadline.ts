/**
 * Shared bound for page reads (BLANK-1). A read that has not settled by the
 * deadline rejects with ReadDeadlineError, so the page leaves its loading
 * placeholder for its failed-read state (plain copy plus Try again) instead of
 * loading forever. A late answer is ignored.
 */
export const READ_DEADLINE_MS = 12_000;

export class ReadDeadlineError extends Error {
  constructor(label = "read") {
    super(`${label} did not answer within ${READ_DEADLINE_MS / 1000}s`);
    this.name = "ReadDeadlineError";
  }
}

export function withReadDeadline<T>(
  request: PromiseLike<T>,
  label = "read",
  timeoutMs = READ_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ReadDeadlineError(label));
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
