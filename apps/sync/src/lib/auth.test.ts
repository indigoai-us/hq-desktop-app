import { describe, expect, it } from 'vitest';
import { shouldSkipSignIn } from './auth';

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
