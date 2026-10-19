import * as Sentry from '@sentry/svelte';
import { setLazyLoadFailureReporter } from '@hq/ui/lazy-load-report';

/**
 * Sends a lazy chunk that still failed after its retries to Sentry, the same
 * way GlobalErrorBoundary reports a UI crash: a scoped capture tagged with
 * the window and grouped by the surface that failed.
 */
export function installLazyLoadSentryReporter(windowLabel: string): void {
  setLazyLoadFailureReporter((surface, error) => {
    Sentry.withScope((scope) => {
      scope.setTag('window_label', windowLabel);
      scope.setTag('lazy_door', surface);
      scope.setFingerprint(['lazy-door', surface, windowLabel]);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
