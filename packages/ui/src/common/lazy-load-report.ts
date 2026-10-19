/**
 * Reports a lazy chunk that still failed to load after its retries.
 *
 * packages/ui has no Sentry dependency. The app installs a reporter at boot
 * (apps/sync main.ts and desktop-alt/main.ts) that sends the failure to
 * Sentry the same way GlobalErrorBoundary reports a UI crash. Without a
 * reporter the failure is only logged.
 *
 * Each surface is reported once per page load. A caller that keeps trying
 * (the first-run import step retries every few seconds) logs every failure
 * but sends one event.
 */
export type LazyLoadFailureReporter = (surface: string, error: unknown) => void;

let reporter: LazyLoadFailureReporter | null = null;
const reported = new Set<string>();

export function setLazyLoadFailureReporter(next: LazyLoadFailureReporter | null): void {
  reporter = next;
  reported.clear();
}

export function reportLazyLoadFailure(surface: string, error: unknown): void {
  console.error("[lazy-door] load failed", surface, error);
  if (reported.has(surface)) return;
  reported.add(surface);
  try {
    reporter?.(surface, error);
  } catch (err) {
    console.warn("[lazy-door] failure reporter threw", err);
  }
}
