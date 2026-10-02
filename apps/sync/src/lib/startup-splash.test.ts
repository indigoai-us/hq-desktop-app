import { describe, expect, it } from 'vitest';
import { startupSplashFor } from './startup-splash';

describe('startupSplashFor', () => {
  it('paints the opaque welcome splash on a first launch before startup resolves', () => {
    expect(startupSplashFor({ startupResolved: false, welcomeWindowActive: true })).toBe(
      'welcome-splash',
    );
  });

  it('keeps the compact spinner for a returning user', () => {
    expect(startupSplashFor({ startupResolved: false, welcomeWindowActive: false })).toBe(
      'spinner',
    );
  });

  it('paints nothing once startup has resolved', () => {
    expect(startupSplashFor({ startupResolved: true, welcomeWindowActive: true })).toBe('none');
    expect(startupSplashFor({ startupResolved: true, welcomeWindowActive: false })).toBe('none');
  });
});
