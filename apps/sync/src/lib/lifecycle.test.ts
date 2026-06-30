import { describe, expect, it } from 'vitest';
import { isOnboardingState } from './lifecycle';

describe('isOnboardingState', () => {
  it('routes install and resume states to onboarding', () => {
    expect(isOnboardingState('NeedsInstall')).toBe(true);
    expect(isOnboardingState('InstallResume')).toBe(true);
    expect(isOnboardingState('NeedsAuthForInstall')).toBe(true);
  });

  it('keeps installed and steady states on the normal app path', () => {
    expect(isOnboardingState('InstalledFirstRun')).toBe(false);
    expect(isOnboardingState('InstalledLegacyUpdate')).toBe(false);
    expect(isOnboardingState('SteadyState')).toBe(false);
  });

  it('fails safe to the normal app path for missing or unknown states', () => {
    expect(isOnboardingState(null)).toBe(false);
    expect(isOnboardingState(undefined)).toBe(false);
    expect(isOnboardingState('UnknownState')).toBe(false);
  });
});
