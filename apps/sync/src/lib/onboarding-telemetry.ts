import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const POST_OPT_IN_COMMAND = 'post_telemetry_opt_in';
const WRITE_PREF_COMMAND = 'write_menubar_telemetry_pref';
const MARK_REPROMPT_SHOWN_COMMAND = 'mark_consent_reprompt_shown';
const GET_NOTICE_COMMAND = 'get_telemetry_notice';
const POST_DISCLOSURE_ACK_COMMAND = 'post_telemetry_disclosure_ack';

export type TelemetryOptInSurface = 'onboarding' | 'settings';

/**
 * The outcome of recording a telemetry answer.
 *
 * `postOptIn` never throws — a swallowed exception is exactly the failure US-002
 * forbids, because it makes a failed upload indistinguishable from a refusal.
 * Instead the caller is TOLD what happened and decides how to react:
 *
 *   - `cached`   the answer reached the local record (with provenance). This is
 *                what lets the person finish setup offline and have the answer
 *                reconciled later by the consent repair.
 *   - `uploaded` the server confirmed the write. Only then may onboarding treat
 *                the consent step as fully complete.
 *   - `error`    a human-readable reason the upload did not succeed, present
 *                only when `uploaded` is false. Surfaced to the user, never
 *                merely logged.
 */
export interface PostOptInResult {
  cached: boolean;
  uploaded: boolean;
  error?: string;
}

export interface PostOptInOptions {
  enabled: boolean;
  /**
   * Which surface produced this answer. Recorded server-side as provenance so a
   * later self-heal replay can tell a genuine answer from an administrative
   * backfill. Optional for back-compat with callers that predate provenance.
   */
  surface?: TelemetryOptInSurface;
  /**
   * The consent version whose wording was shown when the person answered. Lets
   * the server mark the record stale (and re-ask) once the wording changes.
   */
  consentVersion?: number;
  invokeCommand?: InvokeCommand;
}

/**
 * Cache the telemetry choice locally, then persist it remotely when possible.
 *
 * The local write comes FIRST, deliberately. It is what stamps the answer with
 * the account that gave it (the Cognito subject, read at call time), and the
 * remote POST retries for up to ~15 seconds without being cancelled by a
 * sign-out. Writing after the upload meant a user who answered and then signed
 * out could have their answer stored under the NEXT account's subject — which
 * would later let that account's consent repair replay a choice it never made.
 *
 * It is also the honest order: the local cache exists precisely so the answer
 * survives a failed upload.
 *
 * Unlike the earlier version, the remote outcome is REPORTED rather than
 * swallowed. A failed upload used to be `console.error`'d and then look
 * identical to a successful decline — the caller could not tell "the server
 * refused to record this" from "the person said no". US-002 makes the remote
 * result first-class so onboarding can refuse to advance on failure and offer a
 * retry.
 */
export async function postOptIn({
  enabled,
  surface,
  consentVersion,
  invokeCommand = invoke as InvokeCommand,
}: PostOptInOptions): Promise<PostOptInResult> {
  const cached = await cacheOptInAnswer({ enabled, surface, consentVersion, invokeCommand });
  const upload = await uploadOptInAnswer({ enabled, surface, consentVersion, invokeCommand });
  return upload.uploaded ? { cached, uploaded: true } : { cached, ...upload };
}

function optInArgs({ enabled, surface, consentVersion }: PostOptInOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { enabled };
  if (surface !== undefined) args.surface = surface;
  if (consentVersion !== undefined) args.consentVersion = consentVersion;
  return args;
}

/**
 * The local half of {@link postOptIn}: cache the answer AND its provenance
 * (surface + consent version) on this machine. Returns whether it landed.
 *
 * Caching the provenance is what lets an OFFLINE self-heal replay restate the
 * same version the person answered against. Without it the replay posts a
 * version-less record that the server reads as stale and re-prompts against the
 * exact wording already answered. It also stamps the answer with the account
 * that gave it, and lets an offline person finish setup.
 *
 * The welcome flow calls this on its own when the person answers before the
 * install has provisioned their person entity: the answer is held here, and
 * {@link uploadOptInAnswer} sends it once the entity exists.
 */
export async function cacheOptInAnswer({
  invokeCommand = invoke as InvokeCommand,
  ...options
}: PostOptInOptions): Promise<boolean> {
  try {
    await invokeCommand(WRITE_PREF_COMMAND, optInArgs(options));
    return true;
  } catch (err) {
    console.error('[telemetry] write_menubar_telemetry_pref failed:', err);
    return false;
  }
}

/**
 * The remote half of {@link postOptIn}. Never throws; a failed upload is
 * REPORTED so the caller can show a retry (or, when offline, let the person
 * finish knowing the cached answer will be reconciled later).
 */
export async function uploadOptInAnswer({
  invokeCommand = invoke as InvokeCommand,
  ...options
}: PostOptInOptions): Promise<{ uploaded: true } | { uploaded: false; error: string }> {
  try {
    await invokeCommand(POST_OPT_IN_COMMAND, optInArgs(options));
    return { uploaded: true };
  } catch (err) {
    return { uploaded: false, error: errorText(err) };
  }
}

/**
 * Record that the US-005 launch-time consent re-prompt has been SHOWN for this
 * person at this consent version, so it is not shown again for the same pair.
 *
 * The guard is written when the prompt is DISPLAYED (armed), not only after the
 * person acts — otherwise closing or crashing after it appears would show it
 * again next launch (finding #8). A DISMISSAL and an ANSWER also call it
 * (idempotent: answering already replaces the stale record with a current one).
 *
 * It never throws — a guard-write failure must not block the user — but it
 * RETURNS whether the guard was persisted, so a caller that armed the prompt on
 * the strength of the guard can react to a write failure instead of silently
 * risking a repeat. The worst case is still only the prompt reappearing on a
 * later launch, never a lost answer.
 */
export async function markConsentRepromptShown(
  consentVersion: number,
  personUid: string,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<boolean> {
  try {
    await invokeCommand(MARK_REPROMPT_SHOWN_COMMAND, { consentVersion, personUid });
    return true;
  } catch (err) {
    console.warn('[telemetry] mark_consent_reprompt_shown failed:', err);
    return false;
  }
}

export type TelemetryNoticeStatus = 'not-applicable' | 'opt-out-available' | 'required' | 'notice-pending';

/** The server-owned disclosure copy. The wizard renders every field verbatim. */
export interface TelemetryDisclosure {
  version: string;
  title: string;
  summary: string;
  collected: string[];
  neverCollected: string[];
  offSwitch: string;
  upgradePath: string;
}

export interface TelemetryNotice {
  status: TelemetryNoticeStatus | string;
  seenAt?: string | null;
  requiredFrom?: string | null;
  ackAt?: string | null;
  hasCard: boolean;
  disclosure?: TelemetryDisclosure | null;
}

/**
 * Read the free-plan usage data disclosure for `companyUid`. Never throws: a
 * failed read returns null and the wizard keeps today's opt-in choice, so this
 * can never block setup.
 */
export async function getTelemetryNotice(
  companyUid: string | null | undefined,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<TelemetryNotice | null> {
  try {
    const notice = (await invokeCommand(GET_NOTICE_COMMAND, { companyUid: companyUid ?? null })) as TelemetryNotice | null;
    if (!notice || typeof notice.status !== 'string') {
      console.warn('[telemetry] get_telemetry_notice returned no notice; keeping the opt-in choice');
      return null;
    }
    return notice;
  } catch (err) {
    console.warn('[telemetry] get_telemetry_notice failed; keeping the opt-in choice:', errorText(err));
    return null;
  }
}

/**
 * True when the free-plan disclosure replaces the opt-in choice: the company
 * has no card, the server says the notice applies, and it sent the copy.
 */
export function disclosureApplies(notice: TelemetryNotice | null): notice is TelemetryNotice & { disclosure: TelemetryDisclosure } {
  if (!notice || notice.hasCard) return false;
  if (notice.status !== 'notice-pending' && notice.status !== 'required') return false;
  return Boolean(notice.disclosure);
}

/**
 * Record that the person read the disclosure and chose Continue. Never throws;
 * the caller moves on only when `acked` is true.
 */
export async function postTelemetryDisclosureAck(
  companyUid: string | null | undefined,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<{ acked: true } | { acked: false; error: string }> {
  try {
    await invokeCommand(POST_DISCLOSURE_ACK_COMMAND, { companyUid: companyUid ?? null });
    return { acked: true };
  } catch (err) {
    return { acked: false, error: errorText(err) };
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
