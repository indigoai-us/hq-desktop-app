import { describe, expect, it } from 'vitest';
import { shouldRecheckAuthOnFocus } from './authRecheckGate';

describe('shouldRecheckAuthOnFocus', () => {
  it('rechecks when the popover gains focus while unauthenticated', () => {
    expect(shouldRecheckAuthOnFocus(true, false)).toBe(true);
  });

  it('does not recheck when already authenticated', () => {
    expect(shouldRecheckAuthOnFocus(true, true)).toBe(false);
  });

  it('does not recheck while blurred', () => {
    expect(shouldRecheckAuthOnFocus(false, false)).toBe(false);
    expect(shouldRecheckAuthOnFocus(false, true)).toBe(false);
  });
});
