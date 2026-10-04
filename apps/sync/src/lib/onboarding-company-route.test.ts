import { describe, expect, it } from 'vitest';
import {
  activeMembershipCompanies,
  companyUidFromMissingBucket,
  decideCompanyRoute,
  inviteOffers,
  isMissingBucketMessage,
  isPaidMembershipRow,
  maskEmail,
  otherIdentityFromLookup,
  priorPlanFromPayload,
  provisioningStateFromEntity,
  type CompanyInviteOffer,
  type MembershipCompany,
} from './onboarding-company-route';

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

function invite(overrides: Partial<CompanyInviteOffer> = {}): CompanyInviteOffer {
  return { companyUid: 'cmp_i', slug: 'i', name: 'Inv', inviter: null, inviteeEmail: null, expired: false, ...overrides };
}

const route = (input: Partial<Parameters<typeof decideCompanyRoute>[0]>) =>
  decideCompanyRoute({ companies: [], invites: [], signedInEmail: 'me@x.com', ...input });

describe('decideCompanyRoute', () => {
  it('resumes an owned company still provisioning, before anything else', () => {
    expect(
      route({ companies: [company({ paid: true, provisioning: 'failed', provisioningFailedStep: 'kms-create' })] }),
    ).toMatchObject({ kind: 'resume', state: 'failed', step: 'kms-create' });
  });

  it('skips for a paid company, even next to an owned free one', () => {
    expect(route({ companies: [company(), company({ companyUid: 'cmp_p', paid: true })] })).toMatchObject({
      kind: 'skip',
      decision: 'paid_existing',
      company: { companyUid: 'cmp_p' },
    });
  });

  it('skips for a company the person joined', () => {
    expect(route({ companies: [company({ role: 'member' })] })).toMatchObject({ kind: 'skip', decision: 'joined_existing' });
  });

  it('offers "Use" for an owned free company', () => {
    expect(route({ companies: [company()] })).toMatchObject({ kind: 'existing', decision: 'offer_existing' });
  });

  it('joins a live invite for this email', () => {
    expect(route({ invites: [invite({ inviteeEmail: 'ME@x.com' })] })).toMatchObject({ kind: 'join', decision: 'join_invite' });
  });

  it('flags an invite sent to another email', () => {
    expect(route({ invites: [invite({ inviteeEmail: 'other@x.com' })] })).toMatchObject({
      kind: 'join',
      decision: 'invite_other_email',
    });
  });

  it('prefers a live invite over an expired one, and falls back to expired', () => {
    expect(route({ invites: [invite({ expired: true }), invite({ companyUid: 'cmp_j' })] })).toMatchObject({
      decision: 'join_invite',
      invites: [{ companyUid: 'cmp_j' }],
    });
    expect(route({ invites: [invite({ expired: true })] })).toMatchObject({ decision: 'invite_expired' });
  });

  it('offers to switch for a visitor company under another account before create', () => {
    expect(route({ otherIdentity: { maskedEmail: 'c•••@a.com', companyName: null } })).toMatchObject({
      kind: 'other-identity',
    });
    expect(route({})).toEqual({ kind: 'create', decision: 'create' });
  });
});

describe('membership parsing', () => {
  it('reads paid signals defensively', () => {
    expect(isPaidMembershipRow({ teamPlanEnabled: true })).toBe(true);
    expect(isPaidMembershipRow({ planTier: 'team' })).toBe(true);
    expect(isPaidMembershipRow({ planTier: 'free' })).toBe(false);
    expect(isPaidMembershipRow({ subscriptionStatus: 'active' })).toBe(true);
    expect(isPaidMembershipRow({})).toBe(false);
  });

  it('keeps active cmp_ rows once, with names and provisioning status', () => {
    expect(
      activeMembershipCompanies({
        memberships: [
          { companyUid: 'cmp_a', status: 'active', companyName: 'Acme', companySlug: 'acme', provisioningStatus: 'pending' },
          { companyUid: 'cmp_a', status: 'active' },
          { companyUid: 'cmp_b', status: 'pending' },
          { companyUid: 'prs_x', status: 'active' },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ companyUid: 'cmp_a', name: 'Acme', slug: 'acme', provisioning: 'pending', role: null }),
    ]);
    expect(activeMembershipCompanies({ memberships: 'x' })).toBeNull();
  });

  it('reads invite expiry from status or expiresAt', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(
      inviteOffers(
        [
          { companyUid: 'cmp_a', status: 'expired' },
          { companyUid: 'cmp_b', expiresAt: '2026-10-01T00:00:00Z' },
          { companyUid: 'cmp_c', expiresAt: '2026-10-03T00:00:00Z' },
        ],
        now,
      ).map((offer) => offer.expired),
    ).toEqual([true, true, false]);
  });
});

describe('other identity lookup', () => {
  it('masks and ignores the same person', () => {
    expect(maskEmail('casey@acme.com')).toBe('c•••@acme.com');
    expect(otherIdentityFromLookup({ webIdentity: { email: 'casey@acme.com', companyName: 'Acme' } }, 'me@x.com')).toEqual({
      maskedEmail: 'c•••@acme.com',
      companyName: 'Acme',
    });
    expect(otherIdentityFromLookup({ webIdentity: { email: 'me@x.com', companyName: 'Acme' } }, 'me@x.com')).toBeNull();
    expect(otherIdentityFromLookup({ webIdentity: { samePerson: true, email: 'a@b.c', companyName: 'A' } }, null)).toBeNull();
    expect(otherIdentityFromLookup({ memberships: [] }, null)).toBeNull();
  });
});

describe('provisioning states', () => {
  it('reads entity payloads', () => {
    expect(provisioningStateFromEntity({ entity: { status: 'active', bucketName: 'b' } })).toEqual({ status: 'ready', bucketName: 'b' });
    expect(provisioningStateFromEntity({ entity: { status: 'provisioning' } })).toEqual({ status: 'pending' });
    expect(provisioningStateFromEntity({ entity: { provisioningStatus: 'failed', provisioningFailedStep: 'Bad Step!' } })).toEqual({
      status: 'failed',
      step: 'unknown',
    });
  });

  it('spots the missing-bucket sync error and its company', () => {
    const message = 'Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.';
    expect(isMissingBucketMessage(message)).toBe(true);
    expect(companyUidFromMissingBucket(message)).toBe('cmp_01ABC');
    expect(companyUidFromMissingBucket('timeout')).toBeNull();
  });
});

describe('priorPlanFromPayload', () => {
  it('reads a website plan pick from /membership/me', () => {
    expect(priorPlanFromPayload({ planIntent: 'free', memberships: [] })).toBe('starter');
    expect(priorPlanFromPayload({ planIntent: 'Starter' })).toBe('starter');
    expect(priorPlanFromPayload({ signupPlan: 'team' })).toBe('workforce');
    expect(priorPlanFromPayload({ planIntent: 'workforce' })).toBe('workforce');
  });

  it('reads it from the visitor block of the anonId lookup', () => {
    expect(priorPlanFromPayload({ webIdentity: { plan: 'team' } })).toBe('workforce');
    expect(priorPlanFromPayload({ visitorIdentity: { planIntent: 'free' } })).toBe('starter');
  });

  it('is unknown (the step asks) when nothing usable was sent', () => {
    expect(priorPlanFromPayload(null)).toBeNull();
    expect(priorPlanFromPayload({ memberships: [] })).toBeNull();
    expect(priorPlanFromPayload({ planIntent: 'individual' })).toBeNull();
    expect(priorPlanFromPayload({ planIntent: 'individual-free' })).toBeNull();
    expect(priorPlanFromPayload({ planIntent: 42 })).toBeNull();
    // A paid company's tier is not a pick for a NEW company.
    expect(priorPlanFromPayload({ memberships: [{ planTier: 'team', teamPlanEnabled: true }] })).toBeNull();
  });
});
