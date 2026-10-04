import { describe, expect, it } from 'vitest';
import { sentryEnvironmentForVersion } from './sentry-environment';

describe('sentryEnvironmentForVersion', () => {
  it('keeps shelltest builds out of the production environment', () => {
    expect(sentryEnvironmentForVersion('0.0.0-shelltest.483')).toBe('shelltest');
  });

  it('keeps real desktop releases in production', () => {
    expect(sentryEnvironmentForVersion('0.10.382')).toBe('production');
  });
});
