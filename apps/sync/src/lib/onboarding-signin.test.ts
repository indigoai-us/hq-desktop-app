import { describe, expect, it } from 'vitest';
import { mapSignInError } from './onboarding-signin';

describe('mapSignInError', () => {
  it('uses friendly copy for the structured port-in-use error', () => {
    expect(mapSignInError('{"code":"OAUTH_PORT_IN_USE"}', 'Google')).toBe(
      'Sign-in needs local port 53682, but another process is already using it. Close the other sign-in window or app using that port, then retry.',
    );
  });

  it('preserves structured provider error messages', () => {
    expect(
      mapSignInError(
        '{"code":"OAUTH_PROVIDER_ERROR","message":"The sign-in was denied."}',
        'Microsoft',
      ),
    ).toBe('The sign-in was denied.');
  });

  it('maps token exchange failures to retryable copy', () => {
    expect(mapSignInError('token exchange failed: 400 invalid_grant', 'Google')).toBe(
      "We couldn't finish sign-in after the browser step. Check your connection and retry.",
    );
  });

  it('falls back to the original message or a default', () => {
    expect(mapSignInError('network unavailable', 'Microsoft')).toBe('network unavailable');
    expect(mapSignInError('', 'Google')).toBe('Sign-in failed');
  });
});
