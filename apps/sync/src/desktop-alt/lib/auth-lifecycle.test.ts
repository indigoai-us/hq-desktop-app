import { describe, expect, it } from 'vitest';
import { lifecycleForAuthStatus } from './auth-lifecycle';

describe('lifecycleForAuthStatus', () => {
  it('keeps an unreadable token store in recovery instead of signing the person out', () => {
    // Regression: build 4b51750d showed "You are signed out" after a relaunch
    // while the session was still valid on disk. A failed read is transient.
    expect(lifecycleForAuthStatus('credentials_read_error')).toEqual({ lifecycle: 'recovery' });
  });

  it('keeps a transient refresh failure in recovery', () => {
    expect(lifecycleForAuthStatus('refresh_temporarily_unavailable')).toEqual({ lifecycle: 'recovery' });
  });

  it('signs out only on definitive verdicts', () => {
    expect(lifecycleForAuthStatus('credentials_absent')).toEqual({ lifecycle: 'signed-out', reason: 'signed-out' });
    expect(lifecycleForAuthStatus('credentials_invalid')).toEqual({ lifecycle: 'signed-out', reason: 'invalid' });
    expect(lifecycleForAuthStatus('non_human_principal')).toEqual({ lifecycle: 'signed-out', reason: 'non-human' });
    expect(lifecycleForAuthStatus('active')).toEqual({ lifecycle: 'hydrate' });
  });
});
