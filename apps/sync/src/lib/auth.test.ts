import { describe, expect, it } from 'vitest';
import { isExpectedUnauthenticatedError, shouldSkipSignIn } from './auth';

describe('shouldSkipSignIn', () => {
  it('skips when get_auth_state says authenticated', () => {
    expect(shouldSkipSignIn({ authenticated: true })).toBe(true);
  });

  it('does not let stale token-file presence override the validated auth state', () => {
    expect(shouldSkipSignIn({ authenticated: false })).toBe(false);
  });

  it('stays signed in after a successful silent refresh', () => {
    expect(shouldSkipSignIn({ authenticated: true })).toBe(true);
  });
});

describe('isExpectedUnauthenticatedError', () => {
  it.each([
    'Not signed in',
    new Error('request is unauthenticated'),
    { message: 'Not signed in yet' },
    'UNAUTHENTICATED: token hydration is still pending',
  ])('recognizes expected pre-auth misses: %s', (error) => {
    expect(isExpectedUnauthenticatedError(error)).toBe(true);
  });

  it('preserves logging for real unread-summary failures', () => {
    expect(isExpectedUnauthenticatedError(new Error('database unavailable'))).toBe(
      false,
    );
  });
});
