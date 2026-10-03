export const DESKTOP_STARTUP_DIAGNOSTIC_TAG = 'boot-startup';
export const MAX_DESKTOP_STARTUP_ELAPSED_MS = 999_999;

export const DESKTOP_STARTUP_EVENTS = [
  'entry-started',
  'dynamic-import-started',
  'dynamic-import-completed',
  'mount-started',
  'mount-completed',
  'boot-failed',
  'global-error',
  'unhandled-rejection',
  'boundary-error',
] as const;

export type DesktopStartupEvent = (typeof DESKTOP_STARTUP_EVENTS)[number];

type FrontendLogInvoke = (
  command: 'frontend_log',
  args: { tag: string; message: string },
) => Promise<unknown>;

type StartupEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export function boundedStartupElapsedMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_DESKTOP_STARTUP_ELAPSED_MS, Math.max(0, Math.round(value)));
}

export function formatDesktopStartupDiagnostic(
  event: DesktopStartupEvent,
  elapsedMs: number,
): string {
  return `event=${event} elapsed_ms=${boundedStartupElapsedMs(elapsedMs)}`;
}

/**
 * Fixed-label, startup-only diagnostics. Every category is emitted at most
 * once, listeners never cancel browser behavior, and no Error value crosses
 * the logging boundary.
 */
export function createDesktopStartupDiagnostics(
  invokeFrontendLog: FrontendLogInvoke,
  now: () => number = () => performance.now(),
) {
  const startedAt = now();
  const emitted = new Set<DesktopStartupEvent>();
  let removeGlobalListeners: (() => void) | null = null;

  function emit(event: DesktopStartupEvent): boolean {
    if (emitted.has(event)) return false;
    emitted.add(event);
    const args = {
      tag: DESKTOP_STARTUP_DIAGNOSTIC_TAG,
      message: formatDesktopStartupDiagnostic(event, now() - startedAt),
    };
    try {
      void invokeFrontendLog('frontend_log', args).catch(() => undefined);
    } catch {
      // Diagnostics are best-effort and must never alter startup propagation.
    }
    return true;
  }

  function installGlobalErrorListeners(target: StartupEventTarget): () => void {
    if (removeGlobalListeners) return removeGlobalListeners;
    const onError = () => {
      emit('global-error');
    };
    const onUnhandledRejection = () => {
      emit('unhandled-rejection');
    };
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onUnhandledRejection);
    removeGlobalListeners = () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onUnhandledRejection);
      removeGlobalListeners = null;
    };
    return removeGlobalListeners;
  }

  return { emit, installGlobalErrorListeners };
}
