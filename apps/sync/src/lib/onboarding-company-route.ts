/**
 * Look before creating: decide what the first-run company step does from what
 * the server already knows about the signed-in person.
 *
 * Inputs (all read defensively; any field may be missing on today's server):
 * - `GET /membership/me` rows: `companyUid`, `status`, `role`, `companyName`,
 *   `companySlug`, `bucketName`, `teamPlanEnabled`, `planTier`, and, once the
 *   server adds them, `billingStatus` / `subscriptionStatus`,
 *   `provisioningStatus`. A top-level `pendingInvites` array is read too.
 * - `GET /membership/pending-by-email` rows: `companyUid`, `invitedBy`,
 *   `invitedAt`, and when present `companyName`, `inviterName`,
 *   `inviterEmail`, `inviteeEmail`, `expiresAt`, `status`.
 *
 * Nothing here renders. The company step and the wizard read the decision.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export interface MembershipCompany {
  companyUid: string;
  name: string;
  slug: string | null;
  role: string | null;
  paid: boolean;
  bucketName: string | null;
  /** Explicit server provisioning status when present, else null (unknown). */
  provisioning: 'pending' | 'ready' | 'failed' | null;
  provisioningFailedStep: string | null;
}

/** A company the website visitor made while signed in as a different person. */
export interface OtherIdentityCompany {
  maskedEmail: string;
  companyName: string | null;
}

export interface CompanyInviteOffer {
  companyUid: string | null;
  slug: string | null;
  name: string;
  inviter: string | null;
  inviteeEmail: string | null;
  expired: boolean;
}

/** Plan tiers hq-pro emits (`free | team | enterprise`); anything but free is paid. */
const PAID_TIERS = new Set(['team', 'enterprise', 'workforce', 'business', 'pro']);
const PAID_BILLING = new Set(['active', 'trialing', 'paid', 'past_due']);

/** Paid or active-subscription company. Absent fields never mean paid. */
export function isPaidMembershipRow(row: Record<string, unknown>): boolean {
  if (row.teamPlanEnabled === true) return true;
  const tier = str(row, 'planTier');
  if (tier && PAID_TIERS.has(tier.toLowerCase())) return true;
  const billing = str(row, 'subscriptionStatus', 'billingStatus');
  if (billing && PAID_BILLING.has(billing.toLowerCase())) return true;
  return row.paid === true || row.hasSubscription === true;
}

/** Active `cmp_*` companies from a `/membership/me` payload; null when unreadable. */
export function activeMembershipCompanies(payload: unknown): MembershipCompany[] | null {
  if (!isRecord(payload)) return null;
  const rows = payload.memberships;
  if (!Array.isArray(rows) || !rows.every(isRecord)) return null;
  const seen = new Set<string>();
  const out: MembershipCompany[] = [];
  for (const row of rows) {
    const uid = str(row, 'companyUid');
    if (!uid || !uid.startsWith('cmp_') || row.status !== 'active' || seen.has(uid)) continue;
    seen.add(uid);
    const slug = str(row, 'companySlug', 'slug');
    out.push({
      companyUid: uid,
      name: str(row, 'companyName', 'name') ?? slug ?? 'your company',
      slug,
      role: str(row, 'role'),
      paid: isPaidMembershipRow(row),
      bucketName: str(row, 'bucketName'),
      provisioning: provisioningField(row),
      provisioningFailedStep: str(row, 'provisioningFailedStep', 'provisioningStep'),
    });
  }
  return out;
}

function provisioningField(row: Record<string, unknown>): MembershipCompany['provisioning'] {
  const value = str(row, 'provisioningStatus');
  return value === 'pending' || value === 'ready' || value === 'failed' ? value : null;
}

/** `c•••@acme.com`. Already-masked input passes through. */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  if (trimmed.includes('•')) return trimmed;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${trimmed[0]}•••${trimmed.slice(at)}`;
}

/**
 * Read the anonId lookup answer (`GET /membership/me?anonId=…`). The server
 * lane names this block; accept `webIdentity` / `visitorIdentity` /
 * `anonIdentity`. Only a company under a DIFFERENT person counts.
 */
export function otherIdentityFromLookup(payload: unknown, signedInEmail: string | null): OtherIdentityCompany | null {
  if (!isRecord(payload)) return null;
  const block = [payload.webIdentity, payload.visitorIdentity, payload.anonIdentity].find(isRecord);
  if (!block) return null;
  if (block.samePerson === true || block.differentPerson === false) return null;
  const hasCompany =
    block.companyExists === true ||
    block.hasCompany === true ||
    typeof block.companyName === 'string' ||
    typeof block.companyUid === 'string';
  if (!hasCompany) return null;
  const email = str(block, 'maskedEmail', 'email');
  if (!email) return null;
  if (signedInEmail && !email.includes('•') && email.toLowerCase() === signedInEmail.toLowerCase()) return null;
  return { maskedEmail: maskEmail(email), companyName: str(block, 'companyName') };
}

function isExpired(row: Record<string, unknown>, now: number): boolean {
  const status = str(row, 'status', 'inviteStatus');
  if (status && status.toLowerCase() === 'expired') return true;
  if (row.expired === true) return true;
  const expiresAt = str(row, 'expiresAt');
  if (expiresAt) {
    const at = Date.parse(expiresAt);
    if (Number.isFinite(at) && at <= now) return true;
  }
  return false;
}

/** Pending invites from any of the server shapes, once per company. */
export function inviteOffers(rows: unknown[], now: number = Date.now()): CompanyInviteOffer[] {
  const out: CompanyInviteOffer[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const uid = str(row, 'companyUid');
    const slug = str(row, 'companySlug', 'slug');
    const key = uid ?? slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      companyUid: uid,
      slug,
      name: str(row, 'companyName', 'displayName', 'name') ?? slug ?? 'a team',
      inviter: str(row, 'inviterName', 'invitedByName', 'inviterEmail', 'invitedByEmail'),
      inviteeEmail: str(row, 'inviteeEmail', 'invitedEmail', 'email'),
      expired: isExpired(row, now),
    });
  }
  return out;
}

export type CompanyRouteDecision =
  | 'resume_setup'
  | 'company_other_account'
  | 'paid_existing'
  | 'joined_existing'
  | 'offer_existing'
  | 'join_invite'
  | 'invite_other_email'
  | 'invite_expired'
  | 'create';

export type CompanyRoute =
  /** A company of theirs is mid-provisioning (or failed): resume "Setting up…". */
  | { kind: 'resume'; decision: 'resume_setup'; company: MembershipCompany; state: 'pending' | 'failed'; step: string | null }
  /** No company here, but the website visitor made one under another account. */
  | { kind: 'other-identity'; decision: 'company_other_account'; other: OtherIdentityCompany; signedInEmail: string | null }
  /** Skip the step: a paid company, or a company the person already joined. */
  | { kind: 'skip'; decision: 'paid_existing' | 'joined_existing'; company: MembershipCompany }
  /** "Use <name>" (default) or "Create another". */
  | { kind: 'existing'; decision: 'offer_existing'; company: MembershipCompany; companies: MembershipCompany[] }
  /** Pending invite(s) for this email, or one sent elsewhere, or one that expired. */
  | {
      kind: 'join';
      decision: 'join_invite' | 'invite_other_email' | 'invite_expired';
      invites: CompanyInviteOffer[];
      signedInEmail: string | null;
    }
  | { kind: 'create'; decision: 'create' };

export interface CompanyRouteSummary {
  existingCompanies: number;
  paidCompany: boolean;
  pendingInvites: number;
  decision: CompanyRouteDecision;
}

export function summarizeRoute(
  route: CompanyRoute,
  companies: readonly MembershipCompany[],
  invites: readonly CompanyInviteOffer[],
): CompanyRouteSummary {
  return {
    existingCompanies: companies.length,
    paidCompany: companies.some((company) => company.paid),
    pendingInvites: invites.length,
    decision: route.decision,
  };
}

function sameEmail(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The routing rule.
 * 0. An owned company still provisioning (or failed): resume setup.
 * 1. A paid company: skip, select it.
 * 2. Any company the person joined (not the owner): skip, select it.
 * 3. A company they own: offer "Use <name>" or "Create another".
 * 4. A live invite for this email: "Join <company>".
 * 5. Only invites sent to another address: offer to switch account.
 * 5b. The website visitor's company sits under another account: offer to switch.
 * 6. Only expired invites: ask the inviter to resend.
 * 7. Nothing: create.
 */
export function decideCompanyRoute(input: {
  companies: readonly MembershipCompany[];
  invites: readonly CompanyInviteOffer[];
  signedInEmail: string | null;
  otherIdentity?: OtherIdentityCompany | null;
}): CompanyRoute {
  const { companies, invites, signedInEmail } = input;
  // Never a second company in the flow: an owned company still provisioning resumes.
  const unfinished = companies.find(
    (company) =>
      (company.role === null || company.role === 'owner') &&
      (company.provisioning === 'pending' || company.provisioning === 'failed'),
  );
  if (unfinished) {
    return {
      kind: 'resume',
      decision: 'resume_setup',
      company: unfinished,
      state: unfinished.provisioning === 'failed' ? 'failed' : 'pending',
      step: unfinished.provisioningFailedStep ? provisioningStepLabel(unfinished.provisioningFailedStep) : null,
    };
  }
  const paid = companies.find((company) => company.paid);
  if (paid) return { kind: 'skip', decision: 'paid_existing', company: paid };
  const joined = companies.find((company) => company.role !== null && company.role !== 'owner');
  if (joined) return { kind: 'skip', decision: 'joined_existing', company: joined };
  if (companies.length > 0) {
    return { kind: 'existing', decision: 'offer_existing', company: companies[0]!, companies: [...companies] };
  }
  const forOtherEmail = (invite: CompanyInviteOffer) =>
    invite.inviteeEmail !== null && signedInEmail !== null && !sameEmail(invite.inviteeEmail, signedInEmail);
  const live = invites.filter((invite) => !invite.expired && !forOtherEmail(invite));
  if (live.length > 0) return { kind: 'join', decision: 'join_invite', invites: live, signedInEmail };
  const elsewhere = invites.filter((invite) => !invite.expired && forOtherEmail(invite));
  if (elsewhere.length > 0) {
    return { kind: 'join', decision: 'invite_other_email', invites: elsewhere, signedInEmail };
  }
  const expired = invites.filter((invite) => invite.expired);
  if (input.otherIdentity) {
    return { kind: 'other-identity', decision: 'company_other_account', other: input.otherIdentity, signedInEmail };
  }
  if (expired.length > 0) return { kind: 'join', decision: 'invite_expired', invites: expired, signedInEmail };
  return { kind: 'create', decision: 'create' };
}

export type ProvisioningState =
  | { status: 'pending' }
  | { status: 'ready'; bucketName: string | null }
  | { status: 'failed'; step: string };

/** Short, telemetry-safe provisioning step label (hq-pro `step` values like `kms-create`). */
export function provisioningStepLabel(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const step = raw.trim().toLowerCase();
  return /^[a-z0-9:_-]{1,64}$/.test(step) ? step : 'unknown';
}

/**
 * Read a company entity (`GET /entity/{uid}`) as a provisioning state.
 * Today: `bucketName` set and `status` off "provisioning" means ready. When the
 * server adds `provisioningStatus: pending|ready|failed` (+ `provisioningFailedStep`
 * or `provisioningStep`), that wins.
 */
export function provisioningStateFromEntity(payload: unknown): ProvisioningState {
  const entity = isRecord(payload) && isRecord(payload.entity) ? payload.entity : isRecord(payload) ? payload : null;
  if (!entity) return { status: 'pending' };
  const explicit = str(entity, 'provisioningStatus');
  const bucketName = str(entity, 'bucketName');
  if (explicit === 'failed') {
    return { status: 'failed', step: provisioningStepLabel(entity.provisioningFailedStep ?? entity.provisioningStep) };
  }
  if (explicit === 'ready') return { status: 'ready', bucketName };
  if (explicit === 'pending') return { status: 'pending' };
  if (bucketName && entity.status !== 'provisioning' && entity.deleted !== true) {
    return { status: 'ready', bucketName };
  }
  return { status: 'pending' };
}

/**
 * True when a sync error says the company has no bucket yet:
 * "Entity cmp_X (slug) has no bucket provisioned. Run VLT-2 bucket provisioning first."
 */
export function isMissingBucketMessage(message: unknown): boolean {
  return typeof message === 'string' && /no bucket provisioned/i.test(message);
}

/** The `cmp_*` uid named in a missing-bucket message, if any. */
export function companyUidFromMissingBucket(message: unknown): string | null {
  if (!isMissingBucketMessage(message)) return null;
  const match = /\b(cmp_[A-Za-z0-9]+)\b/.exec(message as string);
  return match ? match[1]! : null;
}
