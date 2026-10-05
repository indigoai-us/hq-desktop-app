import { describe, expect, it, vi } from 'vitest';
import {
  FIRST_LAUNCH_SIGNIN_REACH_FLAG,
} from '@hq/platform';
import {
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
  createFirstLaunchSignInReachReporter,
  normalizeFirstLaunchSignInReachOutcome,
  resolveFirstLaunchSignInReachFlag,
  startupOutcomeForLifecycle,
  type PublicFlagFetch,
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

  it('resolves the public hq-flags key with the install attempt as visitor ID', async () => {
    const fetchPublic = vi.fn<PublicFlagFetch>(async () => ({
      ok: true,
      json: async () => ({ key: FIRST_LAUNCH_SIGNIN_REACH_FLAG, enabled: true }),
    }));

    await expect(resolveFirstLaunchSignInReachFlag(INSTALL_ATTEMPT_ID, fetchPublic)).resolves.toBe(true);
    const [request, init] = fetchPublic.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe('https://hqapi.hq.computer/v1/flags/resolve-public');
    expect(url.searchParams.get('key')).toBe(FIRST_LAUNCH_SIGNIN_REACH_FLAG);
    expect(url.searchParams.get('visitorId')).toBe(INSTALL_ATTEMPT_ID);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(JSON.stringify(init)).not.toContain('Authorization');
  });

  it('fails closed for a non-public, unreadable, or invalid visitor flag result', async () => {
    const nonPublic = vi.fn<PublicFlagFetch>(async () => ({
      ok: true,
      json: async () => ({ key: FIRST_LAUNCH_SIGNIN_REACH_FLAG, enabled: false }),
    }));
    const error = vi.fn<PublicFlagFetch>(async () => ({ ok: false, json: async () => ({}) }));
    const invalidVisitor = vi.fn<PublicFlagFetch>();

    await expect(resolveFirstLaunchSignInReachFlag(INSTALL_ATTEMPT_ID, nonPublic)).resolves.toBe(false);
    await expect(resolveFirstLaunchSignInReachFlag(INSTALL_ATTEMPT_ID, error)).resolves.toBe(false);
    await expect(resolveFirstLaunchSignInReachFlag('not-an-install-id', invalidVisitor)).resolves.toBe(false);
    expect(invalidVisitor).not.toHaveBeenCalled();
  });

  it('does not query the flag or send when CI suppression is set', async () => {
    const isEnabled = vi.fn(async () => true);
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
      isEnabled,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage },
    });

    reporter.record('quit');
    await reporter.prepare();

    expect(isEnabled).not.toHaveBeenCalled();
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
    const isEnabled = vi.fn(async (visitorId: string) => visitorId === INSTALL_ATTEMPT_ID);
    const reporter = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage: memoryStorage(), now: () => 123 },
    });

    reporter.record('reached-signin');
    reporter.record('quit');
    await vi.waitFor(() => expect(sendAnonymousStep).toHaveBeenCalledTimes(1));

    expect(isEnabled).toHaveBeenCalledWith(INSTALL_ATTEMPT_ID);
    expect(sendAnonymousStep).toHaveBeenCalledWith({
      installAttemptId: INSTALL_ATTEMPT_ID,
      outcome: 'reached-signin',
      recordedAt: 123,
    });
  });

  it('fails closed when the flag is off or the install attempt key is missing', async () => {
    const sendAnonymousStep = vi.fn(async () => true);
    const flagOff = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => false,
      getInstallAttemptId: async () => INSTALL_ATTEMPT_ID,
      sendAnonymousStep,
      queue: { storage: memoryStorage() },
    });
    flagOff.record('update-gate');
    await flagOff.prepare();

    const noAttemptKey = createFirstLaunchSignInReachReporter({
      isFirstRun: async () => true,
      isEnabled: async () => true,
      getInstallAttemptId: async () => null,
      sendAnonymousStep,
      queue: { storage: memoryStorage() },
    });
    noAttemptKey.record('window-closed');
    await noAttemptKey.prepare();

    expect(sendAnonymousStep).not.toHaveBeenCalled();
  });
});
