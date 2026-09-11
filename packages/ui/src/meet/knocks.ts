/**
 * Knocks (US-019) — the quiet invitation between a DM and a call.
 *
 * ## Which way round a knock goes (read this before changing anything)
 *
 * The backend (`hq-pro src/meetings/native/knock.service.ts`) models a knock as
 * a request bound to a ROOM the knocker names:
 *
 *   POST /v1/meet-native/knocks { roomId, callId, epoch, target, note }
 *
 * `knock.service.create` validates that binding against the live room/call
 * (`roomAndCall`: current call id, matching epoch, call still open), and for a
 * PRIVATE room additionally requires that `target` already belongs to it.
 * `knock.service.decide(..., "accept")` then mints `admissionGrantId`, and the
 * controller's `view()` only ever discloses it to the knocker:
 *
 *   ...(actor === knock.from && knock.admissionGrantId
 *        ? { admissionCapability: { grantId, expiresAt } } : {})
 *
 * So the direction is:
 *
 *   - The KNOCKER creates (or reuses) their own open room and knocks with that
 *     binding. Knocking "on a person" is therefore: I open a door and ask you
 *     to let me hold it open for us.
 *   - The TARGET accepts. Acceptance is the authorization event: it runs the
 *     membership check for `from`, re-reads room+call, refuses on
 *     CALL_SEALED / STALE_EPOCH / CAPACITY_EXCEEDED, and issues the admission
 *     capability TO THE KNOCKER.
 *   - Everybody ends up in the KNOCKER's room. The knocker joins carrying
 *     `knock {knockId, capabilityId}` (that is the capability the accept
 *     issued); the target joins the same room on its own visibility/membership,
 *     with no capability, because the capability was never theirs.
 *
 * That is why `openCallWindow` gets a knock binding on the SENDER side and a
 * plain binding on the ACCEPTER side. Do not "fix" this by handing the target a
 * capability: the server will not have issued one for them and the admit would
 * be refused.
 *
 * ## Everything else
 *
 * State is authoritative from `GET knocks` / `GET knocks/{id}` — wakes and
 * notifications are hints only, deduped by knockId. Expiry is evaluated from
 * the server's own `expiresAt` against an injected clock, never a local timer.
 * Company isolation is explicit: every request carries `companyUid`, and a
 * generation guard drops answers for a company we already left.
 */

import type { AdapterResult, Json } from "@hq/platform";

/** Mirrors hq-pro `KnockState`. */
export type KnockState =
  | "pending"
  | "accepted"
  | "declined"
  | "deferred"
  | "cancelled"
  | "expired";

export const KNOCK_STATES: readonly KnockState[] = [
  "pending",
  "accepted",
  "declined",
  "deferred",
  "cancelled",
  "expired",
];

/** Mirrors hq-pro `LIMITS.knockTtlMs` / the note cap in `knock.service.create`. */
export const KNOCK_LIMITS = Object.freeze({
  /** Server-side knock lifetime. Rendered as a countdown, never trusted. */
  ttlMs: 60_000,
  /** `Buffer.byteLength(note) > 512` is refused with INVALID_INPUT. */
  noteMaxBytes: 512,
  listLimit: 50,
});

/** The capability an acceptance issues — disclosed to the KNOCKER only. */
export interface KnockCapability {
  grantId: string;
  expiresAt: number | null;
}

/** One knock, exactly as the server described it. */
export interface Knock {
  knockId: string;
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
  from: string;
  target: string;
  note: string;
  state: KnockState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Present only on our OWN sent knock, only after acceptance. */
  admissionCapability?: KnockCapability;
}

export type KnockDirection = "received" | "sent";

/** Outcome of a `send()`, so the composer can say what actually happened. */
export interface KnockSendOutcome {
  ok: boolean;
  /** A knock row was created for this request. */
  created: boolean;
  /** The same idempotency key / an already-pending knock answered instead. */
  duplicate: boolean;
  /** Server declined to disturb: "dnd" or "pending". */
  suppressed?: "dnd" | "pending";
  /** Whether the server managed to wake the recipient. Hint only. */
  waked: boolean;
  knock?: Knock;
  error?: KnockError;
}

export interface KnockError {
  code: string;
  message: string;
}

/** Human copy for the refusals a knock surface can actually produce. */
export const KNOCK_FRIENDLY: Readonly<Record<string, string>> = {
  COMPANY_ACCESS_DENIED: "You are not allowed to knock there.",
  NOT_FOUND: "That knock no longer exists.",
  STALE_EPOCH: "That call moved on. Refresh and try again.",
  CALL_SEALED: "Room ended.",
  CAPACITY_EXCEEDED: "That room is full.",
  GRANT_EXPIRED: "That invitation expired before you opened the door.",
  REVISION_CONFLICT: "Someone answered this knock first.",
  RATE_LIMITED: "Too many knocks. Wait a minute before knocking again.",
  INVALID_INPUT: "That knock was refused.",
  FEATURE_DISABLED: "Native calls are not enabled for this company.",
  CALLS_UNSUPPORTED_HOST: "Native calls are not available on this host.",
  CALLS_PREFLIGHT_REQUIRED: "Calling is not verified on this device yet.",
  KNOCK_NO_ROOM: "Your room could not be opened, so there was nothing to knock about.",
};

export function knockFailure(result: AdapterResult<unknown>): KnockError {
  const failed = result.ok ? null : result;
  const code = failed?.code ?? "UNKNOWN";
  return {
    code,
    message: KNOCK_FRIENDLY[code] ?? failed?.message ?? "That knock was refused.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCapability(value: unknown): KnockCapability | null {
  if (!isRecord(value)) return null;
  const grantId = str(value.grantId);
  if (!grantId) return null;
  return { grantId, expiresAt: finite(value.expiresAt) };
}

/**
 * Parse one wire knock. An unrecognised state is treated as `expired` rather
 * than `pending`: an unknown state must never render an actionable door.
 */
export function parseKnock(value: unknown): Knock | null {
  if (!isRecord(value)) return null;
  const knockId = str(value.knockId);
  const companyUid = str(value.companyUid);
  const roomId = str(value.roomId);
  const callId = str(value.callId);
  const from = str(value.from);
  const target = str(value.target);
  const epoch = finite(value.epoch);
  const expiresAt = finite(value.expiresAt);
  if (
    !knockId ||
    !companyUid ||
    !roomId ||
    !callId ||
    !from ||
    !target ||
    epoch === null ||
    expiresAt === null
  ) {
    return null;
  }
  const capability = parseCapability(value.admissionCapability);
  const state = KNOCK_STATES.includes(value.state as KnockState)
    ? (value.state as KnockState)
    : "expired";
  return {
    knockId,
    companyUid,
    roomId,
    callId,
    epoch,
    from,
    target,
    note: typeof value.note === "string" ? value.note : "",
    state,
    createdAt: finite(value.createdAt) ?? 0,
    updatedAt: finite(value.updatedAt) ?? 0,
    expiresAt,
    ...(capability ? { admissionCapability: capability } : {}),
  };
}

/** Parse a `GET /knocks` body. Unparseable rows are dropped, not guessed. */
export function parseKnockList(body: Json | unknown): Knock[] {
  const rows = isRecord(body) && Array.isArray(body.knocks) ? body.knocks : [];
  const out: Knock[] = [];
  for (const row of rows) {
    const knock = parseKnock(row);
    if (knock) out.push(knock);
  }
  return out;
}

/**
 * The server already expires on read, but a card rendered past `expiresAt`
 * must stop offering a door. Local expiry never un-expires anything and never
 * overrides a decided state.
 */
export function expireKnock(knock: Knock, now: number): Knock {
  if (knock.state !== "pending" || knock.expiresAt > now) return knock;
  return { ...knock, state: "expired" };
}

/** True when this knock can still be acted on by its recipient. */
export function isKnockActionable(knock: Knock, now: number): boolean {
  return expireKnock(knock, now).state === "pending";
}

/** Seconds left, floored at 0. Rendered as text, never as colour alone. */
export function knockSecondsLeft(knock: Knock, now: number): number {
  return Math.max(0, Math.ceil((knock.expiresAt - now) / 1000));
}

/**
 * Merge a freshly observed knock into a list, keyed by knockId.
 *
 * Dedupe is the whole point: a duplicate wake, a poll and a focus refresh all
 * describe the same door. `revision` is not on the wire view, so `updatedAt`
 * orders two observations of the same id; equal timestamps keep the newest
 * read, which is the one that carries a capability if one was just issued.
 */
export function mergeKnock(list: readonly Knock[], incoming: Knock): Knock[] {
  const index = list.findIndex((entry) => entry.knockId === incoming.knockId);
  if (index === -1) return [...list, incoming];
  const existing = list[index];
  if (incoming.updatedAt < existing.updatedAt) return [...list];
  const next = [...list];
  next[index] = incoming;
  return next;
}

/** Newest first, so the freshest door is the first thing announced. */
export function sortKnocks(list: readonly Knock[]): Knock[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt || a.knockId.localeCompare(b.knockId));
}

/** The note the reply action offers when there is no DM composer to open. */
export function cannedReply(knock: Knock, displayName = (id: string) => id): string {
  return `Got your knock, ${displayName(knock.from)} — give me a few minutes and I will come find you.`;
}

/** UTF-8 byte length, because the server's 512 cap is bytes, not characters. */
export function noteByteLength(note: string): number {
  return new TextEncoder().encode(note).length;
}

export function isNoteTooLong(note: string): boolean {
  return noteByteLength(note) > KNOCK_LIMITS.noteMaxBytes;
}
