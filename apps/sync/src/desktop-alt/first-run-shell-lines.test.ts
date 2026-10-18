import { describe, expect, it } from 'vitest';
import {
  authSessionRemountLine,
  errorBoundaryReloadLine,
  signOutRemountLine,
  tenantSwitchRemountLine,
} from '@hq/ui/first-run-timing';

describe('[first-run] shell remount and reload lines', () => {
  it('logs a remount only when the auth generation is newer', () => {
    expect(authSessionRemountLine(2, 1)).toBeNull();
    expect(authSessionRemountLine(4, 4)).toBeNull();
    expect(authSessionRemountLine(4, 5)).toBe('kind=shell event=remount reason=auth-session');
  });

  it('logs sign-out, a tenant switch, and an error-boundary reload as fixed words', () => {
    expect(signOutRemountLine()).toBe('kind=shell event=remount reason=sign-out');
    expect(tenantSwitchRemountLine()).toBe('kind=shell event=remount reason=tenant-switch');
    expect(errorBoundaryReloadLine()).toBe('kind=shell event=reload reason=error-boundary');
  });
});
