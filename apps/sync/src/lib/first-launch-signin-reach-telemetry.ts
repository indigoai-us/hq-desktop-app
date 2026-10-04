import type { DesktopTelemetryProperties } from './desktop-telemetry';

export const FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES = [
  'reached-signin',
  'existing-session-skip',
  'setup-resume-skip',
  'missing-root-recovery-skip',
  'consent-only-skip',
  'update-gate',
  'startup-error',
  'window-closed',
  'quit',
] as const;

export type FirstLaunchSignInReachOutcome =
  (typeof FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES)[number];

export interface FirstLaunchSignInReachEvent {
  eventName: 'desktop_onboarding_step';
  sessionId: string;
  properties: DesktopTelemetryProperties;
}

export interface FirstLaunchSignInReachReporterOptions {
  isFirstRun: () => Promise<boolean>;
  isEnabled: () => Promise<boolean>;
  getInstallAttemptId: () => Promise<string | null>;
  emit: (event: FirstLaunchSignInReachEvent) => Promise<void>;
  warn?: (message: string, error?: unknown) => void;
}

const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeFirstLaunchSignInReachOutcome(
  value: unknown,
): FirstLaunchSignInReachOutcome | undefined {
  return typeof value === 'string' &&
    FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES.includes(value as FirstLaunchSignInReachOutcome)
    ? (value as FirstLaunchSignInReachOutcome)
    : undefined;
}

/**
 * Records one bounded pre-sign-in result for the current first-launch process.
 * An outcome is claimed before async lookups so racing close/update events can
 * never produce multiple rows. All lookups are injected and the caller keeps
 * this reporter scoped to one desktop process launch.
 */
export function createFirstLaunchSignInReachReporter(
  options: FirstLaunchSignInReachReporterOptions,
) {
  let outcomeClaimed = false;
  let ready: Promise<{ installAttemptId: string } | null> | null = null;

  function prepare(): Promise<{ installAttemptId: string } | null> {
    if (ready) return ready;
    ready = (async () => {
      try {
        const firstRun = await options.isFirstRun();
        if (!firstRun || !(await options.isEnabled())) return null;
        const installAttemptId = await options.getInstallAttemptId();
        if (!installAttemptId || !INSTALL_ATTEMPT_ID_RE.test(installAttemptId)) return null;
        return { installAttemptId };
      } catch (error) {
        options.warn?.('first-launch sign-in reach telemetry unavailable; staying off', error);
        return null;
      }
    })();
    return ready;
  }

  function markRecorded(): void {
    outcomeClaimed = true;
  }

  function wasRecorded(): boolean {
    return outcomeClaimed;
  }

  function record(value: unknown): void {
    const outcome = normalizeFirstLaunchSignInReachOutcome(value);
    if (!outcome || outcomeClaimed) return;
    outcomeClaimed = true;
    void prepare()
      .then((context) => {
        if (!context) return;
        return options.emit({
          eventName: 'desktop_onboarding_step',
          sessionId: context.installAttemptId,
          properties: {
            step: 'welcome-signin',
            action: outcome === 'reached-signin' ? 'entered' : 'skipped',
            flow: 'first_launch',
            outcome,
          },
        });
      })
      .catch((error) => {
        options.warn?.('first-launch sign-in reach event failed', error);
      });
  }

  return { prepare, record, markRecorded, wasRecorded };
}

let activeReporter: ReturnType<typeof createFirstLaunchSignInReachReporter> | null = null;

export function setFirstLaunchSignInReachReporter(
  reporter: ReturnType<typeof createFirstLaunchSignInReachReporter> | null,
): void {
  activeReporter = reporter;
}

export function recordFirstLaunchSignInReachOutcome(value: unknown): void {
  activeReporter?.record(value);
}

export function markFirstLaunchSignInReachRecorded(): void {
  activeReporter?.markRecorded();
}

export function firstLaunchSignInReachOutcomeWasRecorded(): boolean {
  return activeReporter?.wasRecorded() ?? false;
}
