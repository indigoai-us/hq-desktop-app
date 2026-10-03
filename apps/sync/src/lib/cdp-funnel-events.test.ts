import { describe, expect, it } from 'vitest';
import {
  DESKTOP_INVITE_FAILED,
  DESKTOP_INVITE_SENT,
  DESKTOP_PLAN_SELECTED,
  inviteFailedEvent,
  inviteSentEvent,
  planSelectedEvent,
} from './cdp-funnel-events';

describe('cdp funnel events', () => {
  it('reports a sent invite as a count only', () => {
    expect(inviteSentEvent()).toEqual({ eventName: DESKTOP_INVITE_SENT, properties: { count: 1 } });
  });

  it('reports a failed invite with its closed error kind', () => {
    expect(inviteFailedEvent('plan_limit')).toEqual({
      eventName: DESKTOP_INVITE_FAILED,
      properties: { count: 1, errorClass: 'plan_limit' },
    });
  });

  it('reports the chosen plan tier and nothing free-form', () => {
    expect(planSelectedEvent('workforce')).toEqual({
      eventName: DESKTOP_PLAN_SELECTED,
      properties: { plan: 'workforce' },
    });
    expect(planSelectedEvent('starter').properties.plan).toBe('starter');
    expect(planSelectedEvent('pat@acme.com').properties.plan).toBe('unknown');
  });
});
