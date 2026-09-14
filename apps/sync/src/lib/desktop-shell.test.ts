import { describe, expect, it } from 'vitest';
import { resolveLaunchShell } from './desktop-shell';

describe('desktop workspace is the only launch surface', () => {
  it('gives a signed-out user the desktop workspace', () => {
    expect(resolveLaunchShell({ email: null, companyUid: null })).toBe('desktop-alt');
    expect(resolveLaunchShell({ email: '', companyUid: null })).toBe('desktop-alt');
  });

  it('gives a GA user with no company affiliation the desktop workspace', () => {
    expect(
      resolveLaunchShell({
        email: 'someone@gmail.com',
        companyUid: null,
        hqWorkHandoff: null,
      }),
    ).toBe('desktop-alt');
  });

  it('gives an upgraded install carrying hqWorkHandoff:false the desktop workspace', () => {
    expect(
      resolveLaunchShell({
        email: 'qa@example.com',
        companyUid: null,
        hqWorkHandoff: false,
      }),
    ).toBe('desktop-alt');
  });

  it('does not let leftover stagingChannel / hqWorkHandoff keys pick a different shell', () => {
    expect(
      resolveLaunchShell({
        email: 'michel@other-company.com',
        companyUid: 'cmp_acme',
        hqWorkHandoff: false,
      }),
    ).toBe('desktop-alt');
    expect(
      resolveLaunchShell({
        email: 'michel@other-company.com',
        companyUid: 'cmp_acme',
        hqWorkHandoff: true,
      }),
    ).toBe('desktop-alt');
  });
});
