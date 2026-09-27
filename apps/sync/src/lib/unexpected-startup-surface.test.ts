import { describe, expect, it } from 'vitest';
import { unexpectedSurfaceForState } from './unexpected-startup-surface';

describe('unexpectedSurfaceForState', () => {
  it('returns null for a signed-in machine (normal case — no report)', () => {
    expect(unexpectedSurfaceForState('SteadyState', true)).toBe(null);
    expect(unexpectedSurfaceForState('InstalledLegacyUpdate', true)).toBe(null);
  });

  it('returns sign-in when a set-up machine lands on the sign-in card', () => {
    expect(unexpectedSurfaceForState('SteadyState', false)).toBe('sign-in');
    expect(unexpectedSurfaceForState(null, false)).toBe('sign-in');
  });

  it('returns onboarding when a machine lands on an onboarding surface', () => {
    const installed = {
      installCompleted: true,
      firstRunCompleted: false,
      hadMachineId: true,
      hqRootValid: true,
    };
    expect(unexpectedSurfaceForState('InstalledFirstRun', false, installed)).toBe('onboarding');
    expect(unexpectedSurfaceForState('NeedsInstall', false, installed)).toBe('onboarding');
  });

  it('keeps InstalledFirstRun reportable when older setup markers are absent', () => {
    expect(
      unexpectedSurfaceForState('InstalledFirstRun', false, {
        installCompleted: false,
        firstRunCompleted: false,
        hadMachineId: false,
        hqRootValid: false,
      }),
    ).toBe('onboarding');
  });

  it('does not report onboarding for new or incomplete installs without prior setup evidence', () => {
    const noPriorSetup = {
      installCompleted: false,
      firstRunCompleted: false,
      hadMachineId: false,
      hqRootValid: false,
    };
    for (const state of ['NeedsInstall', 'NeedsAuthForInstall', 'InstallResume']) {
      expect(unexpectedSurfaceForState(state, false, noPriorSetup), state).toBe(null);
      expect(unexpectedSurfaceForState(state, true, noPriorSetup), state).toBe(null);
    }
  });

  it('retains prior-machine evidence when a root is valid even if completion flags are absent', () => {
    expect(
      unexpectedSurfaceForState('InstallResume', false, {
        installCompleted: false,
        firstRunCompleted: false,
        hadMachineId: true,
        hqRootValid: true,
      }),
    ).toBe('onboarding');
  });

  it('returns sign-in when lifecycle state is unknown or steady and auth is absent', () => {
    expect(unexpectedSurfaceForState(null, true)).toBe(null);
    expect(unexpectedSurfaceForState('SteadyState', true)).toBe(null);
    expect(unexpectedSurfaceForState(null, false)).toBe('sign-in');
    expect(unexpectedSurfaceForState('SteadyState', false)).toBe('sign-in');
  });

  it('keeps the existing report attempt if setup evidence could not be read', () => {
    expect(unexpectedSurfaceForState('NeedsInstall', false, null)).toBe('onboarding');
  });
});
