import { invoke } from '@tauri-apps/api/core';
import { TELEMETRY_CONSENT_VERSION } from './consent-version';
import { cacheOptInAnswer, uploadOptInAnswer } from './onboarding-telemetry';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The usage-data answer in the welcome flow, when it is given BEFORE the
 * install has finished.
 *
 * The opt-in write needs the person entity, and the install is what provisions
 * it. The old wizard asked after setup for exactly that reason. The welcome
 * flow asks while the install runs in the background, so the answer is split:
 *
 *   - `held`     cached on this machine with its provenance, right away. The
 *                person moves on; nothing is sent yet.
 *   - `sending`  the install is ready; the person entity is being confirmed
 *                and the answer posted.
 *   - `sent`     the server confirmed the write.
 *   - `failed`   the server did not confirm it. `offline` means the cached
 *                answer will be reconciled by the consent repair on the next
 *                connection, so the person may finish; `server` asks for a
 *                retry, exactly like the consent step's own failure states.
 *
 * Nothing here ever reports a failed upload as a success.
 */
export type DeferredConsent =
  | { phase: 'held'; enabled: boolean }
  | { phase: 'sending'; enabled: boolean }
  | { phase: 'sent'; enabled: boolean }
  | { phase: 'failed'; enabled: boolean; kind: 'server' | 'offline'; message: string };

export interface DeferredConsentDeps {
  invokeCommand?: InvokeCommand;
}

/**
 * A best-effort guess at whether an upload failure is "you are offline" versus
 * "the server errored". It only changes the copy and whether the person may
 * finish now; either way a failed write is never reported as a success.
 */
export function looksOffline(message: string): boolean {
  return /offline|network|connection|unreachable|timed out|timeout|dns|failed to connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(
    message,
  );
}

/**
 * Whether the welcome flow should hold the answer instead of sending it now.
 * Consent-only runs (the re-prompt, an installed machine missing its answer)
 * never defer: there is no install to wait for, and they close on the answer.
 */
export function shouldDeferConsent(input: {
  consentOnly: boolean;
  installPending: boolean;
}): boolean {
  return !input.consentOnly && input.installPending;
}

/**
 * Cache the answer locally, with provenance, and hold it for later. Returns
 * `null` when the local write failed: with nothing cached there is nothing to
 * send later, so the caller must fall back to the immediate write and its
 * retry-only failure state.
 */
export async function holdConsentAnswer(
  enabled: boolean,
  { invokeCommand = invoke as InvokeCommand }: DeferredConsentDeps = {},
): Promise<DeferredConsent | null> {
  const cached = await cacheOptInAnswer({
    enabled,
    surface: 'onboarding',
    consentVersion: TELEMETRY_CONSENT_VERSION,
    invokeCommand,
  });
  return cached ? { phase: 'held', enabled } : null;
}

/**
 * Send a held answer once the install is ready. The person entity is confirmed
 * first (US-002 AC1), so the POST cannot 404 into the void. The answer was
 * cached when it was held, so a failure here is `offline` or `server` by the
 * same rule the consent step uses for a cached answer.
 */
export async function sendHeldConsent(
  held: DeferredConsent,
  { invokeCommand = invoke as InvokeCommand }: DeferredConsentDeps = {},
): Promise<DeferredConsent> {
  const enabled = held.enabled;
  try {
    await invokeCommand('ensure_person_entity');
  } catch (err) {
    // Same as the consent step: fall through to the POST, whose failure is
    // surfaced below.
    console.warn('[onboarding-consent] ensure_person_entity failed:', err);
  }
  const result = await uploadOptInAnswer({
    enabled,
    surface: 'onboarding',
    consentVersion: TELEMETRY_CONSENT_VERSION,
    invokeCommand,
  });
  if (result.uploaded) return { phase: 'sent', enabled };
  const message = result.error || 'The server did not confirm your choice.';
  return {
    phase: 'failed',
    enabled,
    kind: looksOffline(message) ? 'offline' : 'server',
    message,
  };
}

/** Whether a held answer still stops the person from finishing. */
export function deferredConsentBlocksFinish(state: DeferredConsent | null): boolean {
  if (!state) return false;
  if (state.phase === 'held' || state.phase === 'sending') return true;
  return state.phase === 'failed' && state.kind === 'server';
}

/** How a held answer affects the ready screen's Open HQ Desktop. */
export function deferredConsentGate(state: DeferredConsent | null): 'clear' | 'pending' | 'blocked' {
  if (!state) return 'clear';
  if (state.phase === 'held' || state.phase === 'sending') return 'pending';
  return state.phase === 'failed' && state.kind === 'server' ? 'blocked' : 'clear';
}
