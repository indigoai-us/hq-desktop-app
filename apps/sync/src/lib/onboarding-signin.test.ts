import { describe, expect, it, vi } from 'vitest';
import { mapSignInError } from './onboarding-signin';

describe('mapSignInError', () => {
  it('maps referral persistence failures to neutral retryable copy', () => {
    const error = mapSignInError(
      '{"code":"OAUTH_REFERRAL_PERSIST_FAILED","message":"diagnostic: token=secret; raw={\\"user_id\\":123}"}',
      'Google',
    );

    expect(error).toBe('We couldn’t finish preparing sign-in. Please try again.');
    expect(error).not.toContain('diagnostic');
    expect(error).toContain('try again');
  });

  it('uses friendly copy for the structured port-in-use error', () => {
    expect(mapSignInError('{"code":"OAUTH_PORT_IN_USE"}', 'Google')).toBe(
      'Sign-in could not open a registered local callback port (53682, 8765, or 3000). Close another sign-in window or app using one, then retry.',
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

  it('surfaces Microsoft resolve failures instead of sending work users to personal sign-in', () => {
    expect(
      mapSignInError(
        '{"code":"MICROSOFT_ENABLEMENT_REQUIRED","message":"This Microsoft work account is not set up for HQ Desktop yet. Sign in at hqforwork.com first, then return here."}',
        'Microsoft',
      ),
    ).toBe(
      'This Microsoft work account is not set up for HQ Desktop yet. Sign in at hqforwork.com first, then return here.',
    );
    expect(
      mapSignInError(
        '{"code":"MICROSOFT_RESOLVE_FAILED","message":"We could not identify your Microsoft account. Check your connection and retry."}',
        'Microsoft',
      ),
    ).toBe('We could not identify your Microsoft account. Check your connection and retry.');
  });

  it('maps token exchange failures to retryable copy', () => {
    expect(mapSignInError('token exchange failed: 400 invalid_grant', 'Google')).toBe(
      "We couldn't finish sign-in after the browser step. Check your connection and retry.",
    );
  });

  it('falls back to plain copy, never the raw message, and logs the raw text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = 'oauth x HTTP 500 Internal Server Error: {"message":"boom"}';
    expect(mapSignInError('network unavailable', 'Microsoft')).toBe(
      'Sign-in did not finish. Choose your provider and try again.',
    );
    expect(mapSignInError('', 'Google')).toBe('Sign-in did not finish. Choose your provider and try again.');
    const shown = mapSignInError(raw, 'Google');
    expect(shown).not.toContain('HTTP 500');
    expect(shown).toContain('try again');
    expect(warn).toHaveBeenCalledWith('[signin] sign-in failed', raw);
    warn.mockRestore();
  });
});
