/**
 * Browser session continuation — the renderer's half.
 *
 * Someone signs up on the website, downloads HQ, opens it, and is asked to sign
 * in to the account they created four minutes ago. This module runs the flow
 * that finishes that sign-in instead: it asks the backend whether continuation
 * is on for this installation, drives the native attempt, shows the person who
 * they are about to sign in as, and only then lets the native side write
 * anything to disk.
 *
 * ## No credential ever enters this file
 *
 * The renderer never sees an access token, ID token, refresh token, PKCE
 * verifier, OAuth state, or nonce. Those live in native memory for the life of
 * one attempt. What crosses the bridge into here is a person's own email and
 * display name so the confirmation can say who it is about — nothing that could
 * be replayed anywhere. That is not an accident of the current implementation;
 * it is the reason the confirm/cancel commands take an attempt id and nothing
 * else.
 *
 * ## Everything fails closed
 *
 * A missing config, an unreachable backend, an unparseable body, a config for a
 * protocol this build does not implement, or any error at all from the native
 * side means continuation is off and the ordinary provider buttons are what the
 * person sees. That is the same screen they get today, so "off" is never worse
 * than the status quo — which is exactly why it is the safe default to fall
 * back to on every uncertainty.
 */

/** The protocol version this build implements. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

/** How long a fetched config is trusted before it is fetched again. */
export const CONFIG_CACHE_TTL_MS = 120_000;

/** Most receipts held for a backend that is not answering. */
export const MAX_QUEUED_RECEIPTS = 50;

const QUEUE_STORAGE_KEY = 'hq-sync:desktop-continuation-receipts:v1';

export type ContinuationOutcome =
  | 'started'
  | 'browser_opened'
  | 'callback_received'
  | 'identity_verified'
  | 'cancelled'
  | 'failed';

export type ContinuationErrorKind =
  | 'offline'
  | 'port_in_use'
  | 'browser_open_failed'
  | 'provider_denied'
  | 'state_mismatch'
  | 'invalid_token'
  | 'person_missing'
  | 'expired'
  | 'cancelled'
  | 'persistence_failed'
  | 'unavailable';

export type ContinuationFlow = 'browser_continuation' | 'manual_oauth' | 'signed_handoff';
export type ContinuationVariant = 'control' | 'continuation';
export type ContinuationPlatform = 'mac' | 'windows';

/** The rollout document as the config route returns it. */
export interface ContinuationConfig {
  protocolVersion: number;
  minimumDesktopVersion: string;
  variant: ContinuationVariant;
  rolloutPercent: number;
}

export type DisabledReason =
  | 'unavailable'
  | 'unrecognised'
  | 'control'
  | 'not_in_rollout'
  | 'build_too_old';

export type RolloutDecision =
  | { enabled: true; config: ContinuationConfig }
  | { enabled: false; reason: DisabledReason };

/**
 * The identity a verified continuation is about. Deliberately the smallest set
 * that lets a person recognise their own account.
 */
export interface VerifiedIdentity {
  email: string;
  displayName?: string;
}

/** The native commands this module drives. */
export interface ContinuationBridge {
  /**
   * May this machine start an attempt at all?
   *
   * `null` means yes; a string is the refusal code. This is asked *before* the
   * `started` receipt is written, and that ordering is the entire point. The
   * five refusals — already signed in, just signed out, a login already in
   * flight, an update being applied, not a first launch — are facts about this
   * installation, not outcomes of an attempt. Discovering them after the
   * receipt would mean every ineligible app open emitted a started/failed pair
   * and the funnel this work exists to repair would read as a flood of
   * failures.
   */
  mayStart(): Promise<string | null>;
  /** Begin an attempt. Resolves with the attempt id once the browser is open. */
  start(input: { installAttemptId: string; sessionId: string }): Promise<{ attemptId: string }>;
  /** Wait for the callback, exchange, and server-side verification. */
  awaitIdentity(input: { attemptId: string }): Promise<VerifiedIdentity>;
  /** Persist and activate. Nothing is written before this resolves. */
  confirm(input: { attemptId: string }): Promise<void>;
  /** Discard the pending tokens. Safe to call more than once. */
  cancel(input: { attemptId: string }): Promise<void>;
}

/** One queued telemetry receipt, minted once and replayed byte for byte. */
export interface ContinuationReceipt {
  path: string;
  body: Record<string, string | number>;
}

/** What happened when a receipt was delivered. */
export type DeliveryResult = 'recorded' | 'rejected' | 'retry';

export interface ContinuationDeps {
  bridge: ContinuationBridge;
  /** Fetch the rollout document. Rejecting is fine; it means disabled. */
  fetchConfig(): Promise<unknown>;
  /** Deliver one receipt. `retry` keeps it queued; anything else drops it. */
  deliver(receipt: ContinuationReceipt): Promise<DeliveryResult>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now(): number;
  newId(): string;
  installAttemptId: string;
  appVersion: string;
  platform: ContinuationPlatform;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a config document without trusting any of it.
 *
 * A body that is the wrong shape, announces a protocol this build does not
 * implement, or carries a percentage outside 0–100 is `unrecognised`, never
 * partially applied. Half-understanding a rollout document is how a
 * misconfigured backend turns into a fleet-wide behaviour change.
 */
export function parseContinuationConfig(body: unknown): ContinuationConfig | null {
  if (!isRecord(body)) return null;
  if (body.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) return null;
  if (typeof body.minimumDesktopVersion !== 'string') return null;
  if (body.variant !== 'control' && body.variant !== 'continuation') return null;
  const percent = body.rolloutPercent;
  if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    return null;
  }
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    minimumDesktopVersion: body.minimumDesktopVersion,
    variant: body.variant,
    rolloutPercent: percent,
  };
}

function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const parts = value.trim().split('.');
    if (parts.length !== 3) return null;
    const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    return numbers.some(Number.isNaN) ? null : numbers;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * A stable 0–99 bucket for one installation.
 *
 * FNV-1a over the installation attempt id. It has to be stable across restarts
 * — an installation that flipped arms every launch would make the experiment
 * unreadable and could show the same person two different sign-in screens on
 * consecutive days — and it does not have to be cryptographic, because nothing
 * is protected by which side of the line an install falls on.
 */
export function rolloutBucket(installAttemptId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < installAttemptId.length; index += 1) {
    hash ^= installAttemptId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function decideRollout(
  config: ContinuationConfig | null,
  appVersion: string,
  installAttemptId: string,
): RolloutDecision {
  if (!config) return { enabled: false, reason: 'unrecognised' };
  if (config.variant !== 'continuation') return { enabled: false, reason: 'control' };
  const comparison = compareVersions(appVersion, config.minimumDesktopVersion);
  if (comparison === null) return { enabled: false, reason: 'unrecognised' };
  if (comparison < 0) return { enabled: false, reason: 'build_too_old' };
  if (config.rolloutPercent === 0) return { enabled: false, reason: 'not_in_rollout' };
  if (rolloutBucket(installAttemptId) >= config.rolloutPercent) {
    return { enabled: false, reason: 'not_in_rollout' };
  }
  return { enabled: true, config };
}

/** Fetch and judge the rollout document. Never throws. */
export async function resolveRollout(deps: ContinuationDeps): Promise<RolloutDecision> {
  let body: unknown;
  try {
    body = await deps.fetchConfig();
  } catch {
    // Offline, a 5xx, a captive portal, a corporate proxy serving a login page.
    // None of them is evidence that this installation should run the new flow.
    return { enabled: false, reason: 'unavailable' };
  }
  return decideRollout(parseContinuationConfig(body), deps.appVersion, deps.installAttemptId);
}

/* ------------------------------------------------------------------ */
/* The receipt queue                                                  */
/* ------------------------------------------------------------------ */

interface PersistedQueue {
  version: 1;
  receipts: ContinuationReceipt[];
}

function readQueue(deps: ContinuationDeps): ContinuationReceipt[] {
  try {
    const raw = deps.storage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedQueue;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.receipts)) return [];
    return parsed.receipts.filter(
      (receipt): receipt is ContinuationReceipt =>
        isRecord(receipt) && typeof receipt.path === 'string' && isRecord(receipt.body),
    );
  } catch {
    // A corrupt queue costs us some measurements. Throwing here would cost
    // somebody their sign-in, which is not a trade worth making.
    return [];
  }
}

function writeQueue(deps: ContinuationDeps, receipts: ContinuationReceipt[]): void {
  try {
    const bounded = receipts.slice(-MAX_QUEUED_RECEIPTS);
    const payload: PersistedQueue = { version: 1, receipts: bounded };
    deps.storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota, a locked profile, private browsing. Measurement is best effort.
  }
}

/**
 * Queue a receipt and try to flush.
 *
 * The receipt is persisted BEFORE delivery is attempted, so a crash between the
 * two loses nothing, and its `eventId`/`occurredAt` are minted once here and
 * replayed unchanged on every later attempt. Re-stamping `occurredAt` on retry
 * would write a second row rather than deduplicating against the first — the
 * server's sort key includes the timestamp.
 */
export async function recordReceipt(
  deps: ContinuationDeps,
  receipt: ContinuationReceipt,
): Promise<void> {
  writeQueue(deps, [...readQueue(deps), receipt]);
  await flushReceipts(deps);
}

/**
 * Deliver everything queued, oldest first, and keep whatever could not be
 * delivered. Never throws and never blocks sign-in: a person waiting to use
 * the app must not be held up by a telemetry endpoint having a bad minute.
 */
export async function flushReceipts(deps: ContinuationDeps): Promise<void> {
  const queued = readQueue(deps);
  if (queued.length === 0) return;
  const remaining: ContinuationReceipt[] = [];
  for (const receipt of queued) {
    let result: DeliveryResult;
    try {
      result = await deps.deliver(receipt);
    } catch {
      result = 'retry';
    }
    // 'rejected' means the server refused the receipt's contents. Resending it
    // will fail identically forever, so it is dropped rather than queued for
    // eternity behind receipts that would have succeeded.
    if (result === 'retry') remaining.push(receipt);
  }
  writeQueue(deps, remaining);
}

/** Build one progress receipt. */
export function progressReceipt(
  deps: ContinuationDeps,
  input: {
    sessionId: string;
    outcome: ContinuationOutcome;
    variant: ContinuationVariant;
    flow?: ContinuationFlow;
    errorKind?: ContinuationErrorKind;
    durationMs?: number;
  },
): ContinuationReceipt {
  const body: Record<string, string | number> = {
    installAttemptId: deps.installAttemptId,
    sessionId: input.sessionId,
    eventId: deps.newId(),
    occurredAt: new Date(deps.now()).toISOString(),
    outcome: input.outcome,
    flow: input.flow ?? 'browser_continuation',
    variant: input.variant,
    platform: deps.platform,
    version: deps.appVersion,
  };
  if (input.errorKind !== undefined) body.errorKind = input.errorKind;
  if (input.durationMs !== undefined) body.durationMs = Math.max(0, Math.round(input.durationMs));
  return { path: '/v1/desktop/onboarding/progress', body };
}

/** Build the once-per-installation launch receipt. */
export function launchReceipt(deps: ContinuationDeps): ContinuationReceipt {
  return {
    path: '/v1/desktop/onboarding/launch',
    body: {
      installAttemptId: deps.installAttemptId,
      eventId: deps.newId(),
      occurredAt: new Date(deps.now()).toISOString(),
      platform: deps.platform,
      version: deps.appVersion,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The attempt                                                        */
/* ------------------------------------------------------------------ */

export type ContinuationState =
  | { phase: 'idle' }
  | { phase: 'opening'; attemptId: string; sessionId: string }
  | { phase: 'waiting'; attemptId: string; sessionId: string }
  | { phase: 'confirming'; attemptId: string; sessionId: string; identity: VerifiedIdentity }
  | { phase: 'activated'; identity: VerifiedIdentity }
  | { phase: 'fallback'; errorKind: ContinuationErrorKind };

/** Map a native error to one of the closed error kinds. Never free text. */
export function classifyContinuationError(error: unknown): ContinuationErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '');
  let code: string | undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed) && typeof parsed.code === 'string') code = parsed.code;
  } catch {
    code = undefined;
  }
  if (code === 'OAUTH_PORT_IN_USE') return 'port_in_use';
  if (code === 'OAUTH_PROVIDER_ERROR') return 'provider_denied';
  // Order is precedence, and it is load-bearing. "failed to persist tokens"
  // matches both /persist/ and /token/; classifying it as invalid_token would
  // send whoever reads the number to Cognito when the actual fault is the disk.
  // The more specific cause always comes first.
  if (/cancel/i.test(message)) return 'cancelled';
  if (/state (mismatch|does not match)/i.test(message)) return 'state_mismatch';
  if (/expired|timed out/i.test(message)) return 'expired';
  if (/persist|write to disk|disk/i.test(message)) return 'persistence_failed';
  if (/person/i.test(message)) return 'person_missing';
  if (/token/i.test(message)) return 'invalid_token';
  if (/offline|network|connection|dns/i.test(message)) return 'offline';
  if (/open|browser|shell/i.test(message)) return 'browser_open_failed';
  return 'unavailable';
}

/**
 * Run one continuation attempt up to the confirmation prompt.
 *
 * Stops at `confirming` on purpose. Nothing has been written to disk at that
 * point, and nothing will be until {@link confirmContinuation} is called — the
 * person has to be able to say "that is not my account" and have that mean
 * something. Any failure lands on `fallback`, which is the existing provider
 * buttons.
 */
export async function beginContinuation(
  deps: ContinuationDeps,
  decision: RolloutDecision,
  onState: (state: ContinuationState) => void,
  shouldContinue: () => boolean = () => true,
): Promise<ContinuationState> {
  if (!decision.enabled || !shouldContinue()) {
    // Being switched off is not an error and is not reported as one. No receipt
    // is emitted either: the control arm's whole point is that it behaves
    // exactly as the app does today, and a progress row nobody in the control
    // arm can produce would make the two arms trivially distinguishable in the
    // data for reasons that have nothing to do with the experiment.
    const state: ContinuationState = { phase: 'fallback', errorKind: 'unavailable' };
    onState(state);
    return state;
  }

  // Eligibility is not an outcome. A machine that is already signed in, that
  // just signed out, that is mid-update, that has a login in flight, or that
  // is simply not on its first launch never had an attempt to fail — so it
  // falls back exactly as the disabled arm does, silently and with no receipt.
  // The native side enforces this again at `start`; this call exists so the
  // refusal happens before anything is written down.
  let refusal: string | null;
  try {
    refusal = await deps.bridge.mayStart();
  } catch {
    // Unanswerable is not permission.
    refusal = 'CONTINUATION_REFUSED_UNKNOWN';
  }
  if (refusal !== null || !shouldContinue()) {
    const state: ContinuationState = { phase: 'fallback', errorKind: 'unavailable' };
    onState(state);
    return state;
  }

  const sessionId = deps.newId();
  const startedAt = deps.now();
  const variant: ContinuationVariant = 'continuation';
  await recordReceipt(deps, progressReceipt(deps, { sessionId, outcome: 'started', variant }));

  let attemptId: string;
  try {
    ({ attemptId } = await deps.bridge.start({
      installAttemptId: deps.installAttemptId,
      sessionId,
    }));
  } catch (error) {
    return await fail(deps, sessionId, startedAt, variant, classifyContinuationError(error), onState);
  }

  // A provider click can land while native code is arming the listener. The
  // renderer serializes its explicit OAuth start behind this promise; release
  // the freshly armed attempt before that path starts, rather than allowing a
  // late continuation to steal its loopback port.
  if (!shouldContinue()) {
    try {
      await deps.bridge.cancel({ attemptId });
    } catch {
      // Native may have already ended it; either way explicit OAuth remains
      // the preferred path and this attempt must not wait for an identity.
    }
    return await fail(deps, sessionId, startedAt, variant, 'cancelled', onState);
  }

  onState({ phase: 'opening', attemptId, sessionId });
  await recordReceipt(
    deps,
    progressReceipt(deps, {
      sessionId,
      outcome: 'browser_opened',
      variant,
      durationMs: deps.now() - startedAt,
    }),
  );
  onState({ phase: 'waiting', attemptId, sessionId });

  let identity: VerifiedIdentity;
  try {
    identity = await deps.bridge.awaitIdentity({ attemptId });
  } catch (error) {
    return await fail(deps, sessionId, startedAt, variant, classifyContinuationError(error), onState);
  }

  await recordReceipt(
    deps,
    progressReceipt(deps, {
      sessionId,
      outcome: 'identity_verified',
      variant,
      durationMs: deps.now() - startedAt,
    }),
  );
  const state: ContinuationState = { phase: 'confirming', attemptId, sessionId, identity };
  onState(state);
  return state;
}

async function fail(
  deps: ContinuationDeps,
  sessionId: string,
  startedAt: number,
  variant: ContinuationVariant,
  errorKind: ContinuationErrorKind,
  onState: (state: ContinuationState) => void,
): Promise<ContinuationState> {
  await recordReceipt(
    deps,
    progressReceipt(deps, {
      sessionId,
      outcome: errorKind === 'cancelled' ? 'cancelled' : 'failed',
      variant,
      errorKind,
      durationMs: deps.now() - startedAt,
    }),
  );
  const state: ContinuationState = { phase: 'fallback', errorKind };
  onState(state);
  return state;
}

/**
 * The person pressed **Continue as …**. This is the first moment anything is
 * written to disk.
 *
 * A failure here leaves the UI unauthenticated, which is the honest outcome: if
 * the credentials could not be stored, the person is not signed in, and telling
 * them otherwise would produce an app that forgets them on the next launch.
 */
export async function confirmContinuation(
  deps: ContinuationDeps,
  state: Extract<ContinuationState, { phase: 'confirming' }>,
  onState: (state: ContinuationState) => void,
): Promise<ContinuationState> {
  try {
    await deps.bridge.confirm({ attemptId: state.attemptId });
  } catch (error) {
    const errorKind = classifyContinuationError(error);
    await recordReceipt(
      deps,
      progressReceipt(deps, {
        sessionId: state.sessionId,
        outcome: 'failed',
        variant: 'continuation',
        errorKind,
      }),
    );
    const failed: ContinuationState = { phase: 'fallback', errorKind };
    onState(failed);
    return failed;
  }
  const activated: ContinuationState = { phase: 'activated', identity: state.identity };
  onState(activated);
  return activated;
}

/**
 * **Use another account**, or Cancel.
 *
 * Discards the pending tokens and returns to explicit sign-in. Cancelling is
 * never a failure to report as one — it lands as `cancelled`, which is a
 * different number from `failed` and answers a different question.
 */
export async function cancelContinuation(
  deps: ContinuationDeps,
  state: ContinuationState,
  onState: (next: ContinuationState) => void,
): Promise<void> {
  const attemptId =
    'attemptId' in state && typeof state.attemptId === 'string' ? state.attemptId : undefined;
  const sessionId =
    'sessionId' in state && typeof state.sessionId === 'string' ? state.sessionId : undefined;
  if (attemptId) {
    try {
      await deps.bridge.cancel({ attemptId });
    } catch {
      // The native side may already have ended this attempt — expiry, a newer
      // sign-in. Either way the pending tokens are gone, which is what cancel
      // is for.
    }
  }
  if (sessionId) {
    await recordReceipt(
      deps,
      progressReceipt(deps, {
        sessionId,
        outcome: 'cancelled',
        variant: 'continuation',
        errorKind: 'cancelled',
      }),
    );
  }
  onState({ phase: 'fallback', errorKind: 'cancelled' });
}
