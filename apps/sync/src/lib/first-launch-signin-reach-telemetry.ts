import type { StartupSetupEvidence } from './unexpected-startup-surface';
import { isMissingRootRecovery } from './onboarding-wizard';
import { pingInstallerStep } from './installer-step-telemetry';
import {
  createFirstLaunchSignInReachQueue,
  normalizeFirstLaunchSignInReachOutcome,
  type FirstLaunchSignInReachOutcome,
  type FirstLaunchSignInReachQueueOptions,
} from './first-launch-signin-reach-queue';

export {
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
  normalizeFirstLaunchSignInReachOutcome,
} from './first-launch-signin-reach-queue';
export type { FirstLaunchSignInReachOutcome } from './first-launch-signin-reach-queue';

const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function startupOutcomeForLifecycle(
  lifecycleState: string | null,
  setupEvidence: StartupSetupEvidence | null,
  authenticated: boolean,
): FirstLaunchSignInReachOutcome | undefined {
  if (!authenticated) return undefined;
  if (isMissingRootRecovery(lifecycleState ?? '', setupEvidence)) {
    return 'missing-root-recovery-skip';
  }
  if (lifecycleState === 'InstallResume') return 'setup-resume-skip';
  if (lifecycleState === 'InstalledFirstRun') return 'consent-only-skip';
  return 'existing-session-skip';
}

export interface FirstLaunchSignInReachReporterOptions {
  isFirstRun: () => Promise<boolean>;
  isSuppressed?: () => Promise<boolean>;
  getInstallAttemptId: () => Promise<string | null>;
  queue?: Pick<FirstLaunchSignInReachQueueOptions, 'storage' | 'now' | 'warn'>;
  sendAnonymousStep?: FirstLaunchSignInReachQueueOptions['send'];
  warn?: (message: string, error?: unknown) => void;
}

/**
 * Pre-auth reach results use the existing anonymous installer-step route.
 * The local queue retains bounded outcomes until the endpoint acknowledges them.
 */
export function createFirstLaunchSignInReachReporter(
  options: FirstLaunchSignInReachReporterOptions,
) {
  let outcomeClaimed = false;
  let ready: Promise<{ installAttemptId: string } | null> | null = null;
  const warn = options.warn ?? ((message, error) => console.warn(message, error));
  const queue = createFirstLaunchSignInReachQueue({
    storage: options.queue?.storage,
    now: options.queue?.now,
    warn,
    send: options.sendAnonymousStep ?? ((entry) => pingInstallerStep({
      installSessionId: entry.installAttemptId,
      step: `first-launch-signin-reach:${entry.outcome}`,
      now: () => entry.recordedAt,
      includeDeviceId: false,
    })),
  });

  function prepare(): Promise<{ installAttemptId: string } | null> {
    if (ready) return ready;
        // Earlier outcomes were recorded only for eligible first launches. Drain
        // them on ordinary launches.
    ready = (async () => {
      try {
        if (await options.isSuppressed?.()) return null;
        // Suppressed CI runs must not drain production-bound records either.
        void queue.flush();
        const firstRun = await options.isFirstRun();
        if (!firstRun) return null;
        const installAttemptId = await options.getInstallAttemptId();
        if (!installAttemptId || !INSTALL_ATTEMPT_ID_RE.test(installAttemptId)) return null;
        return { installAttemptId };
      } catch (error) {
        warn('first-launch sign-in reach telemetry unavailable; staying off', error);
        return null;
      }
    })();
    return ready;
  }

  function record(value: unknown): void {
    const outcome = normalizeFirstLaunchSignInReachOutcome(value);
    if (!outcome || outcomeClaimed) return;
    outcomeClaimed = true;
    void prepare()
      .then((context) => {
        if (context) return queue.enqueue(context.installAttemptId, outcome);
      })
      .catch((error) => warn('first-launch sign-in reach event failed', error));
  }

  return { prepare, record };
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
