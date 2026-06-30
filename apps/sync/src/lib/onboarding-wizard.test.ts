import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWizardRouterCompletionForTests,
  AUTH_GATED_STEPS,
  createWizardRouter,
  getStepValidity,
  initialStepForLifecycle,
  markSetupStepCompleted,
  WIZARD_STEPS,
  type WizardState,
} from './onboarding-wizard';

function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    installPath: null,
    ...overrides,
  };
}

describe('onboarding wizard step contract', () => {
  it('defines the five phase-2 onboarding steps', () => {
    expect(WIZARD_STEPS).toEqual([
      { index: 1, id: 'welcome', label: 'Welcome' },
      { index: 2, id: 'install', label: 'Install' },
      { index: 3, id: 'signin', label: 'Sign In' },
      { index: 4, id: 'setup', label: 'Setup' },
      { index: 5, id: 'done', label: 'Done' },
    ]);
    expect(AUTH_GATED_STEPS).toEqual([4]);
  });
});

describe('createWizardRouter', () => {
  beforeEach(() => {
    __resetWizardRouterCompletionForTests();
  });

  it('starts at step 1 by default and accepts a valid start option', () => {
    expect(createWizardRouter().currentStep).toBe(1);
    expect(createWizardRouter({ start: 3 }).currentStep).toBe(3);
  });

  it('clamps next() at the final step', () => {
    const router = createWizardRouter();

    for (let i = 0; i < WIZARD_STEPS.length + 2; i += 1) {
      router.next();
    }

    expect(router.currentStep).toBe(5);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('clamps back() at the first step', () => {
    const router = createWizardRouter();

    router.back();

    expect(router.currentStep).toBe(1);
    expect(router.canGoBack).toBe(false);
  });

  it('moves backward from non-gated steps', () => {
    const router = createWizardRouter({ start: 3 });

    router.back();

    expect(router.currentStep).toBe(2);
    expect(router.canGoBack).toBe(true);
  });

  it('blocks back navigation from the auth-gated setup step', () => {
    const router = createWizardRouter({ start: 4 });

    router.back();

    expect(router.currentStep).toBe(4);
    expect(router.canGoBack).toBe(false);
  });

  it('uses getStepValidity for canGoNext', () => {
    const router = createWizardRouter({ start: 2 });

    expect(router.canGoNext(makeState())).toBe(false);
    expect(router.canGoNext(makeState({ installPath: '' }))).toBe(false);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(true);

    router.goTo(4);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('blocks navigation targets that cross the auth gate backwards', () => {
    const router = createWizardRouter({ start: 5 });

    expect(router.canNavigateTo(4)).toBe(true);
    expect(router.canNavigateTo(3)).toBe(false);
    expect(router.canNavigateTo(2)).toBe(false);
    expect(router.canNavigateTo(1)).toBe(false);
  });

  it('rejects out-of-range and current navigation targets', () => {
    const router = createWizardRouter({ start: 3 });

    expect(router.canNavigateTo(0)).toBe(false);
    expect(router.canNavigateTo(3)).toBe(false);
    expect(router.canNavigateTo(6)).toBe(false);
  });

  it('does not navigate to a completed setup gate', () => {
    const router = createWizardRouter();

    markSetupStepCompleted();
    expect(router.canNavigateTo(4)).toBe(false);
    router.goTo(4);

    expect(router.currentStep).toBe(1);
  });
});

describe('getStepValidity', () => {
  it('requires a non-empty installPath on step 2', () => {
    expect(getStepValidity(2, makeState())).toBe(false);
    expect(getStepValidity(2, makeState({ installPath: '' }))).toBe(false);
    expect(getStepValidity(2, makeState({ installPath: '/tmp/hq' }))).toBe(true);
  });

  it('keeps step 4 invalid for manual next because setup auto-advances', () => {
    expect(getStepValidity(4, makeState())).toBe(false);
    expect(getStepValidity(4, makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('defaults to valid for ungated steps', () => {
    expect(getStepValidity(1, makeState())).toBe(true);
    expect(getStepValidity(3, makeState())).toBe(true);
    expect(getStepValidity(5, makeState())).toBe(true);
  });
});

describe('initialStepForLifecycle', () => {
  it('starts NeedsAuthForInstall at sign in', () => {
    expect(initialStepForLifecycle('NeedsAuthForInstall')).toBe(3);
  });

  it('starts InstallResume at setup', () => {
    expect(initialStepForLifecycle('InstallResume')).toBe(4);
  });

  it('starts NeedsInstall and unknown states at welcome', () => {
    expect(initialStepForLifecycle('NeedsInstall')).toBe(1);
    expect(initialStepForLifecycle('SteadyState')).toBe(1);
  });
});
