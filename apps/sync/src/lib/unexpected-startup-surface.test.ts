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
    expect(unexpectedSurfaceForState('NeedsInstall', false)).toBe('onboarding');
    expect(unexpectedSurfaceForState('InstallResume', false)).toBe('onboarding');
    expect(unexpectedSurfaceForState('NeedsAuthForInstall', false)).toBe('onboarding');
    expect(unexpectedSurfaceForState('InstalledFirstRun', false)).toBe('onboarding');
  });

  it('treats onboarding as unexpected even when authenticated is true (mid-install reauth edge)', () => {
    expect(unexpectedSurfaceForState('NeedsInstall', true)).toBe('onboarding');
  });

  it('returns null when lifecycle state is unknown and machine is authenticated', () => {
    expect(unexpectedSurfaceForState(null, true)).toBe(null);
    expect(unexpectedSurfaceForState('SteadyState', true)).toBe(null);
  });

  it('a fresh install (NeedsInstall, not authenticated) shows onboarding — expected on first run', () => {
    // This IS returned as 'onboarding' because we can't distinguish a fresh
    // install from a regression here; the backend command does that via
    // prior_setup_detected (install_completed / first_run_completed / token file).
    expect(unexpectedSurfaceForState('NeedsInstall', false)).toBe('onboarding');
  });
});
