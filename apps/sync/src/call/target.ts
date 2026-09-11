/**
 * The authorized call target — the only thing the call window is allowed to
 * act on, and the only way it learns what call it is in.
 *
 * It arrives through Rust (`calls_take_pending_target` on a cold open, the
 * window-scoped `calls:target` event on a warm one). It is never read from the
 * URL, the query string, `localStorage`, or a global broadcast, and by
 * construction it carries no token, bearer, key or password: the hq-pro bearer
 * stays in the native host and the device signing key is minted in-window.
 */

export interface CallGrantTarget {
  grantId: string;
  expiresAt: number;
  renewAfterMs?: number;
  trafficStopMs?: number;
  controlPollMs?: number;
}

export interface CallSelfTarget {
  personUid: string;
  deviceId: string;
}

export interface CallWindowTarget {
  sessionId: string;
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
  grant: CallGrantTarget;
  self: CallSelfTarget;
  /** US-011 service-evidence receipt, handed straight to `calls.preflight`. */
  evidence: unknown;
}

/** Field names that must never appear in anything handed to this window. */
const CREDENTIAL_FIELDS = [
  "token",
  "credential",
  "credentials",
  "password",
  "secret",
  "authorization",
  "bearer",
  "apikey",
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
      !CREDENTIAL_FIELDS.includes(normalized) && hasNoCredentialFields(nested)
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
  const grant = value.grant;
  const self = value.self;
  return (
    nonEmpty(value.sessionId) &&
    nonEmpty(value.companyUid) &&
    nonEmpty(value.roomId) &&
    nonEmpty(value.callId) &&
    typeof value.epoch === "number" &&
    Number.isFinite(value.epoch) &&
    isRecord(grant) &&
    nonEmpty(grant.grantId) &&
    typeof grant.expiresAt === "number" &&
    isRecord(self) &&
    nonEmpty(self.personUid) &&
    nonEmpty(self.deviceId) &&
    hasNoCredentialFields(value)
  );
}
