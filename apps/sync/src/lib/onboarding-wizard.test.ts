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
  it('ends first-run onboarding on the ready screen', () => {
    expect(WIZARD_STEPS).toEqual([
      { index: 0, id: 'welcome-signin', label: 'Welcome' },
      { index: 1, id: 'directory', label: 'Location' },
      { index: 2, id: 'setup', label: 'Setup' },
      { index: 3, id: 'ready', label: 'Ready' },
    ]);
    expect(AUTH_GATED_STEPS).toEqual([2]);
  });
});

describe('createWizardRouter', () => {
  beforeEach(() => {
    __resetWizardRouterCompletionForTests();
  });

  it('starts at screen 0 by default and accepts a valid start option', () => {
    expect(createWizardRouter().currentStep).toBe(0);
    expect(createWizardRouter({ start: 3 }).currentStep).toBe(3);
  });

  it('clamps next() at the final step', () => {
    const router = createWizardRouter();

    for (let i = 0; i < WIZARD_STEPS.length + 2; i += 1) {
      router.next();
    }

    expect(router.currentStep).toBe(3);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('clamps back() at the first screen', () => {
    const router = createWizardRouter();

    router.back();

    expect(router.currentStep).toBe(0);
    expect(router.canGoBack).toBe(false);
  });

  it('moves backward from non-gated steps', () => {
    const router = createWizardRouter({ start: 3 });

    router.back();

    expect(router.currentStep).toBe(2);
    expect(router.canGoBack).toBe(true);
  });

  it('allows back navigation from setup until setup has completed', () => {
    const router = createWizardRouter({ start: 2 });

    router.back();

    expect(router.currentStep).toBe(1);
    expect(router.canGoBack).toBe(true);
  });

  it('blocks back navigation from the completed setup gate', () => {
    markSetupStepCompleted();
    const router = createWizardRouter({ start: 2 });

    router.back();

    expect(router.currentStep).toBe(2);
    expect(router.canGoBack).toBe(false);
  });

  it('uses getStepValidity for canGoNext', () => {
    const router = createWizardRouter({ start: 1 });

    expect(router.canGoNext(makeState())).toBe(false);
    expect(router.canGoNext(makeState({ installPath: '' }))).toBe(false);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(true);

    router.goTo(2);
    expect(router.canGoNext(makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('blocks navigation targets that cross the completed setup gate backwards', () => {
    markSetupStepCompleted();
    const router = createWizardRouter({ start: 3 });

    expect(router.canNavigateTo(3)).toBe(false);
    expect(router.canNavigateTo(2)).toBe(false);
    expect(router.canNavigateTo(1)).toBe(false);
    expect(router.canNavigateTo(0)).toBe(false);
  });

  it('rejects out-of-range and current navigation targets', () => {
    const router = createWizardRouter({ start: 3 });

    expect(router.canNavigateTo(-1)).toBe(false);
    expect(router.canNavigateTo(3)).toBe(false);
    expect(router.canNavigateTo(4)).toBe(false);
  });

  it('does not navigate to or before a completed setup gate', () => {
    const router = createWizardRouter();

    markSetupStepCompleted();
    expect(router.canNavigateTo(2)).toBe(false);
    expect(router.canNavigateTo(1)).toBe(false);
    router.goTo(2);

    expect(router.currentStep).toBe(0);
  });
});

describe('getStepValidity', () => {
  it('requires a non-empty installPath on the directory screen', () => {
    expect(getStepValidity(1, makeState())).toBe(false);
    expect(getStepValidity(1, makeState({ installPath: '' }))).toBe(false);
    expect(getStepValidity(1, makeState({ installPath: '/tmp/hq' }))).toBe(true);
  });

  it('keeps setup invalid for manual next because setup auto-advances', () => {
    expect(getStepValidity(2, makeState())).toBe(false);
    expect(getStepValidity(2, makeState({ installPath: '/tmp/hq' }))).toBe(false);
  });

  it('defaults to valid for ungated steps', () => {
    expect(getStepValidity(0, makeState())).toBe(true);
    expect(getStepValidity(3, makeState())).toBe(true);
  });
});

describe('initialStepForLifecycle', () => {
  it('starts NeedsAuthForInstall at welcome sign-in', () => {
    expect(initialStepForLifecycle('NeedsAuthForInstall')).toBe(0);
  });

  it('starts InstallResume at setup', () => {
    expect(initialStepForLifecycle('InstallResume')).toBe(2);
  });

  it('starts NeedsInstall and unknown states at welcome', () => {
    expect(initialStepForLifecycle('NeedsInstall')).toBe(0);
    expect(initialStepForLifecycle('SteadyState')).toBe(0);
  });
});
