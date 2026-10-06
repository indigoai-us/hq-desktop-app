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
  localSlugProblem,
  normalizeConversationMessages,
  timelinePageFromPayload,
  type CreateCompanyApi,
  type SlugConstraints,
} from '@hq/ui';
import { pendingInviteWorkspaces, type WorkspacesResult } from './workspaces';
import {
  activeMembershipCompanies,
  decideCompanyRoute,
  inviteOffers,
  otherIdentityFromLookup,
  priorPlanFromPayload,
  provisioningStateFromEntity,
  summarizeRoute,
  type CompanyRoute,
  type CompanyRouteSummary,
  type OtherIdentityCompany,
  type PriorPlanChoice,
  type ProvisioningState,
} from './onboarding-company-route';

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
 * Which company screen the person needs. See `decideCompanyRoute`:
 * - `skip`: a paid company, or one they already joined. Select it and move on.
 * - `existing`: they own a company. "Use <name>" or "Create another".
 * - `join`: a pending invite (or one sent to another email, or expired).
 * - `create`: nothing yet. Name one.
 */
export type FirstRunCompanyPath = CompanyRoute;

export const COMPANY_ROUTE_LOOKUP_RETRY_DELAY_MS = 250;

export interface CompanyRouteLookupFailed {
  kind: 'lookup_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Active `cmp_*` company uids from a `/membership/me` payload, or null when unreadable. */
export function activeCompanyUids(payload: Record<string, unknown>): string[] | null {
  const companies = activeMembershipCompanies(payload);
  return companies === null ? null : companies.map((company) => company.companyUid);
}

export interface ResolvedCompanyRoute {
  route: CompanyRoute;
  summary: CompanyRouteSummary;
  /**
   * The plan the person already picked on the website, when hq-pro says so
   * (`priorPlanFromPayload`). Null means unknown: the step asks.
   */
  priorPlan: PriorPlanChoice | null;
}

export type FirstRunCompanyRouteResult = ResolvedCompanyRoute | CompanyRouteLookupFailed;

export type CompanyRouteRetrySleep = (delayMs: number) => Promise<void>;
export type CompanyRouteRetryGate = boolean | Promise<boolean>;

function waitForCompanyRouteRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Look before creating. A retry is optional and only runs after the first
 * unreadable lookup when the caller's flag gate resolves true. A second
 * failure is distinct so the wizard can preserve its #setup recovery path;
 * neither failure ever creates a company.
 */
export async function resolveFirstRunCompanyRoute(deps: {
  hqProJson: HqProJsonFn;
  invoke: InvokeFn;
  signedInEmail?: string | null;
  /** Website visitor id (download tag / sign-in link), for the other-account lookup. */
  anonId?: string | null;
  now?: () => number;
  enableMembershipLookupRetry?: CompanyRouteRetryGate;
  sleep?: CompanyRouteRetrySleep;
  /** Drop a fulfilled but unreadable cached response before issuing the retry. */
  invalidateMembershipMeRead?: () => void;
}): Promise<FirstRunCompanyRouteResult | null> {
  let retryEnabled = deps.enableMembershipLookupRetry ?? false;
  const retryIsEnabled = async (): Promise<boolean> => {
    if (typeof retryEnabled === 'boolean') return retryEnabled;
    try {
      retryEnabled = await retryEnabled;
    } catch (error) {
      console.warn('onboarding: company route lookup retry flag failed; leaving retry off', error);
      retryEnabled = false;
    }
    return retryEnabled === true;
  };
  let me: Record<string, unknown> | null = null;
  let listed: ReturnType<typeof activeMembershipCompanies> = null;
  let lastLookupError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const candidate = await deps.hqProJson('GET', '/membership/me');
      const memberships = activeMembershipCompanies(candidate);
      if (memberships !== null) {
        me = candidate;
        listed = memberships;
        break;
      }
      lastLookupError = new Error('membership lookup returned an unreadable payload');
      deps.invalidateMembershipMeRead?.();
    } catch (error) {
      lastLookupError = error;
    }
    console.warn('onboarding: company step membership lookup failed', lastLookupError);
    if (attempt === 0 && await retryIsEnabled()) {
      await (deps.sleep ?? waitForCompanyRouteRetry)(COMPANY_ROUTE_LOOKUP_RETRY_DELAY_MS);
      continue;
    }
    if (attempt === 0) return null;
  }
  if (me === null || listed === null) {
    return { kind: 'lookup_failed' };
  }
  // Resume half-finished setup: an owned company with no bucket on the
  // membership row and no explicit status gets one entity read.
  const companies = await Promise.all(
    listed.map(async (company) => {
      if (company.provisioning !== null || company.bucketName !== null) return company;
      if (company.role !== null && company.role !== 'owner') return company;
      try {
        const state = await readKnownProvisioningState(deps.invoke, company.companyUid);
        if (state === null) return company;
        return {
          ...company,
          provisioning: state.status,
          provisioningFailedStep: state.status === 'failed' ? state.step : null,
        };
      } catch (error) {
        console.warn('onboarding: provisioning status read failed', error);
        return company;
      }
    }),
  );
  const now = deps.now?.() ?? Date.now();
  const signedInEmail = deps.signedInEmail ?? null;

  let inviteRows: unknown[] = Array.isArray(me.pendingInvites) ? [...me.pendingInvites] : [];
  if (companies.length === 0) {
    try {
      const pending = await deps.hqProJson('GET', '/membership/pending-by-email');
      if (Array.isArray(pending.invites)) inviteRows = inviteRows.concat(pending.invites);
    } catch (error) {
      console.warn('onboarding: pending-by-email lookup failed', error);
    }
    try {
      const result = await deps.invoke<WorkspacesResult>('list_syncable_workspaces');
      // Workspace rows add names/slugs for the same invites; offers dedupe by uid.
      const byUid = new Map(
        pendingInviteWorkspaces([...(result?.workspaces ?? [])]).map((workspace) => [workspace.cloudUid ?? `slug:${workspace.slug}`, workspace]),
      );
      inviteRows = inviteRows.map((row) => {
        if (!isRecord(row) || typeof row.companyUid !== 'string') return row;
        const workspace = byUid.get(row.companyUid);
        return workspace
          ? { companySlug: workspace.slug, companyName: workspace.displayName || workspace.slug, ...row }
          : row;
      });
      for (const workspace of byUid.values()) {
        inviteRows.push({
          companyUid: workspace.cloudUid ?? undefined,
          companySlug: workspace.slug,
          companyName: workspace.displayName || workspace.slug,
        });
      }
    } catch (error) {
      // The invite list is a nicety; a person with no company can still make one.
      console.warn('onboarding: pending invite lookup failed', error);
    }
  }
  const invites = inviteOffers(inviteRows, now);
  let otherIdentity: OtherIdentityCompany | null = null;
  let priorPlan = priorPlanFromPayload(me);
  if (companies.length === 0 && deps.anonId) {
    // Different sign-in identity: the website visitor may have made a company
    // under another account. hq-pro resolves it via marketing_identity_linked.
    try {
      const lookup = await deps.hqProJson('GET', `/membership/me?anonId=${encodeURIComponent(deps.anonId)}`);
      otherIdentity = otherIdentityFromLookup(lookup, signedInEmail);
      priorPlan = priorPlan ?? priorPlanFromPayload(lookup);
    } catch (error) {
      console.warn('onboarding: visitor identity lookup failed', error);
    }
  }
  const route = decideCompanyRoute({ companies, invites, signedInEmail, otherIdentity });
  return { route, summary: summarizeRoute(route, companies, invites), priorPlan };
}

/** Back-compat wrapper: just the route. */
export async function resolveFirstRunCompanyPath(deps: {
  hqProJson: HqProJsonFn;
  invoke: InvokeFn;
  signedInEmail?: string | null;
  anonId?: string | null;
}): Promise<FirstRunCompanyPath | null> {
  const result = await resolveFirstRunCompanyRoute(deps);
  return result && 'route' in result ? result.route : null;
}

async function hqProFetch(
  invoke: InvokeFn,
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await invoke<unknown>('hq_pro_fetch', {
    url,
    method,
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!isRecord(response) || typeof response.status !== 'number') {
    throw new Error('hq-pro returned an invalid response');
  }
  let parsed: unknown = null;
  try {
    parsed = typeof response.body === 'string' && response.body.trim() ? JSON.parse(response.body) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/** Current provisioning state of a company from `GET /entity/{uid}`. 404 right after create is pending. */
async function readProvisioningState(invoke: InvokeFn, companyUid: string): Promise<ProvisioningState> {
  const response = await hqProFetch(invoke, 'GET', `/entity/${encodeURIComponent(companyUid)}`);
  if (response.status === 404) return { status: 'pending' };
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`hq-pro entity read failed with status ${response.status}`);
  }
  return provisioningStateFromEntity(response.body);
}

/**
 * Like `readProvisioningState`, but null unless the entity read named a real
 * entity (a `uid`): a missing or empty answer is unknown, never "pending".
 * Used to decide whether to resume setup, where a guess must not win.
 */
async function readKnownProvisioningState(
  invoke: InvokeFn,
  companyUid: string,
): Promise<ProvisioningState | null> {
  const response = await hqProFetch(invoke, 'GET', `/entity/${encodeURIComponent(companyUid)}`);
  if (response.status < 200 || response.status >= 300) return null;
  const body = response.body;
  const entity = isRecord(body) && isRecord(body.entity) ? body.entity : null;
  if (!entity || entity.uid !== companyUid) return null;
  return provisioningStateFromEntity(body);
}

/**
 * Ask hq-pro to provision (or idempotently confirm) the company vault through
 * the same owner-only route the create flow and the console use:
 * `POST /v1/companies/{uid}/activate-cloud` (`activate_company_cloud`). Used for
 * retry, resume and self-heal; it never creates a company. Success means the
 * server accepted the work, so the caller still polls the entity for ready.
 */
export async function requestCompanyProvisioning(invoke: InvokeFn, companyUid: string): Promise<ProvisioningState> {
  try {
    const answer = await invoke<unknown>('activate_company_cloud', { companyUid });
    const bucketName =
      isRecord(answer) && typeof answer.bucketName === 'string' && answer.bucketName.trim() ? answer.bucketName : null;
    return bucketName ? { status: 'ready', bucketName } : { status: 'pending' };
  } catch (error) {
    console.warn('onboarding: provisioning request failed', error);
    return { status: 'failed', step: activateFailureStep(error) };
  }
}

/** `activate-cloud`, or `activate-cloud:<tag>` for a tagged native error like `[forbidden] …`. */
function activateFailureStep(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const tag = /^\[([a-z_-]{1,32})\]/i.exec(raw.trim())?.[1]?.toLowerCase();
  return tag ? `activate-cloud:${tag}` : 'activate-cloud';
}

export interface WaitForProvisioningOptions {
  invoke: InvokeFn;
  companyUid: string;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop early (component torn down). */
  cancelled?: () => boolean;
  onPoll?: (state: ProvisioningState, attempt: number) => void;
}

const PROVISIONING_POLL_INTERVAL_MS = 2_000;
const PROVISIONING_TIMEOUT_MS = 120_000;

/**
 * Poll until the company is ready or failed. A timeout reports
 * `failed` with step `timeout`; read errors keep polling until the deadline.
 */
export async function waitForProvisioning(options: WaitForProvisioningOptions): Promise<ProvisioningState> {
  const interval = options.intervalMs ?? PROVISIONING_POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? PROVISIONING_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeout;
  let lastError = false;
  for (let attempt = 1; ; attempt += 1) {
    if (options.cancelled?.()) return { status: 'pending' };
    let state: ProvisioningState;
    try {
      state = await readProvisioningState(options.invoke, options.companyUid);
      lastError = false;
    } catch (error) {
      console.warn('onboarding: provisioning status read failed', error);
      state = { status: 'pending' };
      lastError = true;
    }
    options.onPoll?.(state, attempt);
    if (state.status !== 'pending') return state;
    if (now() >= deadline) return { status: 'failed', step: lastError ? 'status-read' : 'timeout' };
    await sleep(interval);
  }
}

/** The create-company seam over the native commands the app shell also uses. */
export interface PlanLimitRefusal {
  message: string;
  upgradeUrl: string | null;
}

/**
 * Read the `[plan-limit url=…] sentence` tag the native card action puts on a
 * plan-limit refusal (402/403 PLAN_LIMIT_EXCEEDED / plan_limit_reached).
 */
export function planLimitFromCardError(err: unknown): PlanLimitRefusal | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = /^\[plan-limit url=([^\]\s]*)\]\s*(.*)$/s.exec(raw.trim());
  if (!match) return null;
  const url = match[1] ?? '';
  let upgradeUrl: string | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'hq.computer' || parsed.hostname.endsWith('.hq.computer'))) {
      upgradeUrl = parsed.toString();
    }
  } catch {
    upgradeUrl = null;
  }
  return { message: (match[2] ?? '').trim() || 'Your plan limit is reached.', upgradeUrl };
}

export function createFirstRunCompanyApi(
  invoke: InvokeFn,
  hooks: { onPlanLimit?: (refusal: PlanLimitRefusal) => void } = {},
): CreateCompanyApi {
  return {
    runCardAction: async (args) => {
      let raw: Record<string, unknown> | undefined;
      try {
        raw = await invoke<Record<string, unknown> | undefined>('run_card_action', {
          channelId: args.channelId,
          cardId: args.cardId,
          actionId: args.actionId,
          values: args.values,
          idempotencyKey: args.idempotencyKey ?? null,
        });
      } catch (err) {
        const refusal = planLimitFromCardError(err);
        if (refusal) hooks.onPlanLimit?.(refusal);
        throw err;
      }
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

/** Longest handle HQ derives when the server publishes no rule. */
const COMPANY_HANDLE_MAX_LENGTH = 40;

/** Lowercase letters, numbers and single dashes, from a company name. */
export function slugifyCompanyName(name: string, maxLength: number = COMPANY_HANDLE_MAX_LENGTH): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(1, maxLength))
    .replace(/-+$/g, '');
}

function handleWithSuffix(base: string, suffix: string, maxLength: number): string {
  const room = Math.max(1, maxLength - suffix.length);
  return `${base.slice(0, room).replace(/-+$/g, '')}${suffix}`;
}

/**
 * The company handle (slug) HQ uses for a name. People do not type it.
 *
 * `attempt` 0 is the plain slug; each later attempt adds a number
 * (`acme-2`, `acme-3`, …) for a handle that was taken with no server
 * suggestion. When the plain slug breaks the server's published rule (too
 * short, starts with a number), `-hq` / `hq-` are tried so a name like "3M"
 * still gets a handle. Null when the name has no letters or numbers to work
 * with: the form then asks for a different name.
 */
export function deriveCompanyHandle(
  name: string,
  constraints: SlugConstraints | null,
  attempt: number = 0,
): string | null {
  const maxLength = constraints?.maxLength && constraints.maxLength > 0 ? constraints.maxLength : COMPANY_HANDLE_MAX_LENGTH;
  const base = slugifyCompanyName(name, maxLength);
  if (!base) return null;
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  const candidates = [
    suffix ? handleWithSuffix(base, suffix, maxLength) : base,
    handleWithSuffix(base, `-hq${suffix}`, maxLength),
    `hq-${suffix ? handleWithSuffix(base, suffix, maxLength - 3) : base.slice(0, maxLength - 3)}`.replace(/-+$/g, ''),
  ];
  const minLength = constraints?.minLength ?? 0;
  for (const candidate of candidates) {
    if (candidate.length < minLength) continue;
    if (localSlugProblem(candidate, constraints) === null) return candidate;
  }
  return null;
}

/** Shown under the company name when no handle can be made from it. */
export const COMPANY_NAME_NEEDS_LETTERS =
  'Use a name with at least one letter or number (a to z, 0 to 9).';
/** Shown under the company name when the server will not take any handle made from it. */
export const COMPANY_NAME_UNUSABLE = 'HQ could not use that name. Try a different company name.';
