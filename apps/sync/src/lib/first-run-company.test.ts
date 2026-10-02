import { describe, expect, it, vi } from 'vitest';
import {
  activeCompanyUids,
  approvedCheckoutUrl,
  CHECKOUT_DISABLED_REASON,
  CHECKOUT_FAILED_REASON,
  createFirstRunCompanyApi,
  isCheckoutReturnFor,
  parseInviteEmails,
  resolveFirstRunCompanyPath,
  startWorkforceCheckout,
  workforceCheckoutBody,
  type InvokeFn,
} from './first-run-company';

function pendingWorkspace(slug: string, displayName: string) {
  return {
    slug,
    displayName,
    kind: 'company',
    state: 'cloud-only',
    cloudUid: `cmp_${slug}`,
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: 'pending',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: 'prs_owner',
    invitedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('activeCompanyUids', () => {
  it('keeps active company memberships only, once each', () => {
    expect(
      activeCompanyUids({
        memberships: [
          { companyUid: 'cmp_a', status: 'active' },
          { companyUid: 'cmp_a', status: 'active' },
          { companyUid: 'cmp_b', status: 'pending' },
          { companyUid: 'prs_personal', status: 'active' },
        ],
      }),
    ).toEqual(['cmp_a']);
  });

  it('returns null for an unreadable payload', () => {
    expect(activeCompanyUids({ memberships: 'nope' })).toBeNull();
    expect(activeCompanyUids({})).toBeNull();
  });
});

describe('resolveFirstRunCompanyPath', () => {
  it('skips the step for a returning member', async () => {
    const invoke = vi.fn();
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [{ companyUid: 'cmp_a', status: 'active' }] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(path).toEqual({ kind: 'existing', companyUids: ['cmp_a'] });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('offers to join when a person with no company has a pending invite', async () => {
    const invoke = vi.fn(async () => ({ workspaces: [pendingWorkspace('acme', 'Acme')] }));
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(invoke).toHaveBeenCalledWith('list_syncable_workspaces');
    expect(path).toEqual({ kind: 'join', invites: [{ slug: 'acme', displayName: 'Acme' }] });
  });

  it('asks a brand-new person to name a company', async () => {
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [] }),
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
    });
    expect(path).toEqual({ kind: 'create' });
  });

  it('still offers create when the invite lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [] }),
      invoke: (async () => {
        throw new Error('offline');
      }) as unknown as InvokeFn,
    });
    expect(path).toEqual({ kind: 'create' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips the step when membership cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => {
        throw new Error('hq-pro request failed with status 500');
      },
      invoke: vi.fn() as unknown as InvokeFn,
    });
    expect(path).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('createFirstRunCompanyApi', () => {
  it('drives the same native commands as the app shell', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'run_card_action') {
        return { state: 'done', companyUid: 'cmp_new', companyChannelId: 'ch_new' };
      }
      if (command === 'fetch_channel') return { messages: [], nextCursor: null };
      return { valid: true };
    });
    const api = createFirstRunCompanyApi(invoke as unknown as InvokeFn);

    const result = await api.runCardAction({
      channelId: 'setup',
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Acme' },
    });
    expect(invoke).toHaveBeenCalledWith('run_card_action', {
      channelId: 'setup',
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Acme' },
      idempotencyKey: null,
    });
    expect(result).toMatchObject({ state: 'done', companyUid: 'cmp_new', companyChannelId: 'ch_new' });

    await expect(api.fetchChannel({ channelId: 'setup', limit: 50 })).resolves.toEqual({
      messages: [],
      nextCursor: null,
    });
    await api.checkCompanySlug?.('acme');
    expect(invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme' });
  });
});

describe('parseInviteEmails', () => {
  it('splits on commas, spaces and lines, drops repeats, flags bad addresses', () => {
    expect(parseInviteEmails('a@x.com, b@x.com\nA@x.com; nope')).toEqual({
      valid: ['a@x.com', 'b@x.com'],
      invalid: ['nope'],
    });
    expect(parseInviteEmails('   ')).toEqual({ valid: [], invalid: [] });
  });
});

describe('workforce checkout', () => {
  it('uses the strict hq-desktop return pair hq-pro accepts', () => {
    expect(workforceCheckoutBody('cmp_new')).toEqual({
      companyUid: 'cmp_new',
      successUrl: 'hq-desktop://setup?checkout=done&company=cmp_new',
      cancelUrl: 'hq-desktop://setup',
    });
  });

  it('only opens a Stripe-hosted https page', () => {
    expect(approvedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test')).toBe(
      'https://checkout.stripe.com/c/pay/cs_test',
    );
    expect(approvedCheckoutUrl('http://checkout.stripe.com/c/pay')).toBeNull();
    expect(approvedCheckoutUrl('https://evil.example/checkout.stripe.com')).toBeNull();
    expect(approvedCheckoutUrl(42)).toBeNull();
  });

  it('posts to the team checkout route and returns the url', async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    }));
    const result = await startWorkforceCheckout(invoke as unknown as InvokeFn, 'cmp_new');
    expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(invoke).toHaveBeenCalledWith('hq_pro_fetch', {
      url: '/v1/billing/checkout/team',
      method: 'POST',
      body: JSON.stringify(workforceCheckoutBody('cmp_new')),
    });
  });

  it('explains the kill switch in plain words', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi.fn(async () => ({
      status: 503,
      body: JSON.stringify({ code: 'team_signup_disabled' }),
    }));
    expect(await startWorkforceCheckout(invoke as unknown as InvokeFn, 'cmp_new')).toEqual({
      ok: false,
      reason: CHECKOUT_DISABLED_REASON,
    });
    warn.mockRestore();
  });

  it('fails readably on an error status, a missing url, or a thrown call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const answer of [
      async () => ({ status: 403, body: '{"code":"FORBIDDEN"}' }),
      async () => ({ status: 200, body: '{"url":"https://example.com/pay"}' }),
      async () => {
        throw new Error('network');
      },
    ]) {
      const result = await startWorkforceCheckout(answer as unknown as InvokeFn, 'cmp_new');
      expect(result).toEqual({ ok: false, reason: CHECKOUT_FAILED_REASON });
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('matches the checkout return to this company only', () => {
    expect(isCheckoutReturnFor({ companyUid: 'cmp_new', checkout: 'done' }, 'cmp_new')).toBe(true);
    expect(isCheckoutReturnFor({ companyUid: 'cmp_other', checkout: 'done' }, 'cmp_new')).toBe(false);
    expect(isCheckoutReturnFor({ companyUid: 'cmp_new', checkout: '' }, 'cmp_new')).toBe(false);
    expect(isCheckoutReturnFor(null, 'cmp_new')).toBe(false);
  });
});
