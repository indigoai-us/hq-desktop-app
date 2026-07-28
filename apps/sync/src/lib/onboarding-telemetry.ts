import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const POST_OPT_IN_COMMAND = 'post_telemetry_opt_in';
const WRITE_PREF_COMMAND = 'write_menubar_telemetry_pref';

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
  let cached = false;
  try {
    // The local cache holds only the answer itself — provenance (surface,
    // consent version) is server-side metadata, so it is not written here. It
    // still runs FIRST and best-effort: it is what stamps the answer with the
    // account that gave it and lets an offline person finish setup.
    await invokeCommand(WRITE_PREF_COMMAND, { enabled });
    cached = true;
  } catch (err) {
    console.error('[telemetry] write_menubar_telemetry_pref failed:', err);
  }

  try {
    const args: Record<string, unknown> = { enabled };
    if (surface !== undefined) args.surface = surface;
    if (consentVersion !== undefined) args.consentVersion = consentVersion;
    await invokeCommand(POST_OPT_IN_COMMAND, args);
    return { cached, uploaded: true };
  } catch (err) {
    // Do NOT swallow: the caller must learn the write did not reach the server
    // so it can show a retry (or, when offline, let the person finish anyway
    // knowing the cached answer will be reconciled later).
    return { cached, uploaded: false, error: errorText(err) };
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
