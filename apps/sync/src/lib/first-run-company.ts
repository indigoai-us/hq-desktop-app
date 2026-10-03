/**
 * First-run company step: name a company, invite people, pick a plan.
 *
 * The website (hqforwork.com/welcome) now only signs people in and sends them
 * to the download. Nobody arrives here with a company made for them, so the
 * wizard has to make one. It does that the same way the in-app create-company
 * modal does: it drives the server's `create_company` lifecycle card in #setup
 * (`openCreateCompanyDraft` / `submitCreateCompany` from `@hq/ui`). There is no
 * second create route to drift from.
 *
 * Workforce is a Stripe checkout minted by `POST /v1/billing/checkout/team`
 * with the strict `hq-desktop://setup` return pair hq-pro accepts
 * (src/billing/team-return-url.ts). The success URL lands on the existing
 * deep-link handler, which opens #setup for the company.
 *
 * Everything here is headless so each branch is unit-testable.
 */
import {
  normalizeConversationMessages,
  timelinePageFromPayload,
  type CreateCompanyApi,
} from '@hq/ui';
import { pendingInviteWorkspaces, type Workspace, type WorkspacesResult } from './workspaces';

export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type HqProJsonFn = (
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** One pending invite the person can accept from the wizard. */
export interface FirstRunInvite {
  slug: string;
  displayName: string;
}

/**
 * Which company screen the person needs:
 * - `existing`: already an active member somewhere. Nothing to do here.
 * - `join`: no company, but someone invited them. Offer to join.
 * - `create`: no company and no invite. Name one.
 */
export type FirstRunCompanyPath =
  | { kind: 'existing'; companyUids: string[] }
  | { kind: 'join'; invites: FirstRunInvite[] }
  | { kind: 'create' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Active `cmp_*` company uids from a `/membership/me` payload, or null when unreadable. */
export function activeCompanyUids(payload: Record<string, unknown>): string[] | null {
  const rows = payload.memberships;
  if (!Array.isArray(rows) || !rows.every(isRecord)) return null;
  const uids = rows
    .filter(
      (row) =>
        row.status === 'active' &&
        typeof row.companyUid === 'string' &&
        row.companyUid.startsWith('cmp_'),
    )
    .map((row) => row.companyUid as string);
  return [...new Set(uids)];
}

export function invitesFromWorkspaces(workspaces: readonly Workspace[]): FirstRunInvite[] {
  return pendingInviteWorkspaces([...workspaces]).map((workspace) => ({
    slug: workspace.slug,
    displayName: workspace.displayName || workspace.slug,
  }));
}

/**
 * Decide the company screen. Returns null when membership can't be read: the
 * wizard then skips the step and the seeded create-company card in #setup is
 * still there in the app, so a failed lookup never strands anyone.
 */
export async function resolveFirstRunCompanyPath(deps: {
  hqProJson: HqProJsonFn;
  invoke: InvokeFn;
}): Promise<FirstRunCompanyPath | null> {
  let uids: string[] | null;
  try {
    uids = activeCompanyUids(await deps.hqProJson('GET', '/membership/me'));
  } catch (error) {
    console.warn('onboarding: company step membership lookup failed', error);
    return null;
  }
  if (uids === null) return null;
  if (uids.length > 0) return { kind: 'existing', companyUids: uids };

  try {
    const result = await deps.invoke<WorkspacesResult>('list_syncable_workspaces');
    const invites = invitesFromWorkspaces(result?.workspaces ?? []);
    if (invites.length > 0) return { kind: 'join', invites };
  } catch (error) {
    // The invite list is a nicety; a person with no company can still make one.
    console.warn('onboarding: pending invite lookup failed; offering create', error);
  }
  return { kind: 'create' };
}

/** The create-company seam over the native commands the app shell also uses. */
export function createFirstRunCompanyApi(invoke: InvokeFn): CreateCompanyApi {
  return {
    runCardAction: async (args) => {
      const raw = await invoke<Record<string, unknown> | undefined>('run_card_action', {
        channelId: args.channelId,
        cardId: args.cardId,
        actionId: args.actionId,
        values: args.values,
        idempotencyKey: args.idempotencyKey ?? null,
      });
      const str = (key: string) => (typeof raw?.[key] === 'string' ? (raw[key] as string) : undefined);
      return {
        cardId: str('cardId') ?? args.cardId,
        actionId: str('actionId') ?? args.actionId,
        eventId: str('eventId'),
        state: str('state') ?? '',
        fields: raw?.fields,
        replayed: raw?.replayed === true,
        companyUid: str('companyUid'),
        companyChannelId: str('companyChannelId'),
        channelId: str('channelId'),
        reason: str('reason'),
        url: str('url'),
      };
    },
    fetchChannel: async (args) => {
      const raw = await invoke<unknown>('fetch_channel', {
        channelId: args.channelId,
        limit: args.limit,
        cursor: args.cursor ?? null,
      });
      const page = timelinePageFromPayload(raw);
      return {
        messages: normalizeConversationMessages(page.messages),
        nextCursor: page.nextCursor ?? null,
      };
    },
    checkCompanySlug: (slug) => invoke<unknown>('check_company_slug', { slug }),
    readCompanyProvisioned: (companyUid) => readCompanyProvisioned(invoke, companyUid),
    activateCompanyCloud: (companyUid) =>
      invoke<unknown>('activate_company_cloud', { companyUid }),
    runCompanyTabAction: async (args) =>
      invoke('run_company_tab_action', {
        companyUid: args.companyUid,
        tab: args.tab,
        cardId: args.cardId,
        actionId: args.actionId,
        values: args.values,
        idempotencyKey: args.idempotencyKey ?? null,
      }),
  };
}

/**
 * Whether a `GET /entity/{uid}` payload describes a provisioned company: the
 * provisioning Lambda sets `bucketName` and moves `status` off "provisioning".
 */
export function isProvisionedCompanyEntity(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.entity)) return false;
  const entity = payload.entity;
  return (
    typeof entity.bucketName === 'string' &&
    entity.bucketName.trim().length > 0 &&
    entity.status !== 'provisioning' &&
    entity.deleted !== true
  );
}

/** Read the company entity and report whether its cloud vault is provisioned. */
export async function readCompanyProvisioned(invoke: InvokeFn, companyUid: string): Promise<boolean> {
  const response = await invoke<unknown>('hq_pro_fetch', {
    url: `/entity/${encodeURIComponent(companyUid)}`,
    method: 'GET',
    body: null,
  });
  if (!isRecord(response) || typeof response.status !== 'number') {
    throw new Error('hq-pro returned an invalid response');
  }
  // 404 right after creation is "not visible yet", not an error.
  if (response.status === 404) return false;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`hq-pro entity read failed with status ${response.status}`);
  }
  const body = typeof response.body === 'string' && response.body.trim() ? JSON.parse(response.body) : null;
  return isProvisionedCompanyEntity(body);
}

/**
 * Split the invite box into addresses. Commas, semicolons, spaces and new
 * lines all separate; duplicates and the obviously-not-an-email drop out.
 */
export function parseInviteEmails(raw: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254) valid.push(email);
    else invalid.push(email);
  }
  return { valid, invalid };
}

export type FirstRunPlan = 'starter' | 'workforce';

export const WORKFORCE_PRICE_LABEL = '$500/mo';

/** The return pair hq-pro's team checkout accepts for the desktop app. */
export function workforceCheckoutBody(companyUid: string): Record<string, string> {
  return {
    companyUid,
    successUrl: `hq-desktop://setup?checkout=done&company=${encodeURIComponent(companyUid)}`,
    cancelUrl: 'hq-desktop://setup',
  };
}

/** Only a Stripe-hosted https checkout page is opened in the browser. */
export function approvedCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'checkout.stripe.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type WorkforceCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export const CHECKOUT_DISABLED_REASON =
  'Workforce sign-up is paused right now. You can start on Starter and upgrade later from #setup.';
export const CHECKOUT_FAILED_REASON =
  'HQ could not open checkout. Try again, or start on Starter and upgrade later from #setup.';

/** Mint the Workforce checkout for a company the person owns. */
export async function startWorkforceCheckout(
  invoke: InvokeFn,
  companyUid: string,
): Promise<WorkforceCheckoutResult> {
  let response: unknown;
  try {
    response = await invoke<unknown>('hq_pro_fetch', {
      url: '/v1/billing/checkout/team',
      method: 'POST',
      body: JSON.stringify(workforceCheckoutBody(companyUid)),
    });
  } catch (error) {
    console.warn('onboarding: workforce checkout request failed', error);
    return { ok: false, reason: CHECKOUT_FAILED_REASON };
  }
  if (!isRecord(response) || typeof response.status !== 'number') {
    console.warn('onboarding: workforce checkout returned an invalid response');
    return { ok: false, reason: CHECKOUT_FAILED_REASON };
  }
  let payload: unknown = null;
  try {
    payload = typeof response.body === 'string' && response.body.trim() ? JSON.parse(response.body) : null;
  } catch (error) {
    console.warn('onboarding: workforce checkout body was not JSON', error);
  }
  if (response.status === 503 && isRecord(payload) && payload.code === 'team_signup_disabled') {
    return { ok: false, reason: CHECKOUT_DISABLED_REASON };
  }
  if (response.status < 200 || response.status >= 300) {
    console.warn(`onboarding: workforce checkout failed with status ${response.status}`);
    return { ok: false, reason: CHECKOUT_FAILED_REASON };
  }
  const url = approvedCheckoutUrl(isRecord(payload) ? payload.url : null);
  if (!url) {
    console.warn('onboarding: workforce checkout answered without a Stripe url');
    return { ok: false, reason: CHECKOUT_FAILED_REASON };
  }
  return { ok: true, url };
}

/**
 * Read the `messages:open-setup` event the deep-link handler emits for
 * `hq-desktop://setup?...`. True only for a finished checkout of THIS company.
 */
export function isCheckoutReturnFor(payload: unknown, companyUid: string): boolean {
  if (!isRecord(payload)) return false;
  return payload.companyUid === companyUid && payload.checkout === 'done';
}
