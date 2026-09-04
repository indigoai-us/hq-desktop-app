/**
 * First-paint request bound. Directory, contacts, and DM-thread reads must
 * not hold the conversation pane on a skeleton forever — a missing endpoint
 * (404) or a hung native invoke degrades to an empty/#setup state instead.
 */

export const DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS = 8_000;

/** Extra wait after the sidebar boot bound before the conversation pane
 *  gives up on selection and paints an error instead of a skeleton. */
export const CONVERSATION_BOOT_GRACE_MS = 2_000;

export class BootTimeoutError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = "BootTimeoutError";
    this.label = label;
  }
}

/** Resolve/reject with `promise`, or reject with BootTimeoutError after `ms`. */
export function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BootTimeoutError(label));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
