import { describe, expect, it, vi } from 'vitest';
import {
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
  createFirstLaunchSignInReachReporter,
  normalizeFirstLaunchSignInReachOutcome,
  startupOutcomeForLifecycle,
} from './first-launch-signin-reach-telemetry';

const INSTALL_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe('first-launch sign-in reach telemetry', () => {
  it('accepts only the closed outcome set', () => {
    for (const outcome of FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES) {
      expect(normalizeFirstLaunchSignInReachOutcome(outcome)).toBe(outcome);
    }
    expect(normalizeFirstLaunchSignInReachOutcome('free-form error text')).toBeUndefined();
    expect(normalizeFirstLaunchSignInReachOutcome(null)).toBeUndefined();
  });

  it('does not send when CI suppression is set', async () => {
    const sendAnonymousStep = vi.fn(async () => true);
    const storage = memoryStorage();
    storage.setItem('hq:first-launch-signin-reach:v1', JSON.stringify({
      version: 1,
      entries: [{
        installAttemptId: INSTALL_ATTEMPT_ID,
        outcome: 'quit',
        recordedAt: Date.now(),
      }],
    }));
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isSuppressed: async () => true,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage },
    });

    reporter.record('quit');
    await reporter.prepare();

    expect(sendAnonymousStep).not.toHaveBeenCalled();
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

  it('sends one bounded result through the anonymous step path using only the install attempt key', async () => {
    const sendAnonymousStep = vi.fn(async () => true);
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage: memoryStorage(), now: () => 123 },
    });

    reporter.record('reached-signin');
    reporter.record('quit');
    await vi.waitFor(() => expect(sendAnonymousStep).toHaveBeenCalledTimes(1));

    expect(sendAnonymousStep).toHaveBeenCalledWith({
      installAttemptId: INSTALL_ATTEMPT_ID,
      outcome: 'reached-signin',
      recordedAt: 123,
    });
  });

  it('sends the bounded result for an eligible first launch without a feature-flag resolver', async () => {
    const sendAnonymousStep = vi.fn(async () => true);
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage: memoryStorage(), now: () => 456 },
    });

    reporter.record('reached-signin');
    await vi.waitFor(() => expect(sendAnonymousStep).toHaveBeenCalledTimes(1));

    expect(sendAnonymousStep).toHaveBeenCalledWith({
      installAttemptId: INSTALL_ATTEMPT_ID,
      outcome: 'reached-signin',
      recordedAt: 456,
    });
  });

  it('does not send when the install attempt key is missing', async () => {
    const sendAnonymousStep = vi.fn(async () => true);
    const noAttemptKey = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      getInstallAttemptId: async () => null,
      sendAnonymousStep,
      queue: { storage: memoryStorage() },
    });
    noAttemptKey.record('window-closed');
    await noAttemptKey.prepare();

    expect(sendAnonymousStep).not.toHaveBeenCalled();
  });
});
