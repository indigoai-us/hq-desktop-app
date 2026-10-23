import { invoke } from '@tauri-apps/api/core';
import { disclosureApplies, getTelemetryNotice, type TelemetryNotice } from './onboarding-telemetry';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Free-plan usage data: the ONE place the desktop app reads "is this a free
 * company" and "did this person opt out earlier". Everything else asks this
 * adapter, so when Platform publishes the final contract only this file moves.
 *
 * Today's contract (from PR 1790 and the existing consent read):
 *   - plan:    `GET /v1/usage/telemetry-notice` via `get_telemetry_notice`.
 *              `hasCard: false` is read as the free plan. ASSUMED: Platform has
 *              not yet confirmed that hasCard is the plan flag.
 *   - opt-out: `get_telemetry_consent_status` (`/v1/telemetry/opt-in`).
 *              `enabled: false` with `unset: false` is a prior opt-out.
 */
export interface FreePlanTelemetryState {
  notice: TelemetryNotice | null;
  freePlan: boolean;
  previouslyOptedOut: boolean;
}

interface ConsentStatus {
  enabled?: boolean;
  unset?: boolean;
}

export async function readFreePlanTelemetry(
  companyUid: string | null | undefined,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<FreePlanTelemetryState> {
  const [notice, consent] = await Promise.all([
    getTelemetryNotice(companyUid, invokeCommand),
    (invokeCommand('get_telemetry_consent_status') as Promise<ConsentStatus | null>).catch((err) => {
      console.warn('[telemetry] consent status read failed; treating as not opted out:', err);
      return null;
    }),
  ]);
  return {
    notice,
    freePlan: notice !== null && notice.hasCard === false,
    previouslyOptedOut: consent?.enabled === false && consent?.unset !== true,
  };
}

const SHOWN_KEY = 'hq.freePlanTelemetryCard.shownVersion';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether the card was already shown for this disclosure version on this machine. */
export function requiredCardAlreadyShown(version: string): boolean {
  return storage()?.getItem(SHOWN_KEY) === version;
}

/**
 * Record that the card was shown. Written when the card is DISPLAYED, so
 * closing the window without answering does not bring it back next launch.
 * Returns whether the guard persisted; without it the caller must not show the
 * card, or it would nag every launch.
 */
export function markRequiredCardShown(version: string): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(SHOWN_KEY, version);
    return s.getItem(SHOWN_KEY) === version;
  } catch {
    return false;
  }
}

/**
 * The launch-time card applies once: free company, person opted out earlier,
 * server says the notice applies (not yet acknowledged), and not already shown
 * for this disclosure version. A paid company never gets it.
 */
export function shouldShowRequiredCard(state: FreePlanTelemetryState): boolean {
  if (!state.freePlan || !state.previouslyOptedOut) return false;
  if (!disclosureApplies(state.notice)) return false;
  return !requiredCardAlreadyShown(state.notice.disclosure.version);
}
