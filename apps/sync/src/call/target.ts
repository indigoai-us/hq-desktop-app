/**
 * The authorized call target — the only thing the call window is allowed to
 * act on, and the only way it learns what call it is in.
 *
 * It arrives through Rust (`calls_take_pending_target` on a cold open, the
 * window-scoped `calls:target` event on a warm one). It is never read from the
 * URL, the query string, `localStorage`, or a global broadcast, and by
 * construction it carries no token, bearer, key or password: the hq-pro bearer
 * stays in the native host and the device signing key is minted in-window.
 *
 * US-018 narrowed it further. The target no longer carries a GRANT: the opener
 * has no device key, so any grant it minted would be bound to a key that is not
 * the one this window signs with. The window admits ITSELF instead — it mints
 * its key, then signs `signalingControl("admit")` with it — so the only grant
 * that ever exists is one the backend issued against this window's own peer
 * key. The target carries just the binding, this device's identity, and (for a
 * private room) the accepted knock capability that authorizes the admit.
 *
 * The service-evidence receipt is gone from the target too: it is bundled at
 * build time (`service-evidence.ts`), so a caller cannot decide what counts as
 * a verified backend.
 */

export interface CallSelfTarget {
  personUid: string;
  deviceId: string;
}

/**
 * An accepted knock, for a private room the caller is not a host of. Both ids
 * are required together — the backend refuses one without the other.
 */
export interface CallKnockTarget {
  knockId: string;
  capabilityId: string;
}

export interface CallWindowTarget {
  sessionId: string;
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
  self: CallSelfTarget;
  /** Present only when admission rides an accepted knock. */
  knock?: CallKnockTarget;
}

/**
 * Credential *stems*. A normalized key (lowercased, `_`/`-` stripped) that
 * CONTAINS one of these is refused, so `access_token`, `refreshToken` and
 * `x-api-key` are caught, not just the bare names. Mirrors
 * `CREDENTIAL_FIELD_STEMS` in `commands/calls.rs`. `sessionId` is deliberately
 * absent: the session id is the registry key and carries no secret.
 */
const CREDENTIAL_FIELD_STEMS = [
  "token",
  "credential",
  "password",
  "secret",
  "authorization",
  "bearer",
  "apikey",
  "privatekey",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive: an evidence receipt is caller JSON, so the check reaches in. */
export function hasNoCredentialFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoCredentialFields);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    return (
      !CREDENTIAL_FIELD_STEMS.some((stem) => normalized.includes(stem)) &&
      hasNoCredentialFields(nested)
    );
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Structural check on a target received from the host. Rust validates first;
 * this is the window's own refusal to run on something malformed (or on
 * anything credential-shaped) rather than trusting the sender.
 */
export function isCallWindowTarget(value: unknown): value is CallWindowTarget {
  if (!isRecord(value)) return false;
  const self = value.self;
  const knock = value.knock;
  // A knock is optional, but a HALF knock is malformed, not "no knock": the
  // window must never silently drop the capability that authorizes its admit.
  const knockOk =
    knock === undefined ||
    knock === null ||
    (isRecord(knock) &&
      nonEmpty(knock.knockId) &&
      nonEmpty(knock.capabilityId));
  return (
    nonEmpty(value.sessionId) &&
    nonEmpty(value.companyUid) &&
    nonEmpty(value.roomId) &&
    nonEmpty(value.callId) &&
    typeof value.epoch === "number" &&
    Number.isFinite(value.epoch) &&
    isRecord(self) &&
    nonEmpty(self.personUid) &&
    nonEmpty(self.deviceId) &&
    knockOk &&
    hasNoCredentialFields(value)
  );
}
