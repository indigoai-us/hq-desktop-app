import { describe, expect, it } from 'vitest';
import {
  desktopRouteToEmbeddedTarget,
  parseDesktopRoute,
  serializeDesktopRoute,
  type DesktopRoute,
} from './route';

function roundTrip(raw: string): DesktopRoute | null {
  const parsed = parseDesktopRoute(raw);
  if (!parsed || parsed.kind === 'unsupported') return parsed;
  return parseDesktopRoute(serializeDesktopRoute(parsed));
}

describe('desktop route grammar', () => {
  it('keeps a bare inbox route as the inbox panel', () => {
    expect(parseDesktopRoute('inbox')).toEqual({ kind: 'inbox' });
    expect(parseDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(serializeDesktopRoute({ kind: 'inbox' })).toBe('inbox');
    expect(roundTrip('inbox')).toEqual({ kind: 'inbox' });
  });

  it('round-trips inbox:dm:<personUid>', () => {
    const parsed = parseDesktopRoute('inbox:dm:prs_ada');
    expect(parsed).toEqual({ kind: 'inbox', dm: 'prs_ada' });
    expect(serializeDesktopRoute(parsed!)).toBe('inbox:dm:prs_ada');
    expect(roundTrip('inbox/dm/prs_ada')).toEqual({
      kind: 'inbox',
      dm: 'prs_ada',
    });
    expect(desktopRouteToEmbeddedTarget(parsed!)).toEqual({
      kind: 'inbox',
      dm: 'prs_ada',
    });
  });

  it('round-trips inbox:channel:<channelId> and an optional messageId', () => {
    expect(parseDesktopRoute('inbox:channel:chn_eng')).toEqual({
      kind: 'inbox',
      channelId: 'chn_eng',
    });
    expect(serializeDesktopRoute({ kind: 'inbox', channelId: 'chn_eng' })).toBe(
      'inbox:channel:chn_eng',
    );
    const withMessage = parseDesktopRoute('inbox:channel:chn_eng:evt_root');
    expect(withMessage).toEqual({
      kind: 'inbox',
      channelId: 'chn_eng',
      messageId: 'evt_root',
    });
    expect(serializeDesktopRoute(withMessage!)).toBe(
      'inbox:channel:chn_eng:evt_root',
    );
    expect(roundTrip('inbox/channel/chn_eng/evt_root')).toEqual({
      kind: 'inbox',
      channelId: 'chn_eng',
      messageId: 'evt_root',
    });
  });

  it('treats a missing dm or channel id as a bare inbox route', () => {
    expect(parseDesktopRoute('inbox:dm:')).toEqual({ kind: 'inbox' });
    expect(parseDesktopRoute('inbox:dm')).toEqual({ kind: 'inbox' });
    expect(parseDesktopRoute('inbox:channel:')).toEqual({ kind: 'inbox' });
    expect(parseDesktopRoute('inbox:channel')).toEqual({ kind: 'inbox' });
  });

  it('rejects unknown inbox suffixes without throwing', () => {
    expect(parseDesktopRoute('inbox:room:abc')).toEqual({
      kind: 'unsupported',
      route: 'inbox:room:abc',
      reason: 'Unsupported embedded destination',
    });
    expect(parseDesktopRoute('')).toBeNull();
    expect(parseDesktopRoute('   ')).toBeNull();
  });

  it('round-trips files:<slug>:<path> and company:<slug>[:<tab>]', () => {
    const files = parseDesktopRoute(
      'files:indigo:companies:indigo:knowledge:foo.md',
    );
    expect(files).toEqual({
      kind: 'files',
      slug: 'indigo',
      path: 'companies:indigo:knowledge:foo.md',
    });
    expect(serializeDesktopRoute(files!)).toBe(
      'files:indigo:companies:indigo:knowledge:foo.md',
    );
    expect(desktopRouteToEmbeddedTarget(files!)).toEqual({
      kind: 'extra',
      page: 'files',
      param: 'companies:indigo:knowledge:foo.md',
      companyUid: 'indigo',
    });

    const company = parseDesktopRoute('company:indigo');
    expect(company).toEqual({ kind: 'company', slug: 'indigo' });
    expect(serializeDesktopRoute(company!)).toBe('company:indigo');
    const withTab = parseDesktopRoute('company:indigo:activity');
    expect(withTab).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'activity',
    });
    expect(serializeDesktopRoute(withTab!)).toBe('company:indigo:activity');
    expect(desktopRouteToEmbeddedTarget(withTab!)).toEqual({
      kind: 'extra',
      page: 'company',
      param: 'activity',
      companyUid: 'indigo',
    });
    expect(parseDesktopRoute('files:indigo')).toEqual({
      kind: 'unsupported',
      route: 'files:indigo',
      reason: 'Unsupported embedded destination',
    });
    expect(parseDesktopRoute('company:indigo:activity:extra')).toEqual({
      kind: 'unsupported',
      route: 'company:indigo:activity:extra',
      reason: 'Unsupported embedded destination',
    });
  });

  it('still parses the existing top-level destinations', () => {
    expect(parseDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(parseDesktopRoute('meetings')).toEqual({ kind: 'meetings' });
    expect(parseDesktopRoute('settings:updates')).toEqual({
      kind: 'settings',
      section: 'updates',
    });
    expect(parseDesktopRoute('library:installed')).toEqual({
      kind: 'library',
      tab: 'installed',
    });
    expect(serializeDesktopRoute({ kind: 'settings', section: 'general' })).toBe(
      'settings:general',
    );
  });
});
