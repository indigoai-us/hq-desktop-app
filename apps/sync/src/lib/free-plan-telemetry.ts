import { invoke } from '@tauri-apps/api/core';
import { getTelemetryNotice, type TelemetryNotice } from './onboarding-telemetry';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Free-plan usage data: the ONE place the desktop app reads "is this a free
 * company", "did this person opt out" and "was the card already shown".
 *
 * Contract (Platform, 2026-10-23):
 *   - plan: `status` from GET /v1/usage/telemetry-notice. `required` and
 *     `notice-pending` mean a free company (card eligible); `opt-out-available`
 *     means paid (keep share/decline); `not-applicable` means show nothing.
 *     `hasCard` is NOT used: it is also false when the server skips the lookup.
 *   - opt-out: `storedOptIn` from GET /v1/usage/opt-in (hq-pro PR 5201, not
 *     live yet). Only `false` counts as an opt-out. `true`, `null` and a
 *     missing field all mean no card.
 *   - shown once: POST /v1/usage/telemetry-notice/seen when the card shows
 *     (first write wins, holds across machines); a notice with `seenAt` is
 *     never shown again. A local guard is kept only as the offline fallback.
 */
export const FREE_PLAN_DISCLOSURE_VERSION = '2026-10-22';

export type PlanKind = 'free' | 'paid' | 'none';

export interface FreePlanTelemetryState {
  notice: TelemetryNotice | null;
  plan: PlanKind;
  /** The person's stored answer was an opt-out (`storedOptIn === false`). */
  previouslyOptedOut: boolean;
}

interface ConsentStatus {
  storedOptIn?: boolean | null;
}

export function planFromNotice(notice: TelemetryNotice | null): PlanKind {
  switch (notice?.status) {
    case 'required':
    case 'notice-pending':
      return 'free';
    case 'opt-out-available':
      return 'paid';
    default:
      return 'none';
  }
}

export async function readFreePlanTelemetry(
  companyUid: string | null | undefined,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<FreePlanTelemetryState> {
  const [notice, consent] = await Promise.all([
    getTelemetryNotice(companyUid, invokeCommand),
    (invokeCommand('get_telemetry_consent_status') as Promise<ConsentStatus | null>).catch((err) => {
      console.warn('[telemetry] consent status read failed; showing no free-plan card:', err);
      return null;
    }),
  ]);
  return {
    notice,
    plan: planFromNotice(notice),
    previouslyOptedOut: consent?.storedOptIn === false,
  };
}

const LOCAL_GUARD_KEY = 'hq.freePlanTelemetryCard.shownVersion';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Offline fallback only: the card was shown here but the server never heard. */
export function localGuardSet(): boolean {
  return storage()?.getItem(LOCAL_GUARD_KEY) === FREE_PLAN_DISCLOSURE_VERSION;
}

function setLocalGuard(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(LOCAL_GUARD_KEY, FREE_PLAN_DISCLOSURE_VERSION);
    return s.getItem(LOCAL_GUARD_KEY) === FREE_PLAN_DISCLOSURE_VERSION;
  } catch (err) {
    console.warn('[telemetry] free-plan card local guard write failed:', err);
    return false;
  }
}

/**
 * Record that the card was shown: the server stamp first, the local guard as
 * the offline fallback. Returns whether either persisted. Without one the
 * caller must not show the card, or it could nag every launch.
 */
export async function markRequiredCardShown(
  companyUid: string | null | undefined,
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<boolean> {
  try {
    await invokeCommand('post_telemetry_notice_seen', { companyUid: companyUid ?? null });
    return true;
  } catch (err) {
    console.warn('[telemetry] post_telemetry_notice_seen failed; using the local guard:', err);
    return setLocalGuard();
  }
}

/**
 * The launch card applies once: a free company, a stored opt-out, a notice
 * with its disclosure, and no earlier showing (server `seenAt`, or the local
 * offline guard). Paid companies and missing data never get it.
 */
export function shouldShowRequiredCard(state: FreePlanTelemetryState): boolean {
  if (state.plan !== 'free' || !state.previouslyOptedOut) return false;
  const notice = state.notice;
  if (!notice?.disclosure || notice.seenAt) return false;
  return !localGuardSet();
}
