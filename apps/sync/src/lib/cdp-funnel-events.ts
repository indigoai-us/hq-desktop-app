/**
 * Consent-free funnel rows the onboarding wizard sends to hq-pro. The Rust
 * side mirrors each to the VYG CDP under the unprefixed name
 * (`cdp_mirror::OPERATIONAL_MIRRORS`). Counts and closed labels only: never
 * an email, a name, or a raw id.
 */
import type { InviteErrorKind } from './onboarding-invite';

export const DESKTOP_INVITE_SENT = 'desktop_invite_sent';
export const DESKTOP_INVITE_FAILED = 'desktop_invite_failed';
export const DESKTOP_PLAN_SELECTED = 'desktop_plan_selected';

export interface FunnelEvent {
  eventName: string;
  properties: Record<string, string | number>;
}

/** One teammate invitation was sent (or resent) and its email accepted. */
export function inviteSentEvent(): FunnelEvent {
  return { eventName: DESKTOP_INVITE_SENT, properties: { count: 1 } };
}

/** One teammate invitation failed, with the step's closed error kind. */
export function inviteFailedEvent(kind: InviteErrorKind): FunnelEvent {
  return { eventName: DESKTOP_INVITE_FAILED, properties: { count: 1, errorClass: kind } };
}

/** The plan picked on the company step's plan card. */
export function planSelectedEvent(plan: string): FunnelEvent {
  const tier = /^[a-z][a-z0-9_-]{0,31}$/.test(plan) ? plan : 'unknown';
  return { eventName: DESKTOP_PLAN_SELECTED, properties: { plan: tier } };
}
