import { describe, expect, it, vi } from 'vitest';
import {
  decideAccountKind,
  historicalCompanyUids,
  pickPrimaryCompany,
  type MembershipCompany,
} from './onboarding-company-route';
import {
  ACCOUNT_KIND_LOOKUP_ATTEMPTS,
  MEMBERSHIP_ME_WITH_HISTORY_URL,
  resolveAccountKind,
} from './first-run-company';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyUid: 'cmp_a',
    companyName: 'Acme',
    companySlug: 'acme',
    status: 'active',
    role: 'owner',
    bucketName: 'hq-acme',
    planTier: 'free',
    ...overrides,
  };
}

function company(overrides: Partial<MembershipCompany> = {}): MembershipCompany {
  return {
    companyUid: 'cmp_a',
    name: 'A',
    slug: 'a',
    role: 'owner',
    paid: false,
    bucketName: 'b',
    provisioning: null,
    provisioningFailedStep: null,
    ...overrides,
  };
}

describe('decideAccountKind', () => {
  it('0 memberships and no company history is a new account', () => {
    expect(decideAccountKind({ memberships: [], historicalCompanyIdentities: {} })).toEqual({ kind: 'new' });
  });

  it('an owned free company is returning, with that company as primary', () => {
    const decision = decideAccountKind({ memberships: [row()], historicalCompanyIdentities: {} });
    expect(decision.kind).toBe('returning');
    if (decision.kind !== 'returning') return;
    expect(decision.signal).toBe('active_membership');
    expect(decision.primary?.slug).toBe('acme');
    expect(decision.primary?.paid).toBe(false);
  });

  it('a paid company is returning and wins primary over a free one listed first', () => {
    const decision = decideAccountKind({
      memberships: [
        row({ companyUid: 'cmp_free', companySlug: 'free-co' }),
        row({ companyUid: 'cmp_paid', companySlug: 'paid-co', planTier: 'team' }),
      ],
    });
    expect(decision.kind).toBe('returning');
    if (decision.kind !== 'returning') return;
    expect(decision.companies.map((c) => c.slug)).toEqual(['free-co', 'paid-co']);
    expect(decision.primary?.slug).toBe('paid-co');
  });

  it('a non-owner member is returning', () => {
    const decision = decideAccountKind({ memberships: [row({ role: 'member' })] });
    expect(decision).toMatchObject({ kind: 'returning', signal: 'active_membership' });
  });

  it('only pending invites, with no history, is still a new account', () => {
    expect(
      decideAccountKind({ memberships: [row({ status: 'pending' })], historicalCompanyIdentities: {} }),
    ).toEqual({ kind: 'new' });
  });

  it('zero companies today but a past company on the server is returning, with nothing to pull', () => {
    expect(
      decideAccountKind({
        memberships: [],
        historicalCompanyIdentities: { cmp_old: { uid: 'cmp_old', name: 'Old Co', slug: 'old-co' } },
      }),
    ).toEqual({ kind: 'returning', signal: 'company_history', companies: [], primary: null });
  });

  it('zero companies and a payload with no history field is a failed lookup, never new', () => {
    expect(decideAccountKind({ memberships: [] })).toEqual({ kind: 'lookup_failed' });
  });

  it('an unreadable payload is a failed lookup', () => {
    expect(decideAccountKind(null)).toEqual({ kind: 'lookup_failed' });
    expect(decideAccountKind({ memberships: 'nope' })).toEqual({ kind: 'lookup_failed' });
  });
});

describe('historicalCompanyUids', () => {
  it('lists company uids only, and null when the field is absent', () => {
    expect(historicalCompanyUids({ historicalCompanyIdentities: { cmp_a: {}, prs_x: {} } })).toEqual(['cmp_a']);
    expect(historicalCompanyUids({ memberships: [] })).toBeNull();
  });
});

describe('pickPrimaryCompany', () => {
  it('picks paid first, then most recently joined, then the first', () => {
    const older = company({ companyUid: 'cmp_old', slug: 'old', lastActiveAt: 1000 });
    const newer = company({ companyUid: 'cmp_new', slug: 'new', lastActiveAt: 5000 });
    const paidOld = company({ companyUid: 'cmp_paid', slug: 'paid', paid: true, lastActiveAt: 10 });
    expect(pickPrimaryCompany([older, newer, paidOld])?.slug).toBe('paid');
    expect(pickPrimaryCompany([older, newer])?.slug).toBe('new');
    expect(pickPrimaryCompany([company({ slug: 'first' }), company({ slug: 'second' })])?.slug).toBe('first');
    expect(pickPrimaryCompany([])).toBeNull();
  });

  it('reads the join time from acceptedAt, else createdAt', () => {
    const decision = decideAccountKind({
      memberships: [
        row({ companyUid: 'cmp_1', companySlug: 'one', createdAt: '2026-01-01T00:00:00Z' }),
        row({ companyUid: 'cmp_2', companySlug: 'two', createdAt: '2025-01-01T00:00:00Z', acceptedAt: '2026-06-01T00:00:00Z' }),
      ],
    });
    expect(decision.kind === 'returning' && decision.primary?.slug).toBe('two');
  });
});

describe('resolveAccountKind', () => {
  it('reads /membership/me with company history', () => {
    expect(MEMBERSHIP_ME_WITH_HISTORY_URL).toBe('/membership/me?includeHistoricalCompanyIdentities=true');
  });

  it('a failed read then a good one is returning', async () => {
    const readMembershipMe = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ memberships: [row()] });
    const invalidate = vi.fn();
    const sleep = vi.fn(async () => {});
    const decision = await resolveAccountKind({ readMembershipMe, invalidateMembershipMeRead: invalidate, sleep });
    expect(decision.kind).toBe('returning');
    expect(readMembershipMe).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('an unreadable answer is retried like a failure', async () => {
    const readMembershipMe = vi
      .fn()
      .mockResolvedValueOnce({ memberships: [] })
      .mockResolvedValueOnce({ memberships: [], historicalCompanyIdentities: {} });
    const decision = await resolveAccountKind({ readMembershipMe, sleep: async () => {} });
    expect(decision).toEqual({ kind: 'new' });
    expect(readMembershipMe).toHaveBeenCalledTimes(2);
  });

  it('gives up after every attempt fails, as lookup_failed (never new)', async () => {
    const readMembershipMe = vi.fn().mockRejectedValue(new Error('offline'));
    const decision = await resolveAccountKind({ readMembershipMe, sleep: async () => {} });
    expect(decision).toEqual({ kind: 'lookup_failed' });
    expect(readMembershipMe).toHaveBeenCalledTimes(ACCOUNT_KIND_LOOKUP_ATTEMPTS);
  });

  it('calls onRetry once before each retry, so the caller knows the answer is not in yet', async () => {
    const firstTry = vi.fn();
    await resolveAccountKind({
      readMembershipMe: vi.fn().mockResolvedValue({ memberships: [row()] }),
      sleep: async () => {},
      onRetry: firstTry,
    });
    expect(firstTry).not.toHaveBeenCalled();

    const secondTry = vi.fn();
    await resolveAccountKind({
      readMembershipMe: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ memberships: [row()] }),
      sleep: async () => {},
      onRetry: secondTry,
    });
    expect(secondTry).toHaveBeenCalledTimes(1);

    const never = vi.fn();
    await resolveAccountKind({
      readMembershipMe: vi.fn().mockRejectedValue(new Error('offline')),
      sleep: async () => {},
      onRetry: never,
    });
    expect(never).toHaveBeenCalledTimes(ACCOUNT_KIND_LOOKUP_ATTEMPTS - 1);
  });
});
