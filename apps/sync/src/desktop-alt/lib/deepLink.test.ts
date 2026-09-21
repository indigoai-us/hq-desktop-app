import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHqUrl, validateHqUrlBytes } from './deepLink';
import { parseDesktopRoute } from './route';

describe('parseHqUrl', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('maps hq://inbox/dm/<personUid> onto inbox:dm:<personUid>', () => {
    expect(parseHqUrl('hq://inbox/dm/prs_ada')).toBe('inbox:dm:prs_ada');
    expect(parseDesktopRoute(parseHqUrl('hq://inbox/dm/prs_ada')!)).toEqual({
      kind: 'inbox',
      dm: 'prs_ada',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('maps hq://inbox/channel/<id>[/<messageId>] onto inbox:channel:…', () => {
    expect(parseHqUrl('hq://inbox/channel/chn_eng')).toBe(
      'inbox:channel:chn_eng',
    );
    expect(parseHqUrl('hq://inbox/channel/chn_eng/evt_root')).toBe(
      'inbox:channel:chn_eng:evt_root',
    );
    expect(
      parseDesktopRoute(parseHqUrl('hq://inbox/channel/chn_eng/evt_root')!),
    ).toEqual({
      kind: 'inbox',
      channelId: 'chn_eng',
      messageId: 'evt_root',
    });
  });

  it('maps hq://files/<slug>/<path> onto files:<slug>:<path>', () => {
    expect(
      parseHqUrl('hq://files/indigo/companies/indigo/knowledge/foo.md'),
    ).toBe('files:indigo:companies:indigo:knowledge:foo.md');
    expect(
      parseDesktopRoute(
        parseHqUrl('hq://files/indigo/companies/indigo/knowledge/foo.md')!,
      ),
    ).toEqual({
      kind: 'files',
      slug: 'indigo',
      path: 'companies:indigo:knowledge:foo.md',
    });
  });

  it('maps hq://company/<slug>[/<tab>] onto company:<slug>[:<tab>]', () => {
    expect(parseHqUrl('hq://company/indigo')).toBe('company:indigo');
    expect(parseHqUrl('hq://company/indigo/activity')).toBe(
      'company:indigo:activity',
    );
    expect(parseDesktopRoute(parseHqUrl('hq://company/indigo/activity')!)).toEqual(
      {
        kind: 'company',
        slug: 'indigo',
        tab: 'activity',
      },
    );
  });

  it('maps hq://meetings onto meetings', () => {
    expect(parseHqUrl('hq://meetings')).toBe('meetings');
    expect(parseHqUrl('hq://meetings/')).toBe('meetings');
    expect(parseHqUrl('HQ://meetings')).toBe('meetings');
  });

  it('rejects a malformed hq:// URL with a shape-only warning', () => {
    expect(parseHqUrl('hq://not-a-real-target')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('HQ_URL_IGNORE');
    expect(message).toContain('len=');
    expect(message).not.toContain('not-a-real-target');
    expect(message).not.toContain('hq://');
  });

  it('rejects missing ids, extra segments, other schemes, and unsafe bytes', () => {
    expect(parseHqUrl('hq://inbox/dm/')).toBeNull();
    expect(parseHqUrl('hq://inbox/dm')).toBeNull();
    expect(parseHqUrl('hq://inbox/channel')).toBeNull();
    expect(parseHqUrl('hq://files/indigo')).toBeNull();
    expect(parseHqUrl('hq://files/indigo/../etc/passwd')).toBeNull();
    expect(parseHqUrl('hq://company/indigo/activity/extra')).toBeNull();
    expect(parseHqUrl('hq://meetings?next=1')).toBeNull();
    expect(parseHqUrl('https://example.com/inbox/dm/prs_ada')).toBeNull();
    expect(parseHqUrl('hq-desktop://signin')).toBeNull();
    expect(parseHqUrl('hq://inbox/dm/prs ada')).toBeNull();
    expect(parseHqUrl('hq://inbox/dm/"prs"')).toBeNull();
    expect(validateHqUrlBytes('hq://inbox/dm/prs_ada')).toBe(true);
    expect(validateHqUrlBytes('hq://inbox/dm/prs ada')).toBe(false);
    expect(validateHqUrlBytes('hq://inbox/dm/%zz')).toBe(false);
  });
});
