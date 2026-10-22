import { describe, expect, it } from 'vitest';
import {
  endPlanLimitPauses,
  loadPlanLimitNotifications,
  markAllPlanLimitNotificationsRead,
  markPlanLimitNotificationRead,
  planLimitBannerAllowed,
  planLimitNativeBanner,
  PLAN_LIMIT_HISTORY_CAP,
  recordPlanLimitPauses,
  resolvePlanLimitCompanyUids,
  savePlanLimitNotifications,
  statusPushFilesPause,
  usagePauseFromReason,
} from './plan-limit-notifications';

const URL_A = 'https://hq.computer/companies/acme/billing?entrySurface=desktop_limit';
let seq = 0;
const nonce = () => `n${(seq += 1)}`;

function pause(company: string, upgradeUrl: string | null = URL_A, companyUid: string | null = null) {
  return { company, upgradeUrl, companyUid };
}

describe('plan-limit notifications', () => {
  it('opens one row per company per paused episode', () => {
    const first = recordPlanLimitPauses([], [pause('acme'), pause('beta'), pause('acme')], 1, nonce);
    expect(first.created.map((row) => row.company)).toEqual(['acme', 'beta']);
    expect(first.rows).toHaveLength(2);
    expect(first.rows.every((row) => row.status === 'unread' && row.active)).toBe(true);
    expect(first.rows.find((row) => row.company === 'acme')?.title).toBe(
      'New files are paused for acme.',
    );

    const again = recordPlanLimitPauses(first.rows, [pause('acme'), pause('beta')], 2, nonce);
    expect(again.created).toEqual([]);
    expect(again.rows).toEqual(first.rows);

    const ended = endPlanLimitPauses(again.rows, ['acme']);
    const repaused = recordPlanLimitPauses(ended, [pause('acme')], 3, nonce);
    expect(repaused.created).toHaveLength(1);
    expect(repaused.rows.filter((row) => row.company === 'acme')).toHaveLength(2);
  });

  it('updates the open row when the link or company uid arrives later', () => {
    const { rows } = recordPlanLimitPauses([], [pause('acme', null)], 1, nonce);
    expect(rows[0].targetRef).toBeNull();
    const next = recordPlanLimitPauses(rows, [pause('acme', URL_A, 'cmp_acme')], 2, nonce);
    expect(next.created).toEqual([]);
    expect(next.rows[0]).toMatchObject({ targetRef: URL_A, companyUid: 'cmp_acme', id: rows[0].id });

    const resolved = resolvePlanLimitCompanyUids(
      recordPlanLimitPauses([], [pause('beta')], 1, nonce).rows,
      (company) => (company === 'beta' ? 'cmp_beta' : null),
    );
    expect(resolved[0].companyUid).toBe('cmp_beta');
  });

  it('marks rows read one at a time or all at once', () => {
    const { rows } = recordPlanLimitPauses([], [pause('a'), pause('b')], 1, nonce);
    const one = markPlanLimitNotificationRead(rows, rows[0].id);
    expect(one.map((row) => row.status)).toEqual(['read', 'unread']);
    expect(markAllPlanLimitNotificationsRead(one).map((row) => row.status)).toEqual(['read', 'read']);
  });

  it('caps history and keeps open episodes over old ended ones', () => {
    let rows = recordPlanLimitPauses(
      [],
      Array.from({ length: PLAN_LIMIT_HISTORY_CAP }, (_, i) => pause(`old-${i}`)),
      1,
      nonce,
    ).rows;
    rows = endPlanLimitPauses(rows, rows.map((row) => row.company));
    const next = recordPlanLimitPauses(rows, [pause('new')], 2, nonce);
    expect(next.rows).toHaveLength(PLAN_LIMIT_HISTORY_CAP);
    expect(next.rows.some((row) => row.company === 'new' && row.active)).toBe(true);
  });

  it('summarizes a pass into one OS banner', () => {
    const one = recordPlanLimitPauses([], [pause('acme')], 1, nonce).created;
    expect(planLimitNativeBanner(one)?.title).toBe('New files are paused for acme.');
    const many = recordPlanLimitPauses(
      [],
      Array.from({ length: 13 }, (_, i) => pause(`c${i}`)),
      1,
      nonce,
    ).created;
    expect(planLimitNativeBanner(many)?.title).toBe('New files are paused for 13 companies.');
    expect(planLimitNativeBanner([])).toBeNull();
  });

  it('follows the notification pause and the Files toggle for the OS banner', () => {
    const now = Date.parse('2026-10-02T18:00:00Z');
    expect(planLimitBannerAllowed(null, now)).toBe(true);
    expect(planLimitBannerAllowed({ pausedUntil: 'forever', files: true }, now)).toBe(false);
    expect(planLimitBannerAllowed({ pausedUntil: '2026-10-02T19:00:00Z', files: true }, now)).toBe(false);
    expect(planLimitBannerAllowed({ pausedUntil: '2026-10-02T17:00:00Z', files: true }, now)).toBe(true);
    expect(planLimitBannerAllowed({ pausedUntil: null, files: false }, now)).toBe(false);
  });

  it('stores rows per account and ignores malformed storage', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
    const { rows } = recordPlanLimitPauses([], [pause('acme')], 1, nonce);
    savePlanLimitNotifications(storage, 'acct_a', rows);
    expect(loadPlanLimitNotifications(storage, 'acct_a')).toEqual(rows);
    expect(loadPlanLimitNotifications(storage, 'acct_b')).toEqual([]);
    expect(loadPlanLimitNotifications(storage, null)).toEqual([]);
    map.set('hq.desktop.planLimitNotifications.v1:acct_c', '{not json');
    expect(loadPlanLimitNotifications(storage, 'acct_c')).toEqual([]);
    map.set('hq.desktop.planLimitNotifications.v1:acct_d', JSON.stringify([{ id: 'dm:x' }]));
    expect(loadPlanLimitNotifications(storage, 'acct_d')).toEqual([]);
  });
});

describe('statusPushFilesPause (usage-limits body -> "files are paused" row)', () => {
  const free = {
    plan: 'free',
    cohort: 'enforceable',
    upgradeUrl: URL_A,
    users: { used: 1, limit: 5, pctUsed: 20, over: false },
    storageBytes: { used: 5_000_000, limit: 10_737_418_240, pctUsed: 0.05, over: false },
  };

  it('does not pause on a zero-capacity resource read as 100% (2026-10-07 fan-out)', () => {
    // hq-pro read free agents 0/0 as pctUsed 100 and the shell announced
    // "New files are paused" for every free company a person belonged to.
    const body = { ...free, agents: { used: 0, limit: 0, pctUsed: 100, over: false } };
    expect(statusPushFilesPause(body)).toEqual({ paused: false });
  });

  it('does not pause on a warning level or an over row on a non-file cap', () => {
    expect(
      statusPushFilesPause({ ...free, users: { used: 4, limit: 5, pctUsed: 80, over: false } }),
    ).toEqual({ paused: false });
    expect(
      statusPushFilesPause({ ...free, secrets: { used: 11, limit: 10, pctUsed: 110, over: true } }),
    ).toEqual({ paused: false });
    expect(
      statusPushFilesPause({ ...free, armedStops: ['secrets.create', 'members.create'] }),
    ).toEqual({ paused: false });
  });

  it('pauses only when hq-pro arms the files.create stop, carrying its upgrade link', () => {
    expect(statusPushFilesPause({ ...free, armedStops: ['files.create'] })).toEqual({
      paused: true,
      upgradeUrl: URL_A,
    });
    expect(
      statusPushFilesPause({ planLimits: { ...free, armedStops: ['secrets.create', 'files.create'] } }),
    ).toEqual({ paused: true, upgradeUrl: URL_A });
    expect(statusPushFilesPause({ ...free, upgradeUrl: undefined, armedStops: ['files.create'] })).toEqual({
      paused: true,
      upgradeUrl: undefined,
    });
  });

  it('never pauses a paid, grandfathered or exempt company even with an armed stop', () => {
    const armedStops = ['files.create'];
    expect(statusPushFilesPause({ ...free, plan: 'team', armedStops })).toEqual({ paused: false });
    expect(statusPushFilesPause({ ...free, cohort: 'grandfathered', armedStops })).toEqual({ paused: false });
    expect(statusPushFilesPause({ ...free, planLimitsExempt: true, armedStops })).toEqual({ paused: false });
  });

  it('never pauses on a malformed body', () => {
    expect(statusPushFilesPause(null)).toEqual({ paused: false });
    expect(statusPushFilesPause('paused')).toEqual({ paused: false });
    expect(statusPushFilesPause({ armedStops: 'files.create' })).toEqual({ paused: false });
  });
});

describe('usage pause rows (US-024)', () => {
  const BILLING = 'https://hq.computer/companies/acme/billing';
  const MESSAGE =
    'Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.';
  const retired = /plan limit|upgrade|Starter|Workforce|Individual/i;

  it('titles and bodies a usage pause without plan or upgrade wording', () => {
    const { rows, created } = recordPlanLimitPauses(
      [],
      [{ company: 'Acme', companyUid: 'cmp_acme', upgradeUrl: BILLING, usagePause: { reason: 'usage_card_required', message: MESSAGE } }],
      1_000,
      nonce,
    );
    expect(created).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Cloud sync is paused for Acme.',
      body: `${MESSAGE} Open to go to Billing.`,
      targetRef: BILLING,
      usageMessage: MESSAGE,
    });
    expect(`${rows[0].title} ${rows[0].body}`).not.toMatch(retired);
    const banner = planLimitNativeBanner(created)!;
    expect(banner).toEqual({ title: 'Cloud sync is paused for Acme.', body: MESSAGE });
    expect(`${banner.title} ${banner.body}`).not.toMatch(retired);
  });

  it('turns an open legacy row into a usage row when the pause turns out to be usage', () => {
    const first = recordPlanLimitPauses([], [pause('Acme')], 1_000, nonce).rows;
    const { rows } = recordPlanLimitPauses(
      first,
      [{ company: 'Acme', companyUid: null, upgradeUrl: BILLING, usagePause: { reason: 'usage_spend_limit', message: MESSAGE } }],
      2_000,
      nonce,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Cloud sync is paused for Acme.');
    expect(rows[0].body).not.toMatch(retired);
  });

  it('banners several usage pauses without upgrade wording', () => {
    const { created } = recordPlanLimitPauses(
      [],
      ['A', 'B'].map((company) => ({ company, companyUid: null, upgradeUrl: null, usagePause: usagePauseFromReason('usage_spend_limit', company) })),
      1_000,
      nonce,
    );
    const banner = planLimitNativeBanner(created)!;
    expect(banner.title).toBe('Cloud sync is paused for 2 companies.');
    expect(banner.body).not.toMatch(retired);
  });

  it('status push reads billingState first', () => {
    const paused = {
      plan: 'free',
      cohort: 'enforceable',
      armedStops: [],
      billingState: { version: 1, kind: 'usage', scope: 'company', view: 'full', paused: { reason: 'usage_card_required', resumesOn: null } },
    };
    expect(statusPushFilesPause(paused)).toEqual({
      paused: true,
      upgradeUrl: null,
      usageReason: 'usage_card_required',
      usageContext: { resumesOn: null, cardOnFile: null, addCard: false, message: null },
    });
    // A usage company is never paused by the Starter fields.
    const notPaused = {
      plan: 'free',
      cohort: 'enforceable',
      armedStops: ['files.create'],
      upgradeUrl: URL_A,
      billingState: { version: 1, kind: 'usage-trial', scope: 'company', view: 'full', paused: null },
    };
    expect(statusPushFilesPause(notPaused)).toEqual({ paused: false });
    // Without billingState the legacy fields still decide.
    expect(statusPushFilesPause({ ...notPaused, billingState: undefined })).toEqual({ paused: true, upgradeUrl: URL_A });
    expect(usagePauseFromReason('usage_spend_limit', 'Acme').message).not.toMatch(retired);
  });

  it('regression #1773: a status-push trial cap with a card on file says when it resumes, not to add a card', () => {
    const resumesOn = '2026-11-15T13:00:00Z';
    const body = {
      billingState: {
        version: 1, kind: 'usage-trial', scope: 'company', view: 'full', cardOnFile: true,
        paused: { reason: 'usage_trial_cap', resumesOn },
        actions: { addCard: false, raiseLimit: true, switchToUsage: false, manageBilling: true },
      },
    };
    const pause = statusPushFilesPause(body);
    if (!pause.paused || !pause.usageReason) throw new Error('expected a usage pause');
    const message = usagePauseFromReason(pause.usageReason, 'Unicom', pause.usageContext).message;
    const day = new Date(resumesOn).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(message).not.toMatch(/add a card/i);
    expect(message).toContain(`Usage is paused until ${day}, when the trial ends.`);
  });

  it('review #1773: a status-push carded trial cap with resumesOn null resumes at the first invoice and points owners to Billing', () => {
    const body = {
      billingState: {
        version: 1, kind: 'usage-trial', scope: 'company', view: 'full', cardOnFile: true,
        trial: { daysLeft: 0, endsAt: '2026-11-03T00:00:00Z', capCents: 50000, usedCents: 50000 },
        paused: { reason: 'usage_trial_cap', resumesOn: null },
        actions: { addCard: false, raiseLimit: true, switchToUsage: false, manageBilling: true },
      },
    };
    const pause = statusPushFilesPause(body);
    if (!pause.paused || !pause.usageReason) throw new Error('expected a usage pause');
    const owner = usagePauseFromReason(pause.usageReason, 'Unicom', { ...pause.usageContext, canManageBilling: true }).message;
    expect(owner).toBe(
      'Cloud sync is paused. Unicom used the usage included in its trial. Usage resumes when the first invoice is paid. Open Billing for Unicom for details. Files on this computer are not affected.',
    );
    expect(owner).not.toMatch(/trial ends|Nov 3|add a card/i);
    const member = usagePauseFromReason(pause.usageReason, 'Unicom', { ...pause.usageContext, canManageBilling: false }).message;
    expect(member).toContain('Usage resumes when the first invoice is paid.');
    expect(member).not.toContain('Open Billing');
    // The row carries the Billing link when the body had one.
    const { created } = recordPlanLimitPauses(
      [],
      [{ company: 'Unicom', companyUid: null, upgradeUrl: BILLING, usagePause: { reason: 'usage_trial_cap', message: owner } }],
      1_000,
      nonce,
    );
    expect(created[0].targetRef).toBe(BILLING);
    expect(created[0].body).toBe(`${owner} Open to go to Billing.`);
  });

  it('control: a status-push pause that offers Add a card with no card on file keeps the add-card copy', () => {
    const body = {
      billingState: {
        version: 1, kind: 'usage-trial', scope: 'company', view: 'full', cardOnFile: false,
        paused: { reason: 'usage_trial_cap', resumesOn: null },
        actions: { addCard: true, raiseLimit: false, switchToUsage: false, manageBilling: false },
      },
    };
    const pause = statusPushFilesPause(body);
    if (!pause.paused || !pause.usageReason) throw new Error('expected a usage pause');
    expect(usagePauseFromReason(pause.usageReason, 'Unicom', pause.usageContext).message).toContain('Add a card on the Billing page to resume.');
  });

  it('control: the server usagePause message and Billing link win in a status push', () => {
    const body = {
      upgradeUrl: URL_A,
      usagePause: { code: 'usage_paused', reason: 'usage_trial_cap', message: MESSAGE, actionUrl: BILLING },
      billingState: { version: 1, kind: 'usage-trial', scope: 'company', view: 'full', paused: { reason: 'usage_trial_cap', resumesOn: null }, actions: { addCard: true } },
    };
    const pause = statusPushFilesPause(body);
    if (!pause.paused || !pause.usageReason) throw new Error('expected a usage pause');
    expect(pause.upgradeUrl).toBe(BILLING);
    expect(usagePauseFromReason(pause.usageReason, 'Acme', pause.usageContext).message).toBe(MESSAGE);
  });

  it('with no billing state the built sentence never asks for a card', () => {
    expect(usagePauseFromReason('usage_trial_cap', 'Acme').message).not.toMatch(/add a card/i);
    expect(usagePauseFromReason('usage_card_required', 'Acme').message).not.toMatch(/add a card/i);
  });
});
