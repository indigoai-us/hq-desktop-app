/**
 * The post-setup "Invite a teammate" step: how a `POST /membership/invite`
 * answer maps to what the person sees and what step telemetry records.
 *
 * hq-pro answers a second invite for the same address with
 * `409 MEMBERSHIP_ALREADY_EXISTS`. That is the expected result on a resumed
 * session, so the step resends the existing invite (`resend: true`) instead
 * of reporting a failure. A resend that finds no pending invite
 * (`404 INVITE_NOT_PENDING`) means the person already joined.
 */

/** A non-2xx hq-pro answer, with the status and the server's error code. */
export class HqProRequestError extends Error {
  readonly status: number;
  /** The body's `code` field when it is a safe label, else null. */
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`hq-pro request failed with status ${status}`);
    this.name = 'HqProRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Read a safe `code` label out of an error body without trusting its shape. */
export function hqProErrorCode(body: unknown): string | null {
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export const INVITE_ERROR_KINDS = [
  'already_member',
  'plan_limit',
  'invalid_email',
  'forbidden',
  'rate_limited',
  'server_error',
  'network',
  'email_delivery_failed',
  'request_failed',
] as const;

export type InviteErrorKind = (typeof INVITE_ERROR_KINDS)[number];

export function normalizeInviteErrorKind(value: unknown): InviteErrorKind {
  return typeof value === 'string' && INVITE_ERROR_KINDS.includes(value as InviteErrorKind)
    ? (value as InviteErrorKind)
    : 'request_failed';
}

/** An HTTP status safe to report: an integer in 100–599, else undefined. */
export function normalizeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export interface InviteFailure {
  kind: InviteErrorKind;
  httpStatus?: number;
}

/** The 409 hq-pro returns when the address already has an invite or a seat. */
export function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof HqProRequestError &&
    error.status === 409 &&
    (error.code === null || error.code === 'MEMBERSHIP_ALREADY_EXISTS')
  );
}

/** The 404 a resend returns when there is no pending invite to resend. */
export function isInviteNotPending(error: unknown): boolean {
  return error instanceof HqProRequestError && error.status === 404 && error.code === 'INVITE_NOT_PENDING';
}

/** Classify a thrown invite error. Never returns the raw server text. */
export function classifyInviteError(error: unknown): InviteFailure {
  if (error instanceof HqProRequestError) {
    const httpStatus = normalizeHttpStatus(error.status);
    const status = error.status;
    let kind: InviteErrorKind;
    if (isInviteNotPending(error) || status === 409) kind = 'already_member';
    else if (status === 402) kind = 'plan_limit';
    else if (status === 400 || status === 422) kind = 'invalid_email';
    else if (status === 401 || status === 403) kind = 'forbidden';
    else if (status === 429) kind = 'rate_limited';
    else if (status >= 500) kind = 'server_error';
    else kind = 'request_failed';
    return httpStatus === undefined ? { kind } : { kind, httpStatus };
  }
  // `hq_pro_fetch` rejects with "Network error: …" / "Not signed in: …" before
  // any status exists.
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/network error|timed out|timeout|connection|offline|dns/i.test(message)) {
    return { kind: 'network' };
  }
  return { kind: 'request_failed' };
}

/** What the step shows for each failure. Plain words, no server text. */
export function inviteErrorMessage(kind: InviteErrorKind): string {
  switch (kind) {
    case 'already_member':
      return 'This person is already a member of your company.';
    case 'plan_limit':
      return 'Your plan has no free seats for another teammate. Upgrade your plan or skip for now.';
    case 'invalid_email':
      return 'HQ could not use that email address. Check it and try again.';
    case 'forbidden':
      return 'Your account cannot invite people to this company. Ask an owner, or skip for now.';
    case 'rate_limited':
      return 'HQ is sending too many invitations right now. Wait a moment and try again.';
    case 'server_error':
      return 'HQ could not send the invitation because the server had a problem. Try again or skip for now.';
    case 'network':
      return 'HQ could not reach the server. Check your connection and try again.';
    case 'email_delivery_failed':
      return 'HQ could not confirm that the invitation email was sent. You can try again or skip for now.';
    case 'request_failed':
      return 'HQ could not send the invitation. You can try again or skip for now.';
  }
}
