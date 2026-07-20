import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isOnboardingState } from './lifecycle';

function readSrc(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('isOnboardingState', () => {
  it('routes install, resume, and brand-new first-run states to onboarding', () => {
    expect(isOnboardingState('NeedsInstall')).toBe(true);
    expect(isOnboardingState('InstallResume')).toBe(true);
    expect(isOnboardingState('NeedsAuthForInstall')).toBe(true);
    expect(isOnboardingState('InstalledFirstRun')).toBe(true);
  });

  it('keeps installed and steady states on the normal app path', () => {
    expect(isOnboardingState('InstalledLegacyUpdate')).toBe(false);
    expect(isOnboardingState('SteadyState')).toBe(false);
  });

  it('fails safe to the normal app path for missing or unknown states', () => {
    expect(isOnboardingState(null)).toBe(false);
    expect(isOnboardingState(undefined)).toBe(false);
    expect(isOnboardingState('UnknownState')).toBe(false);
  });

  it('keeps first-run completion out of the App startup path', () => {
    const app = readSrc('../App.svelte');
    const onboarding = readSrc('../components/Onboarding.svelte');

    expect(app).not.toContain("invoke<boolean>('is_first_run')");
    expect(app).not.toContain("invoke('mark_first_run_complete')");
    expect(onboarding).toContain("invoke('mark_first_run_complete')");
  });

  it('prompts for the tutorial after onboarding finishes', () => {
    const app = readSrc('../App.svelte');

    expect(app).toContain('async function handleOnboardingFinish()');
    expect(app).toContain('showTutorialPrompt = true');
    expect(app).toContain("openTutorial('hq_desktop_onboarding')");
  });
});
