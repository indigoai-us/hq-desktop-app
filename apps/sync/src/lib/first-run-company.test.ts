import { describe, expect, it, vi } from 'vitest';
import {
  COMPANY_ROUTE_LOOKUP_RETRY_DELAY_MS,
  activeCompanyUids,
  approvedCheckoutUrl,
  CHECKOUT_DISABLED_REASON,
  CHECKOUT_FAILED_REASON,
  createFirstRunCompanyApi,
  deriveCompanyHandle,
  slugifyCompanyName,
  isCheckoutReturnFor,
  isProvisionedCompanyEntity,
  readCompanyProvisioned,
  parseInviteEmails,
  planLimitFromCardError,
  requestCompanyProvisioning,
  resolveFirstRunCompanyPath,
  resolveFirstRunCompanyRoute,
  startWorkforceCheckout,
  waitForProvisioning,
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
  it('selects a company the person already joined', async () => {
    const invoke = vi.fn();
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [{ companyUid: 'cmp_a', status: 'active', role: 'member' }] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(path).toMatchObject({ kind: 'skip', decision: 'joined_existing', company: { companyUid: 'cmp_a' } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('offers to join when a person with no company has a pending invite', async () => {
    const invoke = vi.fn(async () => ({ workspaces: [pendingWorkspace('acme', 'Acme')] }));
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async (_method, url) => (url === '/membership/me' ? { memberships: [] } : { invites: [] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(invoke).toHaveBeenCalledWith('list_syncable_workspaces');
    expect(path).toMatchObject({
      kind: 'join',
      decision: 'join_invite',
      invites: [{ slug: 'acme', name: 'Acme', companyUid: 'cmp_acme' }],
    });
  });

  it('merges pending-by-email rows with workspace names, once per company', async () => {
    const result = await resolveFirstRunCompanyRoute({
      hqProJson: async (_method, url) =>
        url === '/membership/me'
          ? { memberships: [] }
          : { invites: [{ companyUid: 'cmp_acme', invitedBy: 'prs_owner', inviterName: 'Pat' }] },
      invoke: (async () => ({ workspaces: [pendingWorkspace('acme', 'Acme')] })) as unknown as InvokeFn,
    });
    if (result === null || !('route' in result)) throw new Error('Expected the invite route to resolve.');
    expect(result.route).toMatchObject({ kind: 'join', invites: [{ companyUid: 'cmp_acme', name: 'Acme', inviter: 'Pat' }] });
    expect(result.summary).toEqual({ existingCompanies: 0, paidCompany: false, pendingInvites: 1, decision: 'join_invite' });
  });

  it('asks a brand-new person to name a company', async () => {
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async (_method, url) => (url === '/membership/me' ? { memberships: [] } : { invites: [] }),
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
    });
    expect(path).toEqual({ kind: 'create', decision: 'create' });
  });

  it('still offers create when the invite lookups fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async (_method, url) => {
        if (url === '/membership/me') return { memberships: [] };
        throw new Error('offline');
      },
      invoke: (async () => {
        throw new Error('offline');
      }) as unknown as InvokeFn,
    });
    expect(path).toEqual({ kind: 'create', decision: 'create' });
    warn.mockRestore();
  });

  it('returns null when membership cannot be read, so nothing is created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => {
        throw new Error('500');
      },
      invoke: vi.fn() as unknown as InvokeFn,
    });
    expect(path).toBeNull();
    warn.mockRestore();
  });

  it('retries one failed membership read and resolves the route when it recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    let membershipReads = 0;
    const hqProJson = vi.fn(async (_method: 'GET' | 'POST', url: string) => {
      if (url === '/membership/me') {
        membershipReads += 1;
        if (membershipReads === 1) throw new Error('temporary lookup failure');
        return { memberships: [] };
      }
      return { invites: [] };
    });
    const invoke = vi.fn(async () => ({ workspaces: [] }));

    const result = await resolveFirstRunCompanyRoute({
      hqProJson,
      invoke: invoke as unknown as InvokeFn,
      enableMembershipLookupRetry: true,
      sleep,
    });

    expect(hqProJson.mock.calls.filter(([, url]) => url === '/membership/me')).toHaveLength(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(COMPANY_ROUTE_LOOKUP_RETRY_DELAY_MS);
    expect(result).toMatchObject({ route: { kind: 'create', decision: 'create' } });
    expect(invoke).not.toHaveBeenCalledWith('create_company', expect.anything());
    warn.mockRestore();
  });

  it('bypasses a cached malformed membership response on retry and resolves the recovered company route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cachedMembershipRead: Promise<Record<string, unknown>> | null = null;
    let requestCount = 0;
    const hqProJson = vi.fn(() => {
      if (!cachedMembershipRead) {
        requestCount += 1;
        cachedMembershipRead = Promise.resolve(
          requestCount === 1
            ? {}
            : { memberships: [{ companyUid: 'cmp_recovered', status: 'active', role: 'member' }] },
        );
      }
      return cachedMembershipRead;
    });
    const invalidateMembershipMeRead = vi.fn(() => {
      cachedMembershipRead = null;
    });

    const result = await resolveFirstRunCompanyRoute({
      hqProJson,
      invoke: vi.fn() as unknown as InvokeFn,
      enableMembershipLookupRetry: true,
      sleep: async () => {},
      invalidateMembershipMeRead,
    });

    expect(requestCount).toBe(2);
    expect(invalidateMembershipMeRead).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ route: { kind: 'skip', decision: 'joined_existing', company: { companyUid: 'cmp_recovered' } } });
    warn.mockRestore();
  });

  it('returns lookup_failed after two failed reads without creating a company', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const hqProJson = vi.fn(async () => {
      throw new Error('membership lookup unavailable');
    });
    const invoke = vi.fn();

    const result = await resolveFirstRunCompanyRoute({
      hqProJson,
      invoke: invoke as unknown as InvokeFn,
      enableMembershipLookupRetry: true,
      sleep,
    });

    expect(hqProJson).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(COMPANY_ROUTE_LOOKUP_RETRY_DELAY_MS);
    expect(result).toEqual({ kind: 'lookup_failed' });
    expect(invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the original single-read null result when lookup retry is disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hqProJson = vi.fn(async () => {
      throw new Error('membership lookup unavailable');
    });

    const result = await resolveFirstRunCompanyRoute({
      hqProJson,
      invoke: vi.fn() as unknown as InvokeFn,
      enableMembershipLookupRetry: false,
    });

    expect(result).toBeNull();
    expect(hqProJson).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('resumes an owned company whose entity is still provisioning', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'hq_pro_fetch' && args?.url === '/entity/cmp_half') {
        return { status: 200, body: JSON.stringify({ entity: { uid: 'cmp_half', status: 'provisioning' } }) };
      }
      return { workspaces: [] };
    });
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [{ companyUid: 'cmp_half', status: 'active', role: 'owner' }] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(path).toMatchObject({ kind: 'resume', state: 'pending', company: { companyUid: 'cmp_half' } });
  });

  it('does not treat an unreadable entity as half-finished', async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: '{}' }));
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async () => ({ memberships: [{ companyUid: 'cmp_a', status: 'active', role: 'owner' }] }),
      invoke: invoke as unknown as InvokeFn,
    });
    expect(path).toMatchObject({ kind: 'existing', decision: 'offer_existing' });
  });

  it('asks hq-pro about the website visitor only when there is no company', async () => {
    const urls: string[] = [];
    const path = await resolveFirstRunCompanyPath({
      hqProJson: async (_method, url) => {
        urls.push(url);
        if (url === '/membership/me') return { memberships: [] };
        if (url.startsWith('/membership/me?anonId=')) {
          return { webIdentity: { email: 'casey@acme.com', companyName: 'Acme' } };
        }
        return { invites: [] };
      },
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
      signedInEmail: 'casey@gmail.com',
      anonId: 'vyg-1',
    });
    expect(urls).toContain('/membership/me?anonId=vyg-1');
    expect(path).toMatchObject({ kind: 'other-identity', other: { maskedEmail: 'c•••@acme.com', companyName: 'Acme' } });
  });
});

describe('provisioning', () => {
  function entityInvoke(answers: Array<Record<string, unknown> | number>): InvokeFn {
    let i = 0;
    return (async () => {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (typeof answer === 'number') return { status: answer, body: '' };
      return { status: 200, body: JSON.stringify({ entity: answer }) };
    }) as unknown as InvokeFn;
  }

  it('polls through pending (and a 404) until ready', async () => {
    const polls: string[] = [];
    const state = await waitForProvisioning({
      invoke: entityInvoke([404, { uid: 'cmp_a', status: 'provisioning' }, { uid: 'cmp_a', status: 'active', bucketName: 'b' }]),
      companyUid: 'cmp_a',
      sleep: async () => {},
      onPoll: (s) => polls.push(s.status),
    });
    expect(state).toEqual({ status: 'ready', bucketName: 'b' });
    expect(polls).toEqual(['pending', 'pending', 'ready']);
  });

  it('stops on an explicit failed status with the step', async () => {
    const state = await waitForProvisioning({
      invoke: entityInvoke([{ uid: 'cmp_a', provisioningStatus: 'failed', provisioningFailedStep: 'acl-seed:owner-resolve' }]),
      companyUid: 'cmp_a',
      sleep: async () => {},
    });
    expect(state).toEqual({ status: 'failed', step: 'acl-seed:owner-resolve' });
  });

  it('times out as failed step "timeout"', async () => {
    let now = 0;
    const state = await waitForProvisioning({
      invoke: entityInvoke([{ uid: 'cmp_a', status: 'provisioning' }]),
      companyUid: 'cmp_a',
      timeoutMs: 5_000,
      intervalMs: 2_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(state).toEqual({ status: 'failed', step: 'timeout' });
  });

  it('provisions through activate-cloud and names a failed attempt', async () => {
    const invoke = vi.fn(async () => ({ bucketName: 'b' }));
    await expect(requestCompanyProvisioning(invoke as unknown as InvokeFn, 'cmp_a')).resolves.toEqual({
      status: 'ready',
      bucketName: 'b',
    });
    expect(invoke).toHaveBeenCalledWith('activate_company_cloud', { companyUid: 'cmp_a' });
    const accepted = vi.fn(async () => ({ activated: true }));
    await expect(requestCompanyProvisioning(accepted as unknown as InvokeFn, 'cmp_a')).resolves.toEqual({ status: 'pending' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error('[forbidden] Only an owner can do that');
    });
    await expect(requestCompanyProvisioning(failing as unknown as InvokeFn, 'cmp_a')).resolves.toEqual({
      status: 'failed',
      step: 'activate-cloud:forbidden',
    });
    warn.mockRestore();
  });
});

describe('planLimitFromCardError', () => {
  it('reads the native plan-limit tag', () => {
    expect(
      planLimitFromCardError(new Error('[plan-limit url=https://hq.computer/billing/upgrade] Starter includes one company.')),
    ).toEqual({ message: 'Starter includes one company.', upgradeUrl: 'https://hq.computer/billing/upgrade' });
  });

  it('drops an upgrade link to another host and ignores other errors', () => {
    expect(planLimitFromCardError('[plan-limit url=https://evil.example/x] Limit.')).toEqual({
      message: 'Limit.',
      upgradeUrl: null,
    });
    expect(planLimitFromCardError(new Error('[forbidden] nope'))).toBeNull();
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

describe('company provisioning status', () => {
  const answer = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

  it('is ready only when the entity has a bucket and is not provisioning', () => {
    expect(isProvisionedCompanyEntity({ entity: { bucketName: 'hq-vault-cmp-a', status: 'active' } })).toBe(true);
    expect(isProvisionedCompanyEntity({ entity: { bucketName: '', status: 'active' } })).toBe(false);
    expect(isProvisionedCompanyEntity({ entity: { bucketName: 'b', status: 'provisioning' } })).toBe(false);
    expect(isProvisionedCompanyEntity({ entity: { bucketName: 'b', deleted: true } })).toBe(false);
    expect(isProvisionedCompanyEntity(null)).toBe(false);
  });

  it('reads GET /entity/{uid} through hq_pro_fetch', async () => {
    const invoke = vi.fn(async () => answer(200, { entity: { bucketName: 'hq-vault-cmp-a', status: 'active' } }));
    await expect(readCompanyProvisioned(invoke as never, 'cmp_a')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('hq_pro_fetch', { url: '/entity/cmp_a', method: 'GET', body: null });
  });

  it('treats 404 as not ready and other errors as a failed read', async () => {
    await expect(readCompanyProvisioned((async () => answer(404, {})) as never, 'cmp_a')).resolves.toBe(false);
    await expect(readCompanyProvisioned((async () => answer(500, {})) as never, 'cmp_a')).rejects.toThrow('500');
  });

  it('is exposed on the first-run company api', () => {
    expect(typeof createFirstRunCompanyApi(vi.fn() as never).readCompanyProvisioned).toBe('function');
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

describe('company handle from the name', () => {
  const rule = {
    pattern: '^[a-z][a-z0-9-]{1,38}[a-z0-9]$',
    minLength: 3,
    maxLength: 40,
    description: 'Lowercase letters, numbers and dashes.',
  };

  it('slugifies names', () => {
    expect(slugifyCompanyName('Acme Studio')).toBe('acme-studio');
    expect(slugifyCompanyName('  Café  Société!! ')).toBe('cafe-societe');
    expect(slugifyCompanyName('東京')).toBe('');
    expect(slugifyCompanyName('a'.repeat(60))).toHaveLength(40);
  });

  it('uses the plain slug when it fits the rule', () => {
    expect(deriveCompanyHandle('Acme Studio', rule)).toBe('acme-studio');
    expect(deriveCompanyHandle('Acme Studio', null)).toBe('acme-studio');
  });

  it('numbers later attempts for a taken handle', () => {
    expect(deriveCompanyHandle('Acme', rule, 1)).toBe('acme-2');
    expect(deriveCompanyHandle('Acme', rule, 2)).toBe('acme-3');
    expect(deriveCompanyHandle('a'.repeat(60), rule, 1)).toBe(`${'a'.repeat(38)}-2`);
  });

  it('pads a name the rule rejects instead of asking for a handle', () => {
    expect(deriveCompanyHandle('3M', rule)).toBe('hq-3m');
    expect(deriveCompanyHandle('Al', rule)).toBe('al-hq');
  });

  it('is null when the name has nothing to make a handle from', () => {
    expect(deriveCompanyHandle('!!!', rule)).toBeNull();
    expect(deriveCompanyHandle('東京', rule)).toBeNull();
    expect(deriveCompanyHandle('', null)).toBeNull();
  });
});

describe('plan already picked on the website', () => {
  const priorPlanOf = (result: Awaited<ReturnType<typeof resolveFirstRunCompanyRoute>>) =>
    result && 'route' in result ? result.priorPlan : undefined;
  it('reports it alongside the route, and null when nothing was sent', async () => {
    const picked = await resolveFirstRunCompanyRoute({
      hqProJson: async (_method, url) =>
        url === '/membership/me' ? { memberships: [], planIntent: 'free' } : { invites: [] },
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
    });
    expect(priorPlanOf(picked)).toBe('starter');

    const viaVisitor = await resolveFirstRunCompanyRoute({
      hqProJson: async (_method, url) => {
        if (url === '/membership/me') return { memberships: [] };
        if (url.startsWith('/membership/me?anonId=')) return { webIdentity: { samePerson: true, plan: 'team' } };
        return { invites: [] };
      },
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
      anonId: 'anon_1',
    });
    expect(priorPlanOf(viaVisitor)).toBe('workforce');

    const none = await resolveFirstRunCompanyRoute({
      hqProJson: async (_method, url) => (url === '/membership/me' ? { memberships: [] } : { invites: [] }),
      invoke: (async () => ({ workspaces: [] })) as unknown as InvokeFn,
    });
    expect(priorPlanOf(none)).toBeNull();
  });
});
