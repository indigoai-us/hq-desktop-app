import { describe, expect, it, vi } from 'vitest';
import {
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
  createFirstLaunchSignInReachReporter,
  normalizeFirstLaunchSignInReachOutcome,
  startupOutcomeForLifecycle,
  type FirstLaunchSignInReachEvent,
} from './first-launch-signin-reach-telemetry';

const INSTALL_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

describe('first-launch sign-in reach telemetry', () => {
  it('accepts only the closed outcome set', () => {
    for (const outcome of FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES) {
      expect(normalizeFirstLaunchSignInReachOutcome(outcome)).toBe(outcome);
    }
    expect(normalizeFirstLaunchSignInReachOutcome('free-form error text')).toBeUndefined();
    expect(normalizeFirstLaunchSignInReachOutcome(null)).toBeUndefined();
  });

  it('does not query the flag or emit when CI suppression is set', async () => {
    const isEnabled = vi.fn(async () => true);
    const emit = vi.fn(async (_event: FirstLaunchSignInReachEvent) => {});
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isSuppressed: async () => true,
      isEnabled,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      emit,
    });

    reporter.record('quit');
    await reporter.prepare();

    expect(isEnabled).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('classifies authenticated resume and recovery states before the generic session skip', () => {
    expect(startupOutcomeForLifecycle('InstallResume', null, true)).toBe('setup-resume-skip');
    expect(startupOutcomeForLifecycle('InstalledFirstRun', null, true)).toBe('consent-only-skip');
    expect(startupOutcomeForLifecycle('NeedsInstall', {
      installCompleted: true,
      firstRunCompleted: false,
      installInProgress: false,
      manifestIncomplete: false,
      hadMachineId: true,
      hqRootValid: false,
    }, true)).toBe('missing-root-recovery-skip');
    expect(startupOutcomeForLifecycle('SteadyState', null, true)).toBe('existing-session-skip');
    expect(startupOutcomeForLifecycle('NeedsAuthForInstall', null, false)).toBeUndefined();
  });

  it('emits the reached-signin outcome once with the existing install attempt key', async () => {
    const emit = vi.fn(async (_event: FirstLaunchSignInReachEvent) => {});
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => true,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      emit,
    });

    reporter.record('reached-signin');
    reporter.record('quit');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));

    expect(emit).toHaveBeenCalledWith({
      eventName: 'desktop_onboarding_step',
      sessionId: INSTALL_ATTEMPT_ID,
      properties: {
        step: 'welcome-signin',
        action: 'entered',
        flow: 'first_launch',
        outcome: 'reached-signin',
      },
    });
  });

  it('emits one scope-limited skipped outcome with the install attempt key', async () => {
    const emit = vi.fn(async (_event: FirstLaunchSignInReachEvent) => {});
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => true,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      emit,
    });

    reporter.record('startup-error');
    reporter.record('quit');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));

    expect(emit).toHaveBeenCalledWith({
      eventName: 'desktop_onboarding_step',
      sessionId: INSTALL_ATTEMPT_ID,
      properties: {
        step: 'welcome-signin',
        action: 'skipped',
        flow: 'first_launch',
        outcome: 'startup-error',
      },
    });
  });

  it('fails closed when the first-run flag is off or the attempt key is missing', async () => {
    const emit = vi.fn(async (_event: FirstLaunchSignInReachEvent) => {});
    const flagOff = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => false,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      emit,
    });
    flagOff.record('update-gate');
    await flagOff.prepare();

    const noAttemptKey = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => true,
      getInstallAttemptId: async () => null,
      emit,
    });
    noAttemptKey.record('window-closed');
    await noAttemptKey.prepare();

    expect(emit).not.toHaveBeenCalled();
  });
});
