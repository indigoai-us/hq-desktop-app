import { describe, expect, it } from 'vitest';
import { routeForNotificationPayload } from './notificationRoutes';

describe('routeForNotificationPayload', () => {
  it('maps a DM payload to inbox:dm:<fromPersonUid>', () => {
    expect(
      routeForNotificationPayload({
        fromPersonUid: 'prs_ada',
        eventId: 'evt_dm_1',
      }),
    ).toBe('inbox:dm:prs_ada');
  });

  it('maps a channel-origin event to inbox:channel:<channelId>:<eventId>', () => {
    expect(
      routeForNotificationPayload({
        channelId: 'chn_eng',
        eventId: 'evt_root',
        fromPersonUid: 'prs_ada',
      }),
    ).toBe('inbox:channel:chn_eng:evt_root');
  });

  it('maps a channel-origin event without eventId to inbox:channel:<channelId>', () => {
    expect(
      routeForNotificationPayload({ channelId: 'chn_eng' }),
    ).toBe('inbox:channel:chn_eng');
  });

  it('maps a share event to inbox:dm:<issuerUid>', () => {
    expect(
      routeForNotificationPayload({
        issuerUid: 'prs_izzy',
        eventId: 'evt_share_1',
      }),
    ).toBe('inbox:dm:prs_izzy');
  });

  it('accepts issuerPersonUid as the share issuer id', () => {
    expect(
      routeForNotificationPayload({
        issuerPersonUid: 'prs_maya',
        paths: ['indigo/skills/a.md'],
      }),
    ).toBe('inbox:dm:prs_maya');
  });

  it('falls back to a bare inbox route when ids are missing', () => {
    expect(routeForNotificationPayload({})).toBe('inbox');
    expect(routeForNotificationPayload(null)).toBe('inbox');
    expect(routeForNotificationPayload(undefined)).toBe('inbox');
    expect(
      routeForNotificationPayload({
        fromPersonUid: '  ',
        issuerUid: '',
        channelId: null,
      }),
    ).toBe('inbox');
  });
});
