/**
 * Account binding for the call window (US-017).
 *
 * US-016 joined with whatever grant the target carried. That is not enough: a
 * grant says *this call admits this device*, it does not say *this device is
 * still the signed-in person's*. Two things have to hold before any protected
 * traffic flows, and keep holding for as long as it does:
 *
 *  1. The canonical HQ person identity (`prs_…`) resolved from the host's own
 *     `whoami` equals the target's `self.personUid`. The Sync adapter has a
 *     documented degrade path that returns the Cognito subject as `personUid`
 *     when the person entity is absent (see `sync-adapter.ts`); that value is
 *     display-only and MUST NOT authorize a call. It is refused here as
 *     `IDENTITY_UNRESOLVED`, which the shell shows as a recoverable
 *     "Confirm your account" with a Retry.
 *
 *  2. The host's auth *generation* is unchanged. Rust publishes
 *     `auth:session-changed` with a monotonic generation on every sign-out,
 *     account switch and credential invalidation. A generation bump
 *     invalidates everything the old account had: an in-flight join whose
 *     grant is still in the air is discarded when it lands (the generation is
 *     re-checked in the callback, not only before the call), the session is
 *     disposed, local tracks stop, and the registry entry is released with
 *     `account-changed`.
 *
 * Company isolation is structural rather than checked here: the call window
 * holds its own `companyUid` from the target and subscribes to nothing
 * company-scoped, so navigating the main window to another company cannot
 * re-attribute this call. `expectedCompanyUid` is carried on the binding so
 * anything downstream can assert against it instead of reading global state.
 */

import type { IdentityApi } from "@hq/platform";

/** The window-scoped event Rust publishes on every auth transition. */
export const AUTH_SESSION_EVENT = "auth:session-changed";

export type AuthSessionStatus =
  | "active"
  | "credentials_absent"
  | "credentials_invalid"
  | "refresh_temporarily_unavailable";

export interface AuthSessionEnvelope {
  accountId: string | null;
  generation: number;
  status: AuthSessionStatus;
  reason: string | null;
}

/** Bounded exactly as Rust bounds it, so a hostile payload cannot grow state. */
const MAX_REASON_CHARS = 200;

function isAuthSessionStatus(value: unknown): value is AuthSessionStatus {
  return (
    value === "active" ||
    value === "credentials_absent" ||
    value === "credentials_invalid" ||
    value === "refresh_temporarily_unavailable"
  );
}

/**
 * Structural parse of the envelope. Mirrors the main window's parser
 * (`HqWorkWorkShell.svelte`) deliberately: the call window must not trust a
 * malformed payload any more than the shell does, and it must not import the
 * shell to find that out.
 */
export function parseAuthSessionEnvelope(
  value: unknown,
): AuthSessionEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const generation = candidate.generation;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !isAuthSessionStatus(candidate.status)
  ) {
    return null;
  }
  const accountId =
    typeof candidate.accountId === "string" && candidate.accountId.trim()
      ? candidate.accountId.trim()
      : null;
  const reason =
    typeof candidate.reason === "string" && candidate.reason.trim()
      ? candidate.reason.trim().slice(0, MAX_REASON_CHARS)
      : null;
  return { accountId, generation, status: candidate.status, reason };
}

export interface AccountBindingChange {
  generation: number;
  status: AuthSessionStatus;
  accountId: string | null;
}

/**
 * The window's account identity, frozen at the generation it bound to.
 *
 * Everything asynchronous in the call window carries the generation it started
 * under and re-checks `isCurrent` when it lands. Nothing "recovers" a stale
 * generation: a call is bound to one account, and a new account is a new call.
 */
export interface AccountBinding {
  readonly generation: number;
  readonly accountId: string | null;
  readonly personUid: string;
  readonly companyUid: string;
  /** False as soon as the account changed; asynchronous work must bail. */
  isCurrent(generation: number): boolean;
  /** True once invalidated. Latches — it never goes back to false. */
  readonly invalidated: boolean;
  /** Feed an `auth:session-changed` envelope. Returns true if it invalidated. */
  accept(envelope: AuthSessionEnvelope): boolean;
  /** Fires at most once, synchronously, on invalidation. */
  onInvalidate(listener: (change: AccountBindingChange) => void): () => void;
}

export interface AccountBindingOptions {
  generation: number;
  accountId?: string | null;
  personUid: string;
  companyUid: string;
}

export function createAccountBinding(
  options: AccountBindingOptions,
): AccountBinding {
  const listeners = new Set<(change: AccountBindingChange) => void>();
  let invalidated = false;

  function invalidate(change: AccountBindingChange): void {
    if (invalidated) return;
    invalidated = true;
    for (const listener of [...listeners]) listener(change);
    listeners.clear();
  }

  const binding: AccountBinding = {
    generation: options.generation,
    accountId: options.accountId ?? null,
    personUid: options.personUid,
    companyUid: options.companyUid,
    isCurrent: (generation) => !invalidated && generation === options.generation,
    get invalidated(): boolean {
      return invalidated;
    },

    accept(envelope: AuthSessionEnvelope): boolean {
      if (invalidated) return true;
      // A replayed or reordered older envelope is not an account change.
      if (envelope.generation < options.generation) return false;
      const sameAccount =
        envelope.accountId === null ||
        binding.accountId === null ||
        envelope.accountId === binding.accountId;
      if (
        envelope.generation === options.generation &&
        envelope.status === "active" &&
        sameAccount
      ) {
        return false;
      }
      // Everything else — a generation bump, a sign-out, an invalidated
      // credential, a different account id — ends this call's authority. A
      // merely unavailable refresh is included on purpose: the window cannot
      // prove the account is still ours, and a call must not outlive that
      // proof.
      invalidate({
        generation: envelope.generation,
        status: envelope.status,
        accountId: envelope.accountId,
      });
      return true;
    },

    onInvalidate(listener): () => void {
      if (invalidated) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return binding;
}

// ---------------------------------------------------------------------------
// Canonical identity resolution
// ---------------------------------------------------------------------------

/**
 * Canonical HQ person uids are `prs_` + an opaque id. A Cognito subject is a
 * UUID and never matches, which is exactly the point: the adapter's degrade
 * path hands back the subject, and this is what refuses it.
 */
export function isCanonicalPersonUid(value: unknown): value is string {
  return typeof value === "string" && /^prs_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export type CallIdentityCode =
  /** No canonical `prs_…` available — display-only subject, or no session. */
  | "IDENTITY_UNRESOLVED"
  /** A canonical identity, but not the one this call's grant was issued to. */
  | "IDENTITY_MISMATCH"
  /** The account changed while we were asking. */
  | "ACCOUNT_CHANGED";

export interface CallIdentityOk {
  ok: true;
  personUid: string;
  generation: number;
}

export interface CallIdentityFailure {
  ok: false;
  code: CallIdentityCode;
  /** True when a Retry can plausibly succeed without re-opening the call. */
  recoverable: boolean;
}

export type CallIdentityResult = CallIdentityOk | CallIdentityFailure;

export interface ResolveCallIdentityInput {
  identity: Pick<IdentityApi, "whoami">;
  expected: { personUid: string; companyUid: string };
  /** The generation the caller is acting under. */
  generation: number;
  /** Optional live binding; re-checked after the await. */
  binding?: Pick<AccountBinding, "isCurrent">;
}

/**
 * Resolve the canonical identity this window is allowed to act as.
 *
 * Ordering matters: the generation is checked again *after* `whoami` resolves,
 * so an account switch that happens while the request is in flight cannot be
 * papered over by a reply describing the account that just went away.
 */
export async function resolveCallIdentity(
  input: ResolveCallIdentityInput,
): Promise<CallIdentityResult> {
  const stale = (): CallIdentityFailure => ({
    ok: false,
    code: "ACCOUNT_CHANGED",
    recoverable: false,
  });
  if (input.binding && !input.binding.isCurrent(input.generation)) {
    return stale();
  }

  let result: Awaited<ReturnType<IdentityApi["whoami"]>>;
  try {
    result = await input.identity.whoami();
  } catch {
    return { ok: false, code: "IDENTITY_UNRESOLVED", recoverable: true };
  }

  if (input.binding && !input.binding.isCurrent(input.generation)) {
    return stale();
  }
  if (!result.ok) {
    return { ok: false, code: "IDENTITY_UNRESOLVED", recoverable: true };
  }

  const personUid = result.value?.personUid;
  if (!isCanonicalPersonUid(personUid)) {
    // Includes the Cognito-subject degrade path: display-only, never
    // authorizing. Recoverable because the person entity may simply not have
    // been provisioned yet when the window opened.
    return { ok: false, code: "IDENTITY_UNRESOLVED", recoverable: true };
  }
  if (!isCanonicalPersonUid(input.expected.personUid)) {
    // The grant itself names a non-canonical self: refuse rather than trust it.
    return { ok: false, code: "IDENTITY_UNRESOLVED", recoverable: false };
  }
  if (personUid !== input.expected.personUid) {
    return { ok: false, code: "IDENTITY_MISMATCH", recoverable: false };
  }
  return { ok: true, personUid, generation: input.generation };
}

/** User-facing copy for a refusal. Content-free: no ids, no account details. */
export function callIdentityMessage(code: CallIdentityCode): string {
  switch (code) {
    case "IDENTITY_UNRESOLVED":
      return "Confirm your account to join this call.";
    case "IDENTITY_MISMATCH":
      return "This call was opened for a different account.";
    case "ACCOUNT_CHANGED":
      return "Your account changed. This call has ended.";
  }
}
